# CIKA Credit Score — Static Web App

Pure HTML/JS port of the CIKA credit-score simulator. No Python runtime, no
build step, no server — drop it on any static host.

## What's in this folder

- `index.html` — the entire app: Tailwind (CDN), Alpine.js (CDN), Plotly.js (CDN),
  and the CIKA scoring engine ported from `rosca_score_engine.py`.
- `netlify.toml` — Netlify config.

## What's built so far (Stage 1)

- Single-member scorer with the full 5-pillar formula matching
  `rosca_score_engine.py::compute_score`.
- Live recompute on every input change.
- Three presets (Strong / Average / Risky).
- Score ring, pillar breakdown bars, radar chart.
- Methodology explainer tab.
- Risk flags (prior default, star topology, post-payout default).
- Credit stacking penalty.

## Deploy to Netlify

### Drag-and-drop
1. Go to https://app.netlify.com/drop
2. Drag this folder onto the page.
3. Done.

### Git-based
1. Commit and push.
2. Netlify → Add new site → Import from Git.
3. Base directory: `cika-web`. Build command: (empty). Publish directory: `.`.

## Local test

```bash
cd cika-web
python3 -m http.server 8000
# open http://localhost:8000
```

Should load instantly — no Python wheels, no Pyodide.

## Next stages

- **Stage 2** — population simulator (generate N members, score distribution, default rate).
- **Stage 3** — PD* logistic regression in JS, validation tab.
- **Stage 4** — MC PD*, presets, raw-data export.
