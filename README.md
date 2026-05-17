# Enchanting Simulator Data Sync

This project is a static simulator (`main.html` + `style.css` + JSON data files).
Because the page loads JSON files via `fetch(...)`, run it through a local HTTP server (not `file://`).

## Data model

- Auto-generated from Google Sheet:
  - `enchants.json`
- Generated from manual source files in `data/`:
  - `artifacts.json` from `data/artifacts.source.json`
  - `engravings.json` from `data/engravings.source.json`
  - `awakening-map.json` from `data/awakening-map.source.json`

The sync script keeps generated output deterministic and should be the only way data files are updated.

## Local run

Requirements:

- Node.js 20+

Install, sync data, and start a local server:

```bash
npm install
npm run sync:data
npx serve .
```

Then open the URL shown in the terminal (commonly `http://localhost:3000`) and load `main.html` if it does not open automatically.

Alternative (Python):

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/main.html`.

## Source of truth

- Enchantments are sourced from the public Google Sheet CSV export.
- Artifacts, engravings, and awakening mappings are currently maintained manually in `data/*.source.json`.
- For supplemental/manual updates, use the RealmEye wiki as reference: <https://www.realmeye.com/wiki/enchanting>

## Automation

Monthly auto-sync is configured in GitHub Actions:

- Workflow: `.github/workflows/sync-data.yml`
- Triggers:
  - `workflow_dispatch` (manual run)
  - monthly schedule (`0 4 1 * *`)

The workflow only commits when generated files actually change.

## Manual update flow for supplemental data

1. Update `data/artifacts.source.json`, `data/engravings.source.json`, or `data/awakening-map.source.json`.
2. Run `npm run sync:data`.
3. Review generated JSON diffs.
4. Commit the source + generated changes together.
