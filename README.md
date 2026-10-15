# 星际距离 · Interstellar Distance

An interactive 3D star map that places nearby stars at their **real distances** from the Sun,
instead of projecting every star onto a celestial sphere.

![preview](web/_preview.png)

---

## What it does

The core feature is a single toggle that makes the point of the project visible:

| Mode | What it shows |
| --- | --- |
| **True distance** (default) | Every star sits at its real 3D position, so near and far are obvious |
| **Celestial sphere** | Only the direction is kept — every star is pushed onto one sphere |

Other controls:

- **Viewing frame**: galactic coordinates (the galactic plane laid out horizontally) or equatorial coordinates
- **Range slider**: 5 – 50 light years
- **Display options**: distance rings (10/20/30/40/50 ly), reference grid plane, star names, distance lines to the Sun
- **Click any star** to inspect its data: Chinese and English name, constellation, spectral type, distance, apparent magnitude

Camera: drag = rotate, wheel = zoom, right-drag = pan, click = select a star.

---

## Why this project

Two well-made existing tools both lose the thing I care about:

- **`three-starmap`** (npm): takes 8,912 naked-eye stars and projects **all of them onto a sphere of radius exactly 200.0**
  (verified in `tools/verify_three_starmap.py`: min = median = max = 200.0). Only the direction survives — the distance is gone.
- **`d3-celestial`**: its catalogue has right ascension, declination, magnitude and colour index, but **no distance field at all**,
  so it can only draw a flat 2D sky map.

Both projects are still used here as data sources (Chinese star names and constellation lines come from `d3-celestial`),
but the 3D positions come from a catalogue that actually has distances.

---

## Data — no star position is invented or AI-generated

Main source: **HYG Database v4.0** by David Nash ([astronexus/HYG-Database](https://github.com/astronexus/HYG-Database)),
licence **CC BY-SA 4.0**. HYG is a merge of the Hipparcos, Yale Bright Star and Gliese/Jahreiss catalogues.

- 119,626 stars with position, distance, magnitude, colour index, spectral type and **pre-computed x/y/z coordinates** in parsecs
- 10,226 stars with a missing or unreliable distance (`dist >= 100000`, a placeholder) are dropped
  → **109,400 stars** with a usable distance remain
- Star names: 4,870 English / 3,056 Chinese traditional names from `d3-celestial`
- Constellation lines: 88 constellations, from `d3-celestial`

Full provenance, field definitions and processing notes: **[`data/README.md`](data/README.md)**.

### Validation (these numbers match published astronomy)

| Star | HYG distance (light years) | Accepted value |
| --- | --- | --- |
| Proxima Centauri | 4.227 | 4.24 |
| Rigil Kentaurus (α Cen A) | 4.321 | 4.37 |
| Barnard's Star | 5.948 | 5.96 |
| Sirius | 8.601 | 8.60 |
| Procyon | 11.462 | 11.46 |
| Altair | 16.730 | 16.73 |
| Vega | 25.045 | 25.04 |
| Arcturus | 36.717 | 36.7 |

Coordinate self-consistency check: `|catalogue radius − dist|` has a median of 0.00000 pc and a maximum of 0.0386 pc.

### Known limitations

1. **Distance error grows quickly with distance.** Parallax-based distances are good to about 1 % for nearby stars,
   but can be off by tens of percent beyond a few hundred light years (Betelgeuse is quoted anywhere between 400 and 650 ly).
2. This is therefore "all stars with a reliable distance estimate", not "all stars".
3. A few stars have no traditional Chinese name and fall back to a Bayer/Flamsteed or HIP identifier.
4. HYG was last updated in 2024. **Gaia DR3** would give better precision later.

---

## How to build the data

```bash
python tools/gunzip_hyg.py      # hygdata_v40.csv.gz -> hygdata_v40.csv
python tools/build_dataset.py   # -> data/processed/{stars.bin, named_stars.json, stats.json}
```

`build_dataset.py` drops the 10,226 stars without a valid distance and writes:

| Output | Size | Content |
| --- | --- | --- |
| `processed/stars.bin` | 2.09 MB | 109,400 stars × 5 float32 `[x, y, z, mag, ci]`, parsecs |
| `processed/named_stars.json` | 0.95 MB | 3,151 named stars (3,008 with a Chinese name), sorted by distance |
| `processed/stats.json` | 3 KB | statistics and the 20 nearest / 20 brightest checks |

---

## How to run the app

The app loads its data with `fetch()`, so it needs a local web server (opening `index.html` as a file will not work):

```bash
cd web
python -m http.server 8000
# then open http://localhost:8000
```

---

## Project structure

```
project-star-map-3d/
├── web/                  front-end (three.js), runnable demo + screenshots
│   ├── index.html        UI: coordinate frame, distance mode, range, options
│   ├── main.js           scene, star rendering, interaction
│   ├── style.css
│   ├── data/             processed data used by the app
│   └── vendor/           three.js (local copy, so no CDN needed)
├── tools/                data pipeline and verification scripts
│   ├── gunzip_hyg.py     decompress the HYG catalogue
│   ├── build_dataset.py  build stars.bin / named_stars.json / stats.json
│   └── verify_*.py       checks against published values
├── data/
│   ├── raw/              downloaded catalogues and packages (see .gitignore)
│   ├── processed/        build output
│   └── README.md         data provenance, processing, validation, limitations
├── plan.md               project plan and review
└── README.md             this file
```

---

## Team

| Real name | GitHub username | Role |
| --- | --- | --- |
| `[YOUR REAL NAME]` | [@Hnuetronstar](https://github.com/Hnuetronstar) | data pipeline, front-end, documentation |
| `[TEAMMATE]` | `[@username]` | `[role]` |

Class: `[YOUR CLASS]`

---

## Progress

- [x] Chose the direction: real distances instead of a celestial sphere
- [x] Collected and documented the data sources
- [x] Built and validated the data pipeline (109,400 stars, checked against published distances)
- [x] Working 3D viewer with the true-distance / sphere toggle
- [x] Distance slider, coordinate frames, labels, star info panel
- [ ] Feedback from real users
- [ ] Higher-precision distances from Gaia DR3
- [ ] Search for a star by name

See [`plan.md`](plan.md) for the full plan and the reasoning behind it.

---

## Credits and licences

This project would not exist without these:

- **HYG Database** — David Nash / astronexus — [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
  (star positions, distances, magnitudes, colour indices, spectral types)
- **d3-celestial** — Olaf Frohn — BSD-3-Clause (English and Chinese star names, constellation lines)
- **three.js** — MIT (3D rendering)
- **three-starmap** — MIT (used only as a comparison reference)

Data files derived from HYG remain under CC BY-SA 4.0.
