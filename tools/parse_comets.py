#!/usr/bin/env python
"""parse_comets.py — parse the MPC comet orbital element file into JSON.

Input : data/raw/CometElsAll.txt   (MPC "Soft00AllCmt", the complete list, ~2200 comets)
        data/raw/CometEls.txt      (MPC "Soft00Cmt", only recently observed comets)
Output: data/raw/comets-all-parsed.json

The MPC fixed-width layout, as used by Soft00Cmt / Soft00AllCmt:

  designation   epoch of perihelion Tp      q        e        w        N        i      epoch      H     G   name
  CJ95O010      1997 03 29.0286          0.925931 0.994895 130.7308 281.8093  89.7337  20261015  -2.0  4.0  C/1995 O1 (Hale-Bopp)
  0001P         2061 08  1.5919          0.570954 0.968029 112.1630  59.2625 162.1915  20261015   5.5  3.2  1P/Halley

Note the day-of-month can be one OR two digits (" 1.5919") -- a two-digit-only
pattern silently drops about a third of the file, including Halley.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")

PATTERN = re.compile(
    r"^\s*(\S+)\s+"          # packed designation
    r"(\d{4})\s+(\d{1,2})\s+(\d{1,2}\.\d+)\s+"   # Tp: year month day.frac
    r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+"   # q e w N i
    r"(\d{8})\s+"            # epoch of the elements
    r"(-?[\d.]+)\s+([\d.]+)\s+"   # H, G
    r"(.*?)\s*$"             # name / reference
)


def clean_name(raw):
    """The last column holds the comet name followed by a wide gap and the
    reference (e.g. "1P/Halley        MPC191592"). Keep only the name."""
    name = re.split(r"\s{3,}", raw.strip())[0].strip()
    return name or raw.strip()


def parse_file(path):
    rows, skipped = [], 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = PATTERN.match(line.rstrip("\n"))
            if not m:
                if line.strip():
                    skipped += 1
                continue
            desig, ty, tm, td, q, e, w, node, inc, epoch, h, g, name = m.groups()
            rows.append({
                "desig": desig,
                "Tp": "%s-%02d-%07.4f" % (ty, int(tm), float(td)),
                "q": float(q), "e": float(e),
                "w": float(w), "N": float(node), "i": float(inc),
                "epoch": epoch, "H": float(h), "G": float(g),
                "name": clean_name(name),
            })
    return rows, skipped


def main():
    files = ["CometElsAll.txt", "CometEls.txt"]
    all_rows = []
    for name in files:
        path = os.path.join(RAW, name)
        if not os.path.exists(path):
            print("  (missing %s, skipped)" % name)
            continue
        rows, skipped = parse_file(path)
        print("%-20s parsed %5d comets (%d lines skipped)" % (name, len(rows), skipped))
        all_rows.extend(rows)

    # de-duplicate by name, preferring the entry with the newest element epoch
    best = {}
    for r in all_rows:
        key = r["name"]
        if key not in best or r["epoch"] > best[key]["epoch"]:
            best[key] = r
    out = sorted(best.values(), key=lambda r: r["name"])

    dest = os.path.join(RAW, "comets-all-parsed.json")
    json.dump(out, open(dest, "w", encoding="utf-8"), ensure_ascii=False)
    print("wrote %s  (%d unique comets)" % (dest, len(out)))

    for want in ("1P/Halley", "2P/Encke", "67P/", "109P/", "55P/", "1I/", "2I/"):
        hit = next((r for r in out if r["name"].startswith(want)), None)
        if hit:
            a = hit["q"] / (1 - hit["e"]) if hit["e"] < 1 else None
            print("   %-34s e=%.4f q=%.3f  P=%s" % (
                hit["name"][:34], hit["e"], hit["q"],
                "%.2f yr" % (a ** 1.5) if a else "not periodic"))
        else:
            print("   %-34s NOT FOUND" % want)
    return 0


if __name__ == "__main__":
    sys.exit(main())
