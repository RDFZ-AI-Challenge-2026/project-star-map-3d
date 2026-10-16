#!/usr/bin/env python
"""Build the web dataset for the 3D star map from the HYG v4.1 catalog.

Inputs (data/raw):
  hygdata_v41.csv            - HYG v4.1 (Hipparcos + Yale BSC + Gliese), 119,630 stars
  extracted/.../starnames.json      - d3-celestial Western star names, keyed by HIP
  extracted/.../starnames.cn.json   - d3-celestial Chinese star names, keyed by HIP

Outputs (data/processed):
  stars.bin            Float32 LE, 5 numbers per star: x, y, z (parsec), mag, ci
  named_stars.json     every star that has a name (Western proper and/or Chinese)
  stats.json           counts and sanity-check lists (nearest / brightest)
"""
import json
import os
import struct
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "processed")
D3 = os.path.join(RAW, "extracted", "d3-celestial-0.7.35", "package", "data")
PC_TO_LY = 3.26156
DIST_SENTINEL = 100000.0  # HYG: >=100000 means missing/dubious parallax


def load_hyg():
    for name in ("hygdata_v41.csv", "hygdata_v40.csv", "hygdata_v41.csv.gz", "hygdata_v40.csv.gz"):
        path = os.path.join(RAW, name)
        if os.path.exists(path):
            break
    else:
        raise SystemExit("no HYG csv found in data/raw")
    print(f"reading {os.path.basename(path)}")
    df = pd.read_csv(path, low_memory=False)
    print(f"HYG rows: {len(df):,}  columns: {len(df.columns)}")

    for col in ("dist", "x", "y", "z", "mag", "ci"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    n0 = len(df)
    valid = df["dist"].notna() & (df["dist"] > 0) & (df["dist"] < DIST_SENTINEL)
    df = df[valid].copy()
    print(f"valid distance: {len(df):,}  (dropped {n0 - len(df):,})")

    df["ci"] = df["ci"].fillna(0.65)  # 0.65 = solar-ish white; neutral colour for unknown
    df["dist_ly"] = df["dist"] * PC_TO_LY
    # rarad/decrad are ALREADY in radians in HYG -- do not convert twice.
    ra = pd.to_numeric(df["rarad"], errors="coerce").to_numpy()
    dec = pd.to_numeric(df["decrad"], errors="coerce").to_numpy()
    d = df["dist"].to_numpy()
    x = d * np.cos(dec) * np.cos(ra)
    y = d * np.cos(dec) * np.sin(ra)
    z = d * np.sin(dec)
    df["x2"], df["y2"], df["z2"] = x, y, z
    # Sanity check 1: does the catalog's own x/y/z point lie at radius == dist?
    r_cat = np.sqrt(df["x"] ** 2 + df["y"] ** 2 + df["z"] ** 2).to_numpy()
    err_r = np.abs(r_cat - d)
    # Sanity check 2: do the catalog's x/y/z and our ra/dec/dist recomputation agree?
    err_xyz = np.sqrt((x - df["x"].to_numpy()) ** 2 + (y - df["y"].to_numpy()) ** 2 + (z - df["z"].to_numpy()) ** 2)
    print(f"|r_catalog - dist|: median {np.median(err_r):.5f} pc, max {err_r.max():.4f} pc")
    print(f"|xyz recomputed - xyz catalog|: median {np.median(err_xyz):.5f} pc, max {err_xyz.max():.4f} pc")
    # Use the catalog's published x/y/z (verified consistent above).
    df["x2"], df["y2"], df["z2"] = df["x"], df["y"], df["z"]
    return df


def load_names():
    en = json.load(open(os.path.join(D3, "starnames.json"), encoding="utf-8"))
    cn = json.load(open(os.path.join(D3, "starnames.cn.json"), encoding="utf-8"))
    return en, cn


def main():
    os.makedirs(OUT, exist_ok=True)
    df = load_hyg()
    en, cn = load_names()

    stars = df[["id", "hip", "bf", "bayer", "flam", "con", "proper", "spect",
                "mag", "ci", "dist", "dist_ly", "x2", "y2", "z2", "lum", "var"]].copy()

    # ---- binary point cloud: x, y, z, mag, ci -------------------------------
    arr = np.empty((len(stars), 5), dtype="<f4")
    arr[:, 0] = stars["x2"]
    arr[:, 1] = stars["y2"]
    arr[:, 2] = stars["z2"]
    arr[:, 3] = stars["mag"]
    arr[:, 4] = stars["ci"]
    bin_path = os.path.join(OUT, "stars.bin")
    arr.tofile(bin_path)
    print(f"wrote stars.bin: {os.path.getsize(bin_path)/1048576:.2f} MB ({len(arr):,} stars)")

    # ---- named stars --------------------------------------------------------
    named = []
    for row in stars.itertuples(index=False):
        hip = None if pd.isna(row.hip) else str(int(row.hip))
        e = en.get(hip) if hip else None
        c = cn.get(hip) if hip else None
        name_en = (e or {}).get("name") or ""
        name_zh = (c or {}).get("name") or ""
        proper = "" if pd.isna(row.proper) else str(row.proper)
        if not (name_en or name_zh or proper):
            continue
        named.append({
            "id": int(row.id),
            "hip": hip,
            "proper": proper,
            "zh": name_zh,
            "zh_en": (c or {}).get("en", ""),
            "pinyin": (c or {}).get("pinyin", ""),
            "en": name_en,
            "bf": "" if pd.isna(row.bf) else row.bf,
            "bayer": "" if pd.isna(row.bayer) else row.bayer,
            "flam": "" if pd.isna(row.flam) else row.flam,
            "con": "" if pd.isna(row.con) else row.con,
            "spect": "" if pd.isna(row.spect) else row.spect,
            "mag": round(float(row.mag), 3),
            "ci": round(float(row.ci), 3),
            "dist_pc": round(float(row.dist), 5),
            "dist_ly": round(float(row.dist_ly), 4),
            "x": round(float(row.x2), 5),
            "y": round(float(row.y2), 5),
            "z": round(float(row.z2), 5),
            "lum": None if pd.isna(row.lum) else round(float(row.lum), 5),
            "var": "" if pd.isna(row.var) else str(row.var),
        })
    named.sort(key=lambda s: s["dist_ly"])
    with open(os.path.join(OUT, "named_stars.json"), "w", encoding="utf-8") as f:
        json.dump(named, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote named_stars.json: {len(named):,} named stars "
          f"({sum(1 for s in named if s['zh']):,} with a Chinese name)")

    # ---- nearby subset used by the first version of the web app ------------
    # Coordinates are written in LIGHT YEARS so the front end never has to convert.
    RADIUS_LY = 50.0
    near = stars[stars["dist_ly"] <= RADIUS_LY].sort_values("dist_ly")
    out = []
    for row in near.itertuples(index=False):
        hip = None if pd.isna(row.hip) else str(int(row.hip))
        e = en.get(hip) if hip else None
        c = cn.get(hip) if hip else None
        proper = "" if pd.isna(row.proper) else str(row.proper)
        name = proper or (e or {}).get("name") or (c or {}).get("name") or ""
        out.append({
            "id": int(row.id),
            "hip": hip,
            "name": name,
            "zh": (c or {}).get("name", ""),
            "zh_en": (c or {}).get("en", ""),
            "pinyin": (c or {}).get("pinyin", ""),
            "en": (e or {}).get("name", ""),
            "bf": "" if pd.isna(row.bf) else row.bf,
            "con": "" if pd.isna(row.con) else row.con,
            "spect": "" if pd.isna(row.spect) else row.spect,
            "mag": round(float(row.mag), 3),
            "ci": round(float(row.ci), 3),
            "ly": round(float(row.dist_ly), 4),
            "x": round(float(row.x2) * PC_TO_LY, 5),
            "y": round(float(row.y2) * PC_TO_LY, 5),
            "z": round(float(row.z2) * PC_TO_LY, 5),
            "lum": None if pd.isna(row.lum) else round(float(row.lum), 5),
        })
    near_doc = {
        "meta": {
            "radius_ly": RADIUS_LY,
            "count": len(out),
            "units": "light years, equatorial J2000 (x -> vernal equinox, z -> north celestial pole)",
            "source": "HYG v4.0 (astronexus/HYG-Database) + d3-celestial names",
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
        "stars": out,
    }
    web_data = os.path.join(ROOT, "web", "data")
    os.makedirs(web_data, exist_ok=True)
    with open(os.path.join(web_data, "nearby50.json"), "w", encoding="utf-8") as f:
        json.dump(near_doc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote web/data/nearby50.json: {len(out):,} stars within {RADIUS_LY:g} ly "
          f"({sum(1 for s in out if s['zh']):,} with a Chinese name)")

    # ---- stats / sanity checks ---------------------------------------------
    def top(frame, n=15):
        out = []
        for r in frame.head(n).itertuples(index=False):
            out.append({
                "name": (r.proper if isinstance(r.proper, str) and r.proper else
                         (f"HIP {int(r.hip)}" if not pd.isna(r.hip) else f"HYG {int(r.id)}")),
                "mag": round(float(r.mag), 2),
                "dist_ly": round(float(r.dist_ly), 3),
            })
        return out

    nearest = stars.sort_values("dist_ly").head(20)
    brightest = stars.sort_values("mag").head(20)
    naked = stars[stars["mag"] <= 6.5]
    stats = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "HYG v4.0 (astronexus/HYG-Database, hyg/CURRENT/hygdata_v40.csv.gz), CC BY-SA 4.0; "
                  "star names from d3-celestial (BSD-3-Clause)",
        "counts": {
            "stars_with_distance": int(len(stars)),
            "mag_le_6_5": int(len(naked)),
            "mag_le_8": int((stars["mag"] <= 8).sum()),
            "within_10_ly": int((stars["dist_ly"] <= 10).sum()),
            "within_50_ly": int((stars["dist_ly"] <= 50).sum()),
            "within_100_ly": int((stars["dist_ly"] <= 100).sum()),
            "within_1000_ly": int((stars["dist_ly"] <= 1000).sum()),
            "named": len(named),
        },
        "distance_ly": {
            "min": round(float(stars["dist_ly"].min()), 3),
            "median": round(float(stars["dist_ly"].median()), 1),
            "max": round(float(stars["dist_ly"].max()), 1),
        },
        "nearest_20": top(nearest),
        "brightest_20": top(brightest),
    }
    with open(os.path.join(OUT, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print(json.dumps(stats["counts"], ensure_ascii=False))
    print("nearest:", ", ".join(f"{s['name']} {s['dist_ly']}ly" for s in stats["nearest_20"][:8]))


if __name__ == "__main__":
    sys.exit(main())
