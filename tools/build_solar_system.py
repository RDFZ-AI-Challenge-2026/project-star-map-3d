#!/usr/bin/env python
"""Build web/data/solar-system.json — the orbital data the time machine needs.

Three groups of bodies, each with a different source:

  engine  Sun, Moon, 8 planets, Pluto -> positions computed at run time by
          astronomy-engine (VSOP87 + JPL). No elements stored here.
  kepler  dwarf planets / asteroids    -> osculating Keplerian elements from
          d3-celestial's planets.json (epoch 2015-06-27 / 2020-05-31).
  comets  periodic + notable comets    -> MPC "Soft00Cmt" elements
          (q, e, i, node, peri, time of perihelion).

Nothing here is invented: every number comes from one of those catalogues.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D3 = os.path.join(ROOT, "data", "raw", "extracted", "d3-celestial-0.7.35", "package", "data")
OUT = os.path.join(ROOT, "web", "data", "solar-system.json")

# bodies astronomy-engine can place accurately on its own
ENGINE = ["sol", "lun", "mer", "ven", "ter", "mar", "jup", "sat", "ura", "nep", "plu"]

# Chinese names for bodies d3-celestial leaves in English (or writes in traditional
# characters). Source: 国家天文科学数据中心《天文学名词》 nadc.china-vo.org/astrodict
ZH_FIX = {
    "cer": "谷神星",     # d3-celestial ships the traditional form 穀神星
    "hau": "妊神星",
    "mak": "鸟神星",
}

# comets worth showing: the famous ones people have heard of
WANTED_COMETS = [
    "1P/Halley", "2P/Encke", "8P/Tuttle", "9P/Tempel", "10P/Tempel",
    "17P/Holmes", "19P/Borrelly", "21P/Giacobini-Zinner", "22P/Kopff",
    "26P/Grigg-Skjellerup", "45P/Honda", "46P/Wirtanen", "55P/Tempel-Tuttle",
    "67P/Churyumov-Gerasimenko", "81P/Wild", "103P/Hartley", "109P/Swift-Tuttle",
    "C/1995 O1", "C/2020 F3", "C/2023 A3", "C/2017 K2", "C/2019 Y4",
    "1I/", "2I/",
]


def load_planets():
    en = json.load(open(os.path.join(D3, "planets.json"), encoding="utf-8"))
    cn = json.load(open(os.path.join(D3, "planets.cn.json"), encoding="utf-8"))
    return en, cn


def zh_of(cn, key, fallback=""):
    v = cn.get(key)
    if isinstance(v, dict):
        return v.get("zh") or v.get("name") or fallback
    if isinstance(v, str):
        return v
    return fallback


def build():
    en, cn = load_planets()
    bodies = []

    # ---- 行星 / 冥王星 / 太阳 / 月球：位置交给 astronomy-engine ----
    for k in ENGINE:
        if k not in en:
            continue
        b = {
            "id": k,
            "name": en[k].get("name", k),
            "zh": zh_of(cn, k, en[k].get("name", k)),
            "sym": en[k].get("sym", ""),
            "kind": "star" if k == "sol" else ("moon" if k == "lun" else "planet"),
            "elem": "jpl",
            "engine": k,                      # astronomy-engine 的 Body 名
        }
        el = (en[k].get("elements") or [None])[0]
        if el:
            b["elements"] = el               # 也带上根数，便于校验/降级
        bodies.append(b)

    # ---- 矮行星 / 小行星：自己解开普勒方程（瞬时根数） ----
    for k, v in en.items():
        if k in ENGINE:
            continue
        el = (v.get("elements") or [{}])[0]
        if not el or "a" not in el:
            continue
        period = el["a"] ** 1.5 if el.get("e", 0) < 1 else None
        bodies.append({
            "id": k,
            "name": v.get("name", k),
            "zh": ZH_FIX.get(k) or zh_of(cn, k, v.get("name", k)),
            "kind": "dwarf" if k in ("eri", "mak", "hau") else "asteroid",
            "elem": "osc",
            "epoch": el.get("ep", ""),
            "elements": {
                "a": el["a"], "e": el["e"], "i": el["i"],
                "M": el.get("M"), "w": el.get("w"), "N": el.get("N"),
                "n": el.get("n"),
            },
            "period_years": round(period, 3) if period else None,
            "H": v.get("H"),
        })

    # ---- 著名彗星：MPC 根数 ----
    raw = os.path.join(ROOT, "data", "raw", "comets-all-parsed.json")
    if os.path.exists(raw):
        rows = json.load(open(raw, encoding="utf-8"))
        for want in WANTED_COMETS:
            # 优先匹配"名字以目标开头"的，避免 2I/ 匹配到 C/2013 N4 (Borisov)
            exact = [r for r in rows if r["name"].startswith(want)]
            loose = [r for r in rows if want.lower() in r["name"].lower()]
            hit = (exact or loose)
            if not hit:
                continue
            r = hit[0]
            a = r["q"] / (1 - r["e"]) if r["e"] < 1 else None
            bodies.append({
                "id": r["desig"].strip(),
                "name": r["name"][:60],
                "kind": "comet",
                "elem": "comet",
                "Tp": r["Tp"],
                "elements": {
                    "q": r["q"], "e": r["e"], "i": r["i"],
                    "w": r["w"], "N": r["N"],
                },
                "H": r["H"],
                "a": round(a, 4) if a else None,
                "period_years": round(a ** 1.5, 2) if a else None,
            })

    doc = {
        "meta": {
            "note": "Orbital data for the time machine. Positions are computed at run time.",
            "body_count": len(bodies),
            "engine": "planets/Moon/Pluto: astronomy-engine (VSOP87 + JPL) in the browser; "
                      "the JPL elements are also included as a fallback",
            "kepler": "dwarf planets and asteroids: d3-celestial osculating elements",
            "comets": "MPC Soft00AllCmt comet elements (minorplanetcenter.net)",
            "names": "Chinese names from 国家天文科学数据中心《天文学名词》",
            "units": "a,q in AU; i,N,w in degrees; n in degrees/day; Tp as YYYY-MM-DD.frac",
        },
        "bodies": bodies,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(doc, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("wrote", OUT)
    kinds = {}
    for b in bodies:
        kinds[b["kind"]] = kinds.get(b["kind"], 0) + 1
    print("  total bodies:", len(bodies), kinds)
    for b in bodies:
        if b["elem"] == "jpl":
            continue
        p = b.get("period_years")
        print("   %-34s %-8s %s" % (b["name"][:34], b["kind"],
                                    ("P=%.2f 年" % p) if p else "非周期"))



if __name__ == "__main__":
    build()
