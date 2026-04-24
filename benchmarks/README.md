# benchmarks/

Fixtures and per-server baselines consumed by `/check-pipeline` and
`/check-popup` skills.

## Files

- **`popup-points.json`** — 100 curated points inside Dobříš R4
  (`841e309ffffffff`), scenario-labeled. Stable fixture, rarely edited.
- **`pipeline-baseline.<hostname>.json`** — latest pipeline timing + R11
  tile Lden summary for a given server. Overwritten by
  `check-pipeline/run.mjs --write-baseline`; history lives in git.
- **`popup-baseline.<hostname>.json`** — latest 100-point popup results
  for a given server. Overwritten by `check-popup/run.mjs --write-baseline`.

## Naming convention

`<kind>-baseline.<hostname>.json` — one latest baseline per server per skill.
Cross-server timing comparisons are skipped automatically (different CPUs).

## Seeding a new server

First run on a new host: `node .claude/skills/check-{pipeline,popup}/run.mjs
--write-baseline`. Commit the resulting JSON.

## See also

- `docs/validation/berm-d4-dobris.md` — 9 of the popup-points come from this
  physical berm scenario (scenario labels `d4_source` / `behind_berm`).
- `.claude/skills/check-pipeline/SKILL.md`
- `.claude/skills/check-popup/SKILL.md`
