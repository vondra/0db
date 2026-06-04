# benchmarks/

Fixtures and per-server baselines consumed by `/check-heatmap` and
`/check-popup` skills.

## Files

- **`popup-points.json`** — 115 curated points across Dobříš R4
  (`841e309ffffffff`) and LKPR/Ruzyne R4 (`841e355ffffffff`),
  scenario-labeled. Stable fixture, rarely edited.
- **`heatmap-generation-baseline.<hostname>.json`** — latest heatmap
  generation timing + telemetry summary for a given server. Overwritten by
  `check-heatmap/run.mjs --write-baseline`; history lives in git.
- **`heatmap-generation-baseline.<hostname>.<timestamp>/`** — optional raw
  run directory with logs and metadata from a full heatmap measurement. Useful
  for parser/debug work; the compact JSON baseline is what comparisons read.
- **`popup-baseline.<hostname>.json`** — latest 115-point popup results
  for a given server. Overwritten by `check-popup/run.mjs --write-baseline`.

## Naming convention

`<kind>-baseline.<hostname>.json` — one latest baseline per server per skill.
Cross-server timing comparisons are skipped automatically (different CPUs).

## Seeding a new server

First run on a new host:

```bash
node .claude/skills/check-heatmap/run.mjs --write-baseline
node .claude/skills/check-popup/run.mjs --write-baseline
```

Commit the resulting JSON files.

## See also

- `docs/validation/berm-d4-dobris.md` — 9 of the popup-points come from this
  physical berm scenario (scenario labels `d4_source` / `behind_berm`).
- `.claude/skills/check-heatmap/SKILL.md`
- `.claude/skills/check-popup/SKILL.md`
