One-shot migration scripts for per-hex Arrow files under
`data/prepared/{year}/h3r4/`. Each file name prefixed with the date it
was originally run. Kept in tree for reproducibility (not for re-running
— most assume the schema the data was on at that specific point).

Scripts that run on a schedule or mutate a running dataset live at
`pipeline/` root; this folder is for one-off retrofits.
