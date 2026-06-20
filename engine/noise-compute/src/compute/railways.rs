use crate::*;

/// Memo key for `REACH_CACHE`: `(rail_type, admin ISO, speed bits, pax bits, frt bits)`.
type ReachKey = (u8, [u8; 2], u64, u64, u64);

thread_local! {
    /// Exact-key memo for `rail_reach_m` — see the comment at the call site.
    /// Keyed on raw f64 bits (no quantization semantics to reason about) plus the
    /// admin code (C1's per-region split changes the solved reach). Per-thread keeps
    /// the popup single-threaded-per-request contract.
    static REACH_CACHE: std::cell::RefCell<std::collections::HashMap<ReachKey, f64>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Compute railway noise — grouped by osm_id with geometry.
pub(crate) fn compute_railways(
    receiver: &Receiver,
    railways: &[RailSegment],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    mut traces: Option<&mut TraceCollector>,
) -> (NoisePeriods, Vec<Contributor>) {
    use emission::railway::{self, RailType};
    use std::collections::HashMap;

    struct RailAccum {
        name: String,
        rail_type: RailType,
        rail_type_u8: u8,
        usage_u8: u8,
        first_osm_id: i64,
        min_dist: f64,
        min_d_slant: f64,
        min_ground_g: f64,
        cp_lat: f64,
        cp_lon: f64,
        src_height: f64,
        // Closest-segment metadata (for popup)
        closest_trains_passenger_raw: f64,
        closest_trains_freight_raw: f64,
        closest_trains_passenger_effective: f64,
        closest_trains_freight_effective: f64,
        closest_trains_passenger_source: &'static str,
        closest_trains_freight_source: &'static str,
        closest_source_id: u16,
        closest_maxspeed_posted: u16,
        closest_speed_used: f64,
        closest_speed_source: &'static str,
        closest_service: bool,
        closest_highspeed: bool,
        closest_parallel_divisor: u8,
        // Dominant-segment metadata — highest received-energy segment drives the
        // popup display, mirroring the road pattern. Earlier rail surfaced the
        // closest-segment fields, which misled whenever a busy/fast mainline
        // sat farther than a quiet siding (the siding's 30 km/h and 5 trains/day
        // looked like "the speed used" / "whole-line count" even though the
        // mainline produced ~all the energy). Closest-* fields stay in the
        // accumulator (kept harmless) but no longer feed `RailMetadata`.
        dominant_segment_idx: i16,
        dominant_distance_m: f64,
        dominant_trains_passenger_raw: f64,
        dominant_trains_freight_raw: f64,
        dominant_trains_passenger_effective: f64,
        dominant_trains_freight_effective: f64,
        dominant_trains_passenger_source: &'static str,
        dominant_trains_freight_source: &'static str,
        dominant_source_id: u16,
        dominant_maxspeed_posted: u16,
        dominant_speed_used: f64,
        dominant_speed_source: &'static str,
        dominant_service: bool,
        dominant_highspeed: bool,
        dominant_parallel_divisor: u8,
        // Aggregation
        segment_count: u32,
        total_length_m: f64,
        // Group-level screening obstacle histogram
        obstacle_segment_count: u32,
        obstacle_height_sum: f64,
        obstacle_max_height: f64,
        obstacle_max_segment_idx: i16,
        variants: [PropagationVariants; 3],
        emission_energy: f64,
        line_coords: Vec<[[f64; 2]; 2]>,
        has_bridge: bool,
        dominant_energy: f64,
        dominant_trace_idx: Option<usize>,
    }
    let mut rails_by_key: HashMap<(String, u8), RailAccum> = HashMap::new();

    // Admin resolved once per call — the receiver position is constant across
    // segments. Drives the C1 per-region day/evening/night split (EU freight
    // runs ~55 % at night vs ~33 % world), shared with the heatmap loader + the
    // reach solver via `railway::rail_time_dist` (exact mirror of compute_roads).
    let admin = crate::admin::admin_for_latlng(receiver.lat, receiver.lon);
    let reflection = rasters.building_enclosure(receiver.lat, receiver.lon);

    for seg in railways {
        if seg.tunnel {
            continue;
        }

        let rail_type = RailType::from_u8(seg.rail_type);
        let speed = if seg.speed_kmh > 0.0 {
            seg.speed_kmh
        } else {
            80.0
        };
        let q_pax = seg.trains_passenger.max(0.0);
        let q_frt = seg.trains_freight.max(0.0);
        if q_pax + q_frt <= 0.0 {
            continue;
        }
        // Per-row audibility reach: this segment's own 25 dB Lden crossing,
        // clamped [2 km, 10 km]. The heatmap loader sets the identical value on
        // each `LineRow` from the SAME `rail_reach_m` solver (the popup's
        // `RailSegment.trains_*` are already the effective post-scaling counts),
        // so popup and heatmap cull at the same distance by construction — no
        // blanket constant, no magic-number drift.
        //
        // Memoized per worker thread: segments materialize per QUERY, and the
        // 40-step bisection (~µs) × thousands of in-ceiling segments would
        // re-pay ~5-10 ms on every popup (Codex /gg on 48085647). Effective
        // (type, speed, counts) tuples collapse onto a handful of defaults,
        // so an exact-key cache hits ~99%.
        let reach_m = REACH_CACHE.with(|c| {
            // admin in the key: the per-region split changes the row's Lden, so a
            // CZ corridor and a US corridor with identical (type, speed, counts)
            // can solve to different reaches on the same worker thread.
            let key = (
                seg.rail_type,
                admin.country_iso,
                speed.to_bits(),
                q_pax.to_bits(),
                q_frt.to_bits(),
            );
            *c.borrow_mut()
                .entry(key)
                .or_insert_with(|| railway::rail_reach_m(admin, rail_type, speed, q_pax, q_frt))
        });
        if seg.dist_m > reach_m {
            continue;
        }

        let src_elev = rasters.elevation(seg.cp_lat, seg.cp_lon);
        let src_alt = src_elev + SOURCE_HEIGHT_RAIL;
        let d_slant = geo::slant_dist(seg.dist_m, src_alt, receiver.altitude_m());
        if d_slant < 1.0 {
            continue;
        }

        // C1 per-region, per-category day/evening/night split for THIS segment's
        // type (trams take the urban pax curve; only RailType::Rail in an EU
        // region gets the night-heavy freight share). Same table the heatmap
        // loader + reach solver consume → popup-vs-heatmap parity by construction.
        let td = railway::rail_time_dist(admin, rail_type);
        let periods = td.periods();

        // Early exit: skip only if the LOUDEST period's free-field is below
        // threshold — a true upper bound, so no audible-in-any-period segment is
        // dropped. Pre-C1 the day block was always loudest (flat 65/20/15), but
        // C1's EU freight night share (0.5458 over 8 h) can beat day, so a
        // day-only gate would prune audible quiet/slow night-freight rows that
        // the heatmap (Lden over all periods) keeps — a parity break (Codex /gg).
        {
            let me = periods
                .iter()
                .map(|&(pax_pct, frt_pct, hours)| {
                    railway::railway_emission(
                        rail_type,
                        speed,
                        q_pax * pax_pct,
                        q_frt * frt_pct,
                        hours,
                    )
                    .iter()
                    .cloned()
                    .fold(f64::NEG_INFINITY, f64::max)
                })
                .fold(f64::NEG_INFINITY, f64::max);
            if geo::below_free_field_threshold_line(me, seg.dist_m, 0.0) {
                continue;
            }
        }

        let rcv_alt = receiver.altitude_m();
        let flc = geo::finite_line_correction(seg.length_m as f64, seg.dist_m, seg.fraction);

        // Unified path profile — one sampling, four rasters.
        let mut path_profile = propagation::PathProfile::new();
        rasters.build_path_profile(
            seg.cp_lat,
            seg.cp_lon,
            receiver.lat,
            receiver.lon,
            seg.dist_m,
            &mut path_profile,
        );
        // Bridge: hard surface below → G=0. Otherwise line-averaged G along path.
        let ground_g = if seg.bridge {
            0.0
        } else {
            propagation::path_effects::ground_g_from_profile(&path_profile)
        };
        let (terrain, _terrain_profile_points) =
            propagation::path_effects::terrain_attenuation_with_meta(
                &mut path_profile,
                src_alt,
                rcv_alt,
            );
        let (screening_atten, obstacle_trace) =
            propagation::path_effects::screening_attenuation_with_meta(
                &mut path_profile,
                barriers,
                src_alt,
                rcv_alt,
                0.0, // railways: no exclusion radius
                &terrain.attenuation_bands,
            );
        let veg_atten = propagation::path_effects::vegetation_attenuation_path(&path_profile);

        let mut seg_variants = [
            PropagationVariants::default(),
            PropagationVariants::default(),
            PropagationVariants::default(),
        ];
        let mut day_emission_energy = 0.0f64;
        let mut period_emissions: [[f64; NUM_BANDS]; 3] = [[0.0; NUM_BANDS]; 3];
        for (pi, &(pax_pct, frt_pct, hours)) in periods.iter().enumerate() {
            let emission = railway::railway_emission(
                rail_type,
                speed,
                q_pax * pax_pct,
                q_frt * frt_pct,
                hours,
            );
            let v = iso9613::propagate_variants_full(
                &emission,
                d_slant,
                SourceGeometry::Line,
                ground_g,
                &terrain.attenuation_bands,
                &screening_atten,
                &veg_atten,
                reflection,
                flc,
            );
            seg_variants[pi].add(&v);
            if pi == 0 {
                for j in 0..NUM_BANDS {
                    day_emission_energy += crate::propagation::iso9613::fast_exp_f64(
                        emission[j] * std::f64::consts::LN_10 * 0.1,
                    );
                }
            }
            period_emissions[pi] = emission;
        }

        // Group by (ref, name, type). When both ref+name empty, group by osm_id
        // (each OSM way is a logical track segment — avoids merging entire city tram network).
        let key_str = if !seg.rail_ref.is_empty() || !seg.name.is_empty() {
            format!("{}|{}", seg.rail_ref, seg.name)
        } else {
            format!("osm:{}", seg.osm_id)
        };
        let key = (key_str, seg.rail_type);
        let acc = rails_by_key.entry(key).or_insert_with(|| RailAccum {
            name: {
                // Build display name: "trať 250 — Brno–Havlíčkův Brod" or "trať 250" or name or "Rail"
                if !seg.rail_ref.is_empty() && !seg.name.is_empty() {
                    format!("trať {} — {}", seg.rail_ref, seg.name)
                } else if !seg.rail_ref.is_empty() {
                    format!("trať {}", seg.rail_ref)
                } else if !seg.name.is_empty() {
                    seg.name.clone()
                } else {
                    String::new()
                }
            },
            rail_type,
            rail_type_u8: seg.rail_type,
            usage_u8: seg.usage,
            first_osm_id: seg.osm_id,
            min_dist: f64::MAX,
            min_d_slant: 0.0,
            min_ground_g: 0.5,
            cp_lat: seg.cp_lat,
            cp_lon: seg.cp_lon,
            src_height: src_alt,
            closest_trains_passenger_raw: 0.0,
            closest_trains_freight_raw: 0.0,
            closest_trains_passenger_effective: 0.0,
            closest_trains_freight_effective: 0.0,
            closest_trains_passenger_source: "default_by_type",
            closest_trains_freight_source: "default_by_type",
            closest_source_id: 0,
            closest_maxspeed_posted: 0,
            closest_speed_used: 0.0,
            closest_speed_source: "type_default",
            closest_service: false,
            closest_highspeed: false,
            closest_parallel_divisor: 1,
            dominant_segment_idx: 0,
            dominant_distance_m: 0.0,
            dominant_trains_passenger_raw: 0.0,
            dominant_trains_freight_raw: 0.0,
            dominant_trains_passenger_effective: 0.0,
            dominant_trains_freight_effective: 0.0,
            dominant_trains_passenger_source: "default_by_type",
            dominant_trains_freight_source: "default_by_type",
            dominant_source_id: 0,
            dominant_maxspeed_posted: 0,
            dominant_speed_used: 0.0,
            dominant_speed_source: "type_default",
            dominant_service: false,
            dominant_highspeed: false,
            dominant_parallel_divisor: 1,
            segment_count: 0,
            total_length_m: 0.0,
            obstacle_segment_count: 0,
            obstacle_height_sum: 0.0,
            obstacle_max_height: 0.0,
            obstacle_max_segment_idx: 0,
            variants: [
                PropagationVariants::default(),
                PropagationVariants::default(),
                PropagationVariants::default(),
            ],
            emission_energy: 0.0,
            line_coords: Vec::new(),
            has_bridge: false,
            dominant_energy: 0.0,
            dominant_trace_idx: None,
        });
        // Aggregation
        acc.segment_count += 1;
        acc.total_length_m += seg.length_m as f64;
        // Group-level obstacle histogram
        {
            let (seg_max_bh, _) = rasters.max_building_along_path(
                seg.cp_lat,
                seg.cp_lon,
                receiver.lat,
                receiver.lon,
                seg.dist_m,
                0.0,
            );
            if seg_max_bh > 2.0 {
                acc.obstacle_segment_count += 1;
                acc.obstacle_height_sum += seg_max_bh;
                if seg_max_bh > acc.obstacle_max_height {
                    acc.obstacle_max_height = seg_max_bh;
                    acc.obstacle_max_segment_idx = seg.segment_idx;
                }
            }
        }
        for pi in 0..3 {
            acc.variants[pi].add(&seg_variants[pi]);
        }
        acc.emission_energy += day_emission_energy;
        if seg.bridge {
            acc.has_bridge = true;
        }
        if seg.dist_m < acc.min_dist {
            acc.min_dist = seg.dist_m;
            acc.min_d_slant = d_slant;
            acc.min_ground_g = ground_g;
            acc.cp_lat = seg.cp_lat;
            acc.cp_lon = seg.cp_lon;
            acc.src_height = src_alt;
            // Closest-segment metadata for popup
            acc.closest_trains_passenger_raw = seg.trains_passenger;
            acc.closest_trains_freight_raw = seg.trains_freight;
            acc.closest_trains_passenger_effective = q_pax;
            acc.closest_trains_freight_effective = q_frt;
            acc.closest_trains_passenger_source = match seg.trains_passenger_source {
                0 => "arrow",
                _ => "default_by_type",
            };
            acc.closest_trains_freight_source = match seg.trains_freight_source {
                0 => "arrow",
                _ => "default_by_type",
            };
            acc.closest_source_id = seg.source_id;
            acc.closest_maxspeed_posted = seg.maxspeed;
            acc.closest_speed_used = speed;
            acc.closest_speed_source = match seg.speed_source {
                0 => "osm_maxspeed",
                1 => "highspeed_default",
                _ => "type_default",
            };
            acc.closest_service = seg.service;
            acc.closest_highspeed = seg.highspeed;
            acc.closest_parallel_divisor = seg.parallel_divisor.max(1);
        }
        acc.line_coords
            .push([[seg.start_lon, seg.start_lat], [seg.end_lon, seg.end_lat]]);

        // Dominant segment — highest received energy drives the popup display
        // metadata (speed, train counts, service, highspeed, parallel_divisor),
        // mirroring the road pattern at line ~720. The gate runs OUTSIDE the
        // trace block so the metadata is correct even when traces aren't being
        // collected. `crosses_dominant` is reused inside the trace block to
        // tag the corresponding `dominant_trace_idx` without re-comparing.
        let seg_energy: f64 = seg_variants[0].full_energy;
        let crosses_dominant = seg_energy > acc.dominant_energy;
        if crosses_dominant {
            acc.dominant_energy = seg_energy;
            acc.dominant_segment_idx = seg.segment_idx;
            acc.dominant_distance_m = seg.dist_m;
            acc.dominant_trains_passenger_raw = seg.trains_passenger;
            acc.dominant_trains_freight_raw = seg.trains_freight;
            acc.dominant_trains_passenger_effective = q_pax;
            acc.dominant_trains_freight_effective = q_frt;
            acc.dominant_trains_passenger_source = match seg.trains_passenger_source {
                0 => "arrow",
                _ => "default_by_type",
            };
            acc.dominant_trains_freight_source = match seg.trains_freight_source {
                0 => "arrow",
                _ => "default_by_type",
            };
            acc.dominant_source_id = seg.source_id;
            acc.dominant_maxspeed_posted = seg.maxspeed;
            acc.dominant_speed_used = speed;
            acc.dominant_speed_source = match seg.speed_source {
                0 => "osm_maxspeed",
                1 => "highspeed_default",
                _ => "type_default",
            };
            acc.dominant_service = seg.service;
            acc.dominant_highspeed = seg.highspeed;
            acc.dominant_parallel_divisor = seg.parallel_divisor.max(1);
        }

        // Popup trace: push per-segment trace + tag the dominant one so we can
        // flip is_dominant_of_group once the loop finishes.
        if let Some(t) = traces.as_deref_mut() {
            let trace = build_rail_segment_trace(BuildRailTrace {
                seg,
                src_alt,
                rcv_alt,
                d_slant,
                flc,
                ground_g,
                reflection_boost_db: reflection,
                q_pax,
                q_frt,
                speed_kmh: speed,
                path_profile: std::mem::take(&mut path_profile),
                terrain,
                screening_atten,
                obstacle_trace,
                veg_atten,
                seg_variants,
                lw_bands: period_emissions,
            });
            let trace_idx = t.segments.len();
            t.segments.push(trace);
            if crosses_dominant {
                acc.dominant_trace_idx = Some(trace_idx);
            }
        }
    }

    if let Some(t) = traces {
        for acc in rails_by_key.values() {
            if let Some(idx) = acc.dominant_trace_idx {
                if let Some(tr) = t.segments.get_mut(idx) {
                    tr.is_dominant_of_group = true;
                }
            }
        }
    }

    let mut contributors = Vec::new();
    for ((_key, _rt), acc) in &rails_by_key {
        let ld = PropagationVariants::to_db(acc.variants[0].full_energy);
        let le = PropagationVariants::to_db(acc.variants[1].full_energy);
        let ln = PropagationVariants::to_db(acc.variants[2].full_energy);
        let rail_periods = periods::periods(ld, le, ln);

        let ld_free = PropagationVariants::to_db(acc.variants[0].free_field_energy);
        let le_free = PropagationVariants::to_db(acc.variants[1].free_field_energy);
        let ln_free = PropagationVariants::to_db(acc.variants[2].free_field_energy);
        let free_periods = periods::periods(ld_free, le_free, ln_free);

        let geometry = if !acc.line_coords.is_empty() {
            Some(serde_json::json!({"type": "MultiLineString", "coordinates": acc.line_coords}))
        } else {
            None
        };

        let rail_effects = compute_path_effects(
            rasters,
            barriers,
            acc.cp_lat,
            acc.cp_lon,
            acc.src_height,
            receiver,
            acc.min_dist,
            0.0,
        );

        let impacts = PropagationVariants::impact_deltas(&acc.variants, rail_periods.lden_db);

        // Headline rail metadata: dominant (loudest) segment, mirroring the
        // road-contributor pattern. `closest_*` is still tracked on the
        // accumulator for the propagation baseline (`min_dist`, `cp_lat/lon`,
        // `min_d_slant`, `min_ground_g`) but no longer feeds these display
        // fields — closest mis-represented audible traffic whenever a busy
        // mainline sat farther than a quiet siding.
        let rail_meta = RailMetadata {
            trains_passenger_raw: acc.dominant_trains_passenger_raw,
            trains_freight_raw: acc.dominant_trains_freight_raw,
            trains_passenger_source: acc.dominant_trains_passenger_source,
            trains_freight_source: acc.dominant_trains_freight_source,
            source_id: acc.dominant_source_id,
            maxspeed_posted_kmh: acc.dominant_maxspeed_posted,
            trains_passenger_effective: acc.dominant_trains_passenger_effective,
            trains_freight_effective: acc.dominant_trains_freight_effective,
            speed_kmh: acc.dominant_speed_used,
            speed_source: acc.dominant_speed_source,
            rail_type: rail_type_name(acc.rail_type_u8),
            usage: rail_usage_name(acc.usage_u8),
            service: acc.dominant_service,
            highspeed: acc.dominant_highspeed,
            parallel_divisor: acc.dominant_parallel_divisor,
            dominant_segment_idx: acc.dominant_segment_idx,
            dominant_distance_m: acc.dominant_distance_m,
            closest_distance_m: acc.min_dist,
            bridge: acc.has_bridge,
            segment_count: acc.segment_count,
            total_length_m: acc.total_length_m,
            obstacle_segment_count: acc.obstacle_segment_count,
            obstacle_avg_height_m: if acc.obstacle_segment_count > 0 {
                (acc.obstacle_height_sum / acc.obstacle_segment_count as f64 * 10.0).round() / 10.0
            } else {
                0.0
            },
            obstacle_max_height_m: (acc.obstacle_max_height * 10.0).round() / 10.0,
            obstacle_max_segment_idx: acc.obstacle_max_segment_idx,
            provenance: crate::sources::dataset_meta(acc.dominant_source_id),
        };

        contributors.push(Contributor {
            osm_id: Some(acc.first_osm_id),
            geometry,
            source_type: LayerKind::Railway,
            name: if acc.name.is_empty() {
                String::new()
            } else {
                acc.name.clone()
            },
            subtype: {
                let base = format!("{:?}", acc.rail_type);
                if acc.has_bridge {
                    format!("{} (bridge)", base)
                } else {
                    base
                }
            },
            distance_m: acc.min_dist,
            periods: rail_periods,
            periods_free: free_periods,
            emission_db: 10.0 * acc.emission_energy.max(1e-12).log10(),
            baseline: iso9613::compute_baseline(
                acc.min_d_slant,
                SourceGeometry::Line,
                acc.min_ground_g,
            ),
            terrain: rail_effects.0,
            screening: rail_effects.1,
            vegetation: rail_effects.2,
            terrain_impact_db: round1(impacts.terrain),
            screening_impact_db: round1(impacts.screening),
            vegetation_impact_db: round1(impacts.vegetation),
            atmospheric_impact_db: round1(impacts.atmospheric),
            ground_impact_db: round1(impacts.ground),
            received_bands: std::array::from_fn(|j| {
                10.0 * acc.variants[0].band_energy[j].max(1e-30).log10()
            }),
            metadata: Some(SourceMetadata::Rail(rail_meta)),
        });
    }

    let mut total_energy = [0.0f64; 3];
    for acc in rails_by_key.values() {
        total_energy[0] += acc.variants[0].full_energy;
        total_energy[1] += acc.variants[1].full_energy;
        total_energy[2] += acc.variants[2].full_energy;
    }
    let ld = 10.0 * total_energy[0].max(1e-12).log10();
    let le = 10.0 * total_energy[1].max(1e-12).log10();
    let ln = 10.0 * total_energy[2].max(1e-12).log10();
    (periods::periods(ld, le, ln), contributors)
}
