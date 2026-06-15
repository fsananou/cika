# CIKA Credit Score Simulator — Netlify Deploy

Static deployment of the Streamlit app using [stlite](https://github.com/whitphx/stlite),
which runs Streamlit + Python entirely in the browser via Pyodide/WASM.

## Files

- `index.html` — entry point; loads stlite and mounts the app
- `cika_score_app.py` — the Streamlit app (copied from `../cika_score_app.py`)
- `rosca_score_engine.py` — the scoring engine (copied from `../rosca_score_engine.py`)
- `netlify.toml` — Netlify config (no build step; just serves files)

The two `.py` files are **copies**. If you edit the originals in `../`, re-copy them
into this folder before deploying:

```bash
cp ../cika_score_app.py ../rosca_score_engine.py .
```

## Deploy to Netlify

### Option 1 — Drag and drop (fastest)
1. Go to https://app.netlify.com/drop
2. Drag this `netlify_deploy/` folder onto the page
3. Done. Netlify gives you a public URL.

### Option 2 — GitHub-connected
1. Commit this folder to a GitHub repo
2. Netlify → "Add new site" → "Import from Git" → pick the repo
3. Set **base directory** to `netlify_deploy` (or wherever this folder ends up)
4. Build command: empty. Publish directory: `.`

## Local test

```bash
cd netlify_deploy
python3 -m http.server 8000
# then open http://localhost:8000
```

First load takes 20–60s (downloading Python runtime + sklearn/pandas/numpy wheels).
Subsequent loads are cached by the browser.

## Known limits

- First-load size is large (~50 MB). Fine for presentations, not ideal for casual visitors.
- Monte Carlo PD* re-simulation will be slower than native Streamlit (browser CPU only).
- If `scikit-learn` fails to load on Pyodide, the app falls back to skipping AUC/Brier (already handled in the code).
