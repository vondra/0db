One-shot migration scripts for per-hex Arrow files under
`data/prepared/{year}/h3r4/`. Each file name prefixed with the date it
was originally run. Kept in tree for reproducibility (not for re-running
— most assume the schema the data was on at that specific point).

Scripts that run on a schedule or mutate a running dataset live at
`pipeline/` root; this folder is for one-off retrofits.

Every reset + re-enrich cycle ends with the invariant scanner over the
touched bbox — it is the acceptance gate for the repair:

    DATA_YEAR=2026 npx tsx pipeline/audit-enrichment-invariants.ts --bbox S,W,N,E

Exit 0 = clean; non-zero prints a violation table (rule, source, hex,
row, coords). Fix and re-run before calling the data healed.
