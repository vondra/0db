    use super::*;

    fn pt(ts: f64, lat: f32, lon: f32, alt_ft: f32, speed: f32, track: f32) -> TracePoint {
        TracePoint {
            timestamp: ts,
            lat,
            lon,
            alt_ft,
            speed_kt: speed,
            track_deg: track,
            baro_rate_fpm: 0.0,
            flags: 0,
        }
    }

    fn test_meta() -> SegmentMeta<'static> {
        SegmentMeta {
            flight_id: 1,
            callsign: "",
            aircraft_type: [0u8; 4],
            profile_idx: 0,
            source_id: 0,
            origin: 0,
            veh_kind: 0,
            gse_class: 0,
            date_id: 1234,
        }
    }

    fn ground_pt(ts: f64, lat: f32, lon: f32, speed: f32) -> TracePoint {
        TracePoint {
            timestamp: ts,
            lat,
            lon,
            alt_ft: f32::NAN,
            speed_kt: speed,
            track_deg: 0.0,
            baro_rate_fpm: 0.0,
            flags: crate::trace::FLAG_ON_GROUND_RAW | crate::trace::FLAG_ALT_IS_GROUND,
        }
    }

    #[test]
    fn split_flights_breaks_on_ground_rest() {
        // Airborne leg, 6-min ground rest at the gate, airborne leg again.
        let points = vec![
            pt(0.0, 50.0, 14.0, 1_000.0, 200.0, 90.0),
            pt(10.0, 50.001, 14.001, 1_000.0, 200.0, 90.0),
            ground_pt(20.0, 50.002, 14.002, 5.0),
            ground_pt(380.0, 50.002, 14.002, 5.0), // 360 s ≥ MIN_TURNAROUND_S
            pt(400.0, 50.003, 14.003, 1_000.0, 200.0, 90.0),
            pt(410.0, 50.004, 14.004, 1_000.0, 200.0, 90.0),
        ];
        let flights = split_flights(&points);
        assert_eq!(flights.len(), 2);
    }

    #[test]
    fn split_flights_keeps_through_air_signal_gap() {
        // 4 h gap with no ground flag — transoceanic dropout, one flight.
        let points = vec![
            pt(0.0, 50.0, 14.0, 35_000.0, 450.0, 90.0),
            pt(60.0, 50.001, 14.001, 35_000.0, 450.0, 90.0),
            pt(14_400.0, 51.0, 30.0, 35_000.0, 450.0, 90.0),
            pt(14_460.0, 51.001, 30.001, 35_000.0, 450.0, 90.0),
        ];
        let flights = split_flights(&points);
        assert_eq!(flights.len(), 1);
    }

    #[test]
    fn split_flights_ignores_touch_and_go() {
        // 10 s touchdown between two airborne legs — same flight.
        let points = vec![
            pt(0.0, 50.0, 14.0, 500.0, 130.0, 0.0),
            pt(5.0, 50.001, 14.0, 200.0, 130.0, 0.0),
            ground_pt(10.0, 50.002, 14.0, 5.0),
            pt(20.0, 50.003, 14.0, 200.0, 130.0, 0.0),
            pt(25.0, 50.004, 14.0, 600.0, 130.0, 0.0),
        ];
        let flights = split_flights(&points);
        assert_eq!(flights.len(), 1);
    }

    #[test]
    fn split_flights_trace_starting_or_ending_airborne_yields_one_flight() {
        // No on-ground bit set anywhere — partial trace, one flight.
        let points: Vec<_> = (0..5)
            .map(|i| {
                pt(
                    i as f64 * 5.0,
                    50.0 + 0.001 * i as f32,
                    14.0,
                    5_000.0,
                    250.0,
                    0.0,
                )
            })
            .collect();
        let flights = split_flights(&points);
        assert_eq!(flights.len(), 1);
    }

    #[test]
    fn split_flights_leading_ground_run_absorbed_into_first_leg() {
        // Trace begins with a long ground rest (no prior airborne leg).
        // No split fires — the `i - leg_start >= 2` guard prevents a
        // zero-length leg being emitted ahead of the takeoff samples.
        let points = vec![
            ground_pt(0.0, 50.0, 14.0, 5.0),
            ground_pt(600.0, 50.001, 14.001, 5.0),
            pt(610.0, 50.002, 14.002, 1_000.0, 200.0, 0.0),
            pt(615.0, 50.003, 14.003, 1_000.0, 200.0, 0.0),
        ];
        let flights = split_flights(&points);
        assert_eq!(flights.len(), 1);
        assert_eq!(flights[0], 0..4);
    }

    #[test]
    fn build_segments_emits_one_per_sample_pair() {
        let n = 10;
        let points: Vec<_> = (0..n)
            .map(|i| {
                pt(
                    i as f64 * 5.0,
                    50.0 + 0.001 * i as f32,
                    14.0,
                    5000.0,
                    250.0,
                    0.0,
                )
            })
            .collect();
        let phases = vec![Phase::Airborne; n];
        let agl = vec![1500.0; n];
        let elev: Vec<f32> = vec![0.0; points.len()];
        let segs = build_segments(&points, &agl, &elev, &phases, &test_meta());
        assert_eq!(segs.len(), n - 1);
        for s in &segs {
            assert_eq!(s.phase, Phase::Airborne);
            assert!(s.length_m > 50.0);
        }
    }

    #[test]
    fn build_segments_drops_short_taxi_remnant() {
        let points = vec![
            pt(0.0, 50.0, 14.0, 0.0, 5.0, 90.0),
            pt(1.0, 50.000_001, 14.0, 0.0, 5.0, 90.0),
        ];
        let phases = vec![Phase::Ground; 2];
        let agl = vec![0.0; 2];
        let elev: Vec<f32> = vec![0.0; points.len()];
        let segs = build_segments(&points, &agl, &elev, &phases, &test_meta());
        assert!(segs.is_empty());
    }

    #[test]
    fn build_segments_phase_descent_through_boundary_is_airborne() {
        // Cruise → Airborne descent: segment phase must be Airborne so
        // the kernel uses approach NPD (and not Stage 2B's forced
        // Departure NPD).
        let points = vec![
            pt(0.0, 50.0, 14.0, 26_000.0, 450.0, 0.0),
            pt(10.0, 50.005, 14.0, 24_000.0, 450.0, 0.0),
        ];
        let phases = vec![Phase::Cruise, Phase::Airborne];
        let agl = vec![7700.0, 7000.0];
        let elev: Vec<f32> = vec![0.0; points.len()];
        let segs = build_segments(&points, &agl, &elev, &phases, &test_meta());
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].phase, Phase::Airborne);
    }

    #[test]
    fn build_segments_flare_keeps_airborne_alt() {
        // Airborne → Ground landing flare: segment phase must stay
        // Airborne (audible final approach) and the ground endpoint
        // inherits the airborne altitude so the elevated-airport
        // airborne validator doesn't reject the segment for "start
        // altitude below terrain".
        let mut ground = pt(10.0, 50.001, 14.0, 0.0, 130.0, 0.0);
        ground.flags = crate::trace::FLAG_ALT_IS_GROUND | crate::trace::FLAG_ON_GROUND_RAW;
        let points = vec![pt(0.0, 50.0, 14.0, 1_300.0, 130.0, 0.0), ground];
        let phases = vec![Phase::Airborne, Phase::Ground];
        let agl = vec![100.0, 0.0];
        let elev: Vec<f32> = vec![0.0; points.len()];
        let segs = build_segments(&points, &agl, &elev, &phases, &test_meta());
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].phase, Phase::Airborne);
        assert!(
            segs[0].end_alt_m > 100.0,
            "ground endpoint patched, got {}",
            segs[0].end_alt_m
        );
        assert_eq!(segs[0].start_alt_m, segs[0].end_alt_m);
    }

    #[test]
    fn build_segments_cruise_dropout_reappearing_airborne_uses_cruise_budget() {
        // Plane drops out at FL350 cruise, reappears 30 min later mid
        // descent in airborne. Gap budget should be GAP_S_CRUISE (the
        // more permissive endpoint), not GAP_S_AIRBORNE.
        let points = vec![
            pt(0.0, 50.0, 14.0, 35_000.0, 450.0, 90.0),
            pt(1800.0, 50.0, 14.4, 18_000.0, 450.0, 90.0),
        ];
        let phases = vec![Phase::Cruise, Phase::Airborne];
        let agl = vec![10_500.0, 5_400.0];
        let elev: Vec<f32> = vec![0.0; points.len()];
        let segs = build_segments(&points, &agl, &elev, &phases, &test_meta());
        assert_eq!(segs.len(), 1, "C→A pair with 30 min gap should survive");
        assert_eq!(segs[0].phase, Phase::Airborne);
    }

    #[test]
    fn build_segments_skips_long_airborne_gap() {
        // 200 s > GAP_S_AIRBORNE (120 s) → drop.
        let points = vec![
            pt(0.0, 50.0, 14.0, 5000.0, 250.0, 0.0),
            pt(200.0, 50.5, 14.0, 5000.0, 250.0, 0.0),
        ];
        let phases = vec![Phase::Airborne, Phase::Airborne];
        let agl = vec![1500.0, 1500.0];
        let elev: Vec<f32> = vec![0.0; points.len()];
        let segs = build_segments(&points, &agl, &elev, &phases, &test_meta());
        assert!(segs.is_empty());
    }

    #[test]
    fn build_segments_keeps_long_cruise_gap() {
        // dt = 200 s > GAP_S_AIRBORNE (120 s) but < GAP_S_CRUISE (3600 s).
        let points = vec![
            pt(0.0, 50.0, 14.0, 35_000.0, 250.0, 90.0),
            pt(200.0, 50.0, 14.4, 35_000.0, 250.0, 90.0),
        ];
        let phases = vec![Phase::Cruise, Phase::Cruise];
        let agl = vec![10_500.0, 10_500.0];
        let elev: Vec<f32> = vec![0.0; points.len()];
        let segs = build_segments(&points, &agl, &elev, &phases, &test_meta());
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].phase, Phase::Cruise);
    }

    #[test]
    fn classify_is_departure_air_to_ground_transition_classifies_as_arrival() {
        // Approach decelerating 200→140 kt, then touchdown:
        // first ground point after touchdown with continued
        // deceleration 120→60 kt over the rollout. The transition
        // pair (last airborne 140 kt + first ground 120 kt) has
        // one None alt → speed branch. Lookback sees decelerating
        // trend → must NOT classify as departure.
        let mut points: Vec<TracePoint> = (0..6)
            .map(|i| {
                pt(
                    i as f64 * 5.0,
                    50.0 + 0.002 * i as f32,
                    14.0,
                    500.0 - 80.0 * i as f32,
                    200.0 - 12.0 * i as f32,
                    0.0,
                )
            })
            .collect();
        for i in 6..12 {
            points.push(ground_pt(
                i as f64 * 5.0,
                50.012 + 0.0008 * (i - 6) as f32,
                14.0,
                120.0 - 12.0 * (i - 6) as f32,
            ));
        }
        let alts: Vec<Option<f32>> = points.iter().map(|p| p.airborne_alt_ft()).collect();
        let phases: Vec<Phase> = alts
            .iter()
            .map(|a| {
                if a.is_some() {
                    Phase::Airborne
                } else {
                    Phase::Ground
                }
            })
            .collect();
        let result = classify_is_departure_per_sample(&points, &alts, &phases);
        assert!(
            !result[6],
            "touchdown transition must NOT classify as departure"
        );
        assert!(
            !result[8],
            "mid landing-rollout must NOT classify as departure"
        );
    }

    #[test]
    fn classify_is_departure_ground_to_air_transition_classifies_as_departure() {
        // 6 ground samples accelerating 20→120 kt (takeoff roll),
        // then lift-off: a single transition pair (last ground point +
        // first airborne point at 140 kt / 50 ft). The transition has
        // one None alt → speed branch via the OR predicate. Lookback
        // sees +200 kt/min trend → should classify as departure.
        let mut points: Vec<TracePoint> = (0..6)
            .map(|i| {
                ground_pt(
                    i as f64 * 5.0,
                    50.0 + 0.0008 * i as f32,
                    14.0,
                    20.0 + 20.0 * i as f32,
                )
            })
            .collect();
        points.push(pt(30.0, 50.005, 14.0, 50.0, 140.0, 0.0));
        for i in 7..10 {
            points.push(pt(
                i as f64 * 5.0,
                50.005 + 0.001 * (i - 6) as f32,
                14.0,
                300.0 + 100.0 * (i - 6) as f32,
                140.0,
                0.0,
            ));
        }
        let alts: Vec<Option<f32>> = points.iter().map(|p| p.airborne_alt_ft()).collect();
        let phases: Vec<Phase> = alts
            .iter()
            .map(|a| {
                if a.is_some() {
                    Phase::Airborne
                } else {
                    Phase::Ground
                }
            })
            .collect();
        let result = classify_is_departure_per_sample(&points, &alts, &phases);
        assert!(
            result[6],
            "ground→air transition during takeoff roll must classify as departure"
        );
    }

    #[test]
    fn classify_is_departure_ground_constant_speed_no_false_positive() {
        // Runway crossing at a constant 40 kt — high speed, zero
        // acceleration. Should NOT trigger departure classification.
        let points: Vec<TracePoint> = (0..12)
            .map(|i| ground_pt(i as f64 * 5.0, 50.0 + 0.0002 * i as f32, 14.0, 40.0))
            .collect();
        let alts: Vec<Option<f32>> = points.iter().map(|p| p.airborne_alt_ft()).collect();
        let phases: Vec<Phase> = alts
            .iter()
            .map(|a| {
                if a.is_some() {
                    Phase::Airborne
                } else {
                    Phase::Ground
                }
            })
            .collect();
        let result = classify_is_departure_per_sample(&points, &alts, &phases);
        for (i, dep) in result.iter().enumerate().skip(1) {
            assert!(
                !dep,
                "constant 40 kt at i={i} must not classify as departure"
            );
        }
    }

    #[test]
    fn classify_is_departure_ground_taxi_burst_smoothed_out() {
        // Steady 10-kt taxi, one apron stop-start burst at i=5-6
        // (0→20 kt in 5 s = 240 kt/min per-pair, but a single pair
        // amid steady samples). Median over ±5 must reject the
        // transient and keep all pairs at NOT-departure.
        let mut points: Vec<TracePoint> = (0..12)
            .map(|i| ground_pt(i as f64 * 5.0, 50.0 + 0.0001 * i as f32, 14.0, 10.0))
            .collect();
        points[5].speed_kt = 0.0;
        points[6].speed_kt = 20.0; // single-pair burst of +240 kt/min
        let alts: Vec<Option<f32>> = points.iter().map(|p| p.airborne_alt_ft()).collect();
        let phases: Vec<Phase> = alts
            .iter()
            .map(|a| {
                if a.is_some() {
                    Phase::Airborne
                } else {
                    Phase::Ground
                }
            })
            .collect();
        let result = classify_is_departure_per_sample(&points, &alts, &phases);
        for (i, dep) in result.iter().enumerate().skip(1) {
            assert!(!dep, "taxi burst at i={i} must be median-rejected");
        }
    }

    #[test]
    fn classify_is_departure_ground_speed_trend() {
        // Takeoff roll: speed accelerates 20→180 kt over 8 × 5 s pairs
        // (= +240 kt/min per-pair, well above 60 kt/min threshold).
        // Then 4 steady-taxi pairs at 15 kt (~0 acceleration).
        // Then 4 landing-rollout pairs decelerating 160→40 kt
        // (= −480 kt/min per-pair, well below threshold).
        let mut points: Vec<TracePoint> = (0..9)
            .map(|i| {
                ground_pt(
                    i as f64 * 5.0,
                    50.0 + 0.0005 * i as f32,
                    14.0,
                    20.0 + 20.0 * i as f32,
                )
            })
            .collect();
        for i in 9..13 {
            points.push(ground_pt(
                i as f64 * 5.0,
                50.0045 + 0.00001 * i as f32,
                14.0,
                15.0,
            ));
        }
        for i in 13..17 {
            let k = (i - 13) as f32;
            points.push(ground_pt(
                i as f64 * 5.0,
                50.005 + 0.0001 * k,
                14.0,
                160.0 - 40.0 * k,
            ));
        }
        let alts: Vec<Option<f32>> = points.iter().map(|p| p.airborne_alt_ft()).collect();
        let phases: Vec<Phase> = alts
            .iter()
            .map(|a| {
                if a.is_some() {
                    Phase::Airborne
                } else {
                    Phase::Ground
                }
            })
            .collect();
        let result = classify_is_departure_per_sample(&points, &alts, &phases);
        assert!(result[2], "early takeoff roll should classify as departure");
        assert!(result[5], "mid takeoff roll");
        assert!(!result[11], "steady taxi should not classify as departure");
        assert!(
            !result[15],
            "landing rollout should not classify as departure"
        );
    }

    #[test]
    fn classify_is_departure_climb_descent() {
        // 6 climbing samples at +600 fpm, then 6 descending at -600 fpm.
        // Early indices = Departure; late indices = Approach.
        let mut points: Vec<TracePoint> = (0..6)
            .map(|i| {
                pt(
                    i as f64 * 5.0,
                    50.0 + 0.001 * i as f32,
                    14.0,
                    1000.0 + 50.0 * i as f32,
                    200.0,
                    0.0,
                )
            })
            .collect();
        for i in 6..12 {
            points.push(pt(
                i as f64 * 5.0,
                50.0 + 0.001 * i as f32,
                14.0,
                1250.0 - 50.0 * (i - 6) as f32,
                200.0,
                0.0,
            ));
        }
        let alts: Vec<Option<f32>> = points.iter().map(|p| p.airborne_alt_ft()).collect();
        let phases: Vec<Phase> = alts
            .iter()
            .map(|a| {
                if a.is_some() {
                    Phase::Airborne
                } else {
                    Phase::Ground
                }
            })
            .collect();
        let result = classify_is_departure_per_sample(&points, &alts, &phases);
        assert!(result[1], "first climbing pair");
        assert!(result[3], "mid climb");
        assert!(!result[11], "late descent");
    }

    #[test]
    fn classify_is_departure_smoothing_resists_jitter() {
        // Steady +960 fpm climb; one anomalous baro spike at i=5.
        let n = 11;
        let mut points: Vec<TracePoint> = (0..n)
            .map(|i| {
                pt(
                    i as f64 * 5.0,
                    50.0 + 0.001 * i as f32,
                    14.0,
                    5000.0 + 80.0 * i as f32,
                    250.0,
                    0.0,
                )
            })
            .collect();
        points[5].alt_ft = points[4].alt_ft - 200.0;
        let alts: Vec<Option<f32>> = points.iter().map(|p| p.airborne_alt_ft()).collect();
        let phases: Vec<Phase> = alts
            .iter()
            .map(|a| {
                if a.is_some() {
                    Phase::Airborne
                } else {
                    Phase::Ground
                }
            })
            .collect();
        let result = classify_is_departure_per_sample(&points, &alts, &phases);
        assert!(result[6], "median smoothing rejects single anomaly");
    }
