# aircraft-extract

Aircraft pipeline — popup-first extraction of ADS-B traces into per-R4
Arrow artifacts ready for the popup compute kernel.

## Stages

```
adsb.lol TAR archives ── Stage 0 (parse + dedup) ──→ flights/<day>.arrow
                                                            │
                                                            ▼
                Stage 1 (DEM AGL classify + segment + filter)
                                                            │
                                                            ▼
                                              segments/<day>.arrow
                                                            │
              ┌─────────────────────────────────────────────┼─────────────────────────────────┐
              ▼                                             ▼                                 ▼
        Stage 2A airborne                              Stage 2B cruise                Stage 2C ground paths
        per (flight, R4)                               per (R8, fl_bin, class,        per (aircraft, contiguous
        List<sub_segments>                               period, is_dep)                ground run)
              │                                             │                                 │
              ▼                                             ▼                                 ▼
        h3r4/<hex>/airborne.arrow                  h3r4/<hex>/cruise.arrow            h3r4/<hex>/ground.arrow
```

All schemas embed `schema_version = SCHEMA_VERSION` in metadata.

## See also

- `engine/noise-compute/SPEC.md` — physics + Doc 29 NPD reference
