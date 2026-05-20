# aircraft-extract

Aircraft pipeline — popup-first extraction of ADS-B traces into per-R4
Arrow artifacts ready for the popup compute kernel.

## Stages

```
adsb.lol TAR archives ── Stage 0 (parse + dedup) ──→ flights/<day>.arrow
                                                            │
                                                            ▼
                Stage 1 (DEM AGL classify + segment + filter)
                          │                  │
                          ▼                  │
                  segments/<day>.arrow       │
                          │                  ▼
                          │     Stage 1.5 DBSCAN airport discovery
                          │     (synth_airport_{lines,areas}.arrow)
                          │                  │
              ┌───────────┼──────────────────┴────────┐
              ▼           ▼                            ▼
        Stage 2A      Stage 2B                   Stage 2C
        airborne      cruise                     airport ground ops
        per           per (R8, fl_bin,           per (airport_key,
        (flight × R4) class, period,             osm_id, segment_idx,
                      is_dep)                    ops_kind, period, …)
              │           │                            │
              ▼           ▼                            ▼
        airborne.arrow  cruise.arrow         airport_traffic.arrow
```

All schemas embed `schema_version = SCHEMA_VERSION` in metadata.

## See also

- `engine/noise-compute/SPEC.md` — physics + Doc 29 NPD reference
