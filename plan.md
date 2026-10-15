# Project Plan — 星际距离 (Interstellar Distance)

> **Draft scaffold.** Sections 1–5 are filled in from the material that already exists in this repository
> (`data/README.md`, the code, and the screenshots). Anything marked `[REPLACE: ...]` is a personal
> experience that only you can write — please rewrite those parts in your own words before submitting.
>
> Following the course instructions: the first five sections are the focus. Section 6 is filled in
> because the project is already built; section 7 stays empty until there is real feedback.

---

## 1 Find a direction

**What started it.**
`[REPLACE: describe the real need, interest or experience that started this project — e.g. a lesson,
a documentary, a night of stargazing, a question you could not answer.]`

The technical observation that turned it into a project: almost every "star map" I could find on the web
shows *direction* but throws *distance* away. Two popular tools make this very concrete:

- `three-starmap` projects all 8,912 naked-eye stars onto a sphere of radius exactly 200.0 — every star is
  the same distance from the viewer by construction.
- `d3-celestial` has no distance column in its catalogue at all, so it can only draw a 2D sky.

So the question became: **what does the neighbourhood of the Sun actually look like in three dimensions?**

**How AI helped organise the ideas.**
`[REPLACE: describe honestly what you used AI for — e.g. comparing candidate catalogues, explaining
parallax and the meaning of HYG fields such as dist / ci / absmag, suggesting how to validate coordinates,
reviewing the data pipeline. Note that the positions themselves are never AI-generated.]`

AI was useful for **organising and checking**, not for producing data: every number in this project comes
from a published catalogue, and the checks in `tools/verify_*.py` are there so that I can see for myself
whether the numbers agree with accepted values.

---

## 2 Research

**Catalogues and datasets**

| Source | What it gave me | Link |
| --- | --- | --- |
| HYG Database v4.0 (Nash / astronexus), CC BY-SA 4.0 | 119,626 stars with RA/Dec, distance, magnitude, colour index, spectral type and pre-computed x/y/z in parsecs | https://github.com/astronexus/HYG-Database |
| d3-celestial 0.7.35 (Olaf Frohn), BSD-3-Clause | 4,870 English / 3,056 Chinese traditional star names, 88 constellation lines | https://github.com/ofrohn/d3-celestial |
| three-starmap 0.0.5, MIT | used **only as a comparison reference** — it showed me what "no distance" looks like | https://www.npmjs.com/package/three-starmap |
| Gaia DR3 archive | the next step for higher-precision distances (TAP/ADQL interface) | https://gea.esac.esa.int/archive/ |

**Existing work read**
- Google's Chrome Experiment *100,000 Stars* (https://workshop.chromeexperiments.com/stars/) — its case study
  states that it uses the HYG xyz coordinates, which is strong evidence that HYG is a sound basis.

**What I learned and can use**
- What the HYG fields actually mean: `dist` is in **parsecs** (1 pc = 3.26156 ly), and `dist >= 100000`
  is a placeholder for "parallax missing or unreliable", not a real distance.
- HYG's `rarad` / `decrad` columns are **already in radians** — converting them a second time silently
  produces a wrong sky. I hit this bug and it is documented in `data/README.md`.
- Colour index `ci` (B−V) maps to a believable colour temperature, which is why the stars are coloured blue→red.
- Constellation data without distances can still be reused: the constellation *lines* are only correct on a
  celestial sphere, which is exactly why they are an option and not the default.

---

## 3 Narrow down

The full HYG catalogue is far too much for a first version, and much of it has unreliable distances.

**The reduction:**
- From 119,626 stars to **109,400** by dropping every star whose `dist` is missing or `>= 100000`.
- From "the whole sky" to **a 5–50 light-year adjustable radius**, default 50 ly — where parallax-based
  distances are actually trustworthy.
- From "a star map" to **one specific comparison**: the same stars at their true 3D positions versus the same
  stars pushed onto a celestial sphere. Showing the two states side by side is the whole argument.

**The specific problem:** *existing star maps make it impossible to see how far away the stars are, because
they draw every star at the same distance.*

**Concrete example:** in true-distance mode, Sirius (8.60 ly) sits close to the Sun while Vega (25.04 ly) is
about three times further out and in a different direction; switch to celestial-sphere mode and both land on
the same shell, so the difference disappears. Inside 10 light years there are only **11 stars** — panning
through that tiny neighbourhood is the moment the project is meant to produce.

---

## 4 Propose a solution

**Why it could solve the problem.** The project does not add features to an existing sky map; it keeps the
one variable that other tools remove — distance. With real positions, the range slider and the distance rings
turn "a sky full of dots" into something you can move through, and clicking a star gives its measured distance
rather than an impression.

**Value compared with existing approaches**

| | `three-starmap` | `d3-celestial` | this project |
| --- | --- | --- | --- |
| Real 3D positions | ✗ (all on one sphere) | ✗ (no distance field) | ✓ |
| Chinese star names | ✗ | ✓ | ✓ (reused from d3-celestial) |
| Constellation lines | partial | ✓ | ✓ (optional overlay) |
| Navigable 3D neighbourhood | ✗ | ✗ | ✓ |

**Assumptions — untested, labelled as such:**
1. *That a person looking at the true-distance mode actually perceives the depth better than in sphere mode.*
   This has not been tested with real users yet. On a flat screen, depth is inferred from rotation, rings and
   the distance lines — it is plausible, not proven.
2. That a 50 light-year default is a good balance between "interesting" and "not a fuzzy ball" — chosen by eye,
   not measured.
3. That dropping stars with unreliable distances is acceptable; a user may expect "every star I can see".
   The trade-off is documented and the count is stated in the UI footer.
4. Star sizes and the Sun's size are **not to scale** — only positions are. This is a deliberate, stated choice.

---

## 5 Define a minimal workflow

**The simplest complete workflow that still produces a meaningful result:**

```
public catalogue (HYG v4.0 .csv.gz)
        │  tools/gunzip_hyg.py
        ▼
hygdata_v40.csv
        │  tools/build_dataset.py   (drop dist >= 100000, convert to xyz + mag + ci)
        ▼
data/processed/stars.bin  +  named_stars.json  +  stats.json
        │  served over a local static server
        ▼
web/ (three.js)  →  interactive 3D map  →  a person can see real interstellar distances
```

**What stays in the first version**
- The true-distance / celestial-sphere toggle — the core of the project
- Galactic and equatorial viewing frames
- Range slider (5–50 ly), distance rings, grid plane, star labels, distance lines to the Sun
- Click a star for its measured data (name, constellation, spectral type, distance, magnitude)
- Data validated against published distances before anything is drawn

**What can wait**
- Gaia DR3 for higher precision
- Search by star name
- Proper-motion animation (stars moving over thousands of years)
- VR / first-person travel between stars
- Hosting a public URL

---

## 6 Build it

**What exists now** (see the repository, and screenshots in `web/`):

- `tools/gunzip_hyg.py`, `tools/build_dataset.py` — the pipeline, producing
  `stars.bin` (109,400 × 5 float32, 2.09 MB), `named_stars.json` (3,151 named stars, 3,008 with Chinese names)
  and `stats.json`.
- `tools/verify_three_starmap.py`, `tools/verify_galactic.py` — the checks behind the numbers quoted above.
- `web/` — the application: `index.html` (controls), `main.js` (~27 KB: scene, star rendering, picking,
  labels), `style.css`, a local `vendor/three.js` copy, and the processed data it loads.
- `data/README.md` — provenance, field definitions, processing steps, validation table and limitations.

**Simulated or prepared parts, stated honestly:**
- Star and Sun **sizes are not to scale**; only positions are real.
- Star **colours** are derived from the catalogue's colour index, not measured spectra.
- **Distances are catalogue values**, and their uncertainty grows with distance (see section 7 of `data/README.md`).
- The "celestial sphere" mode is a deliberate **projection**, not a second dataset.
- Constellation lines are drawn in sphere mode, where they are geometrically valid.

---

## 7 Feedback and iteration

*To be added — no real feedback or evidence collected yet.*
