// Types matching /api/noise-onfly-v2 response — shared between DetailPopup,
// App (state) and MapView (prop plumbing).

export interface SourceSummary {
  source_type: string
  lden: number | null
  lden_free: number | null
  segment_count: number
  displayed_count: number
}

export interface PropagationBaseline {
  /** Divergence loss at the closest segment (≤ 0). */
  geometric_db: number
  /** G value the engine read from the raster at the closest segment (0..1). */
  ground_factor: number
}

export interface NoisePeriodsData {
  // Engine emits f64::NEG_INFINITY for silent periods → serde_json renders
  // those as JSON null. Use `fmtDb` / `fmtDbValue` from utils/formatters.ts
  // to render — bare `.toFixed(1)` will crash at runtime.
  ld_db: number | null
  le_db: number | null
  ln_db: number | null
  lden_db: number | null
}

export interface TerrainBreakdownData {
  delta_m: number
  is_double: boolean
  profile_points: number
}

export interface ScreeningBreakdownData {
  building_path_m: number
  obstacle: ScreeningObstacleTrace | null
}

export interface VegetationBreakdownData {
  forest_depth_m: number
  sampled_path_m: number
}

export interface ScreeningObstacleTrace {
  kind: 'building' | 'barrier' | 'none'
  /** Height of the DOMINANT (max LOS excess) sample — not the leftmost. */
  height_m: number
  /** Fractional position (0..1) of the dominant sample along the path. */
  t: number
  screen_h_m: number
  delta_m: number
  samples_taken: number
  step_m: number
  /** Number of diffraction edges in the combined terrain+building+barrier
   * result (0..=3). When > 1 the popup should label "N diffraction edges",
   * NOT "N obstacles" — one edge may be a bare-earth hill (kind: 'terrain'). */
  n_edges: number
  /** Per-edge detail when `n_edges > 0`. Leftmost-first by t.
   * Dominant edge (popup highlights) = whichever has max `screen_h_m`. */
  edges: ObstacleEdge[]
}

export interface ObstacleEdge {
  /** 'terrain' = bare-earth hill (no building/barrier on top at this edge). */
  kind: 'terrain' | 'building' | 'barrier'
  t: number
  /** Building or barrier height above ground; 0 for 'terrain' kind. */
  height_m: number
  /** Edge-top minus line-of-sight (excess above LOS). */
  screen_h_m: number
}

export interface EdgePoint {
  t: number
  elevation_m: number
}

export interface DatasetProvenance {
  name: string
  year: number | null
  license: string | null
  url: string | null
}

export interface RoadMetadata {
  kind: 'road'
  aadt_light_raw: number
  aadt_medium_raw: number
  aadt_heavy_raw: number
  aadt_moto_raw: number
  traffic_source: 'matched_external' | 'estimated_service_tree' | 'default_by_class'
  dominant_dataset_id?: number
  provenance?: DatasetProvenance | null
  speed_posted_kmh: number
  aadt_light_nominal: number
  aadt_medium_nominal: number
  aadt_heavy_nominal: number
  aadt_moto_nominal: number
  aadt_light_effective: number
  aadt_medium_effective: number
  aadt_heavy_effective: number
  aadt_moto_effective: number
  speed_kmh: number
  speed_source: 'osm_posted' | 'default_by_class' | 'roundabout_cap'
  road_class: string
  surface: string
  surface_corr_db: number
  lanes: number
  oneway: boolean
  dominant_segment_idx: number
  dominant_distance_m: number
  closest_distance_m: number
  speed_min_kmh: number
  speed_max_kmh: number
  oneway_segment_count: number
  twoway_segment_count: number
  segment_count: number
  total_length_m: number
  bridge_count: number
  obstacle_segment_count: number
  obstacle_avg_height_m: number
  obstacle_max_height_m: number
  obstacle_max_segment_idx: number
}

export interface RailMetadata {
  kind: 'rail'
  trains_passenger_raw: number
  trains_freight_raw: number
  trains_passenger_source: 'arrow' | 'default_by_type'
  trains_freight_source: 'arrow' | 'default_by_type'
  dataset_id?: number
  provenance?: DatasetProvenance | null
  maxspeed_posted_kmh: number
  trains_passenger_effective: number
  trains_freight_effective: number
  speed_kmh: number
  speed_source: 'osm_maxspeed' | 'highspeed_default' | 'type_default'
  rail_type: string
  usage: string
  service: boolean
  highspeed: boolean
  parallel_divisor: number
  bridge: boolean
  segment_count: number
  total_length_m: number
  obstacle_segment_count: number
  obstacle_avg_height_m: number
  obstacle_max_height_m: number
  obstacle_max_segment_idx: number
}

export interface BuildingMetadata {
  kind: 'building'
  height_m: number
  floors: number
  area_m2: number
  building_type: string
  address: string
}

export interface IndustrialMetadata {
  kind: 'industrial'
  area_m2: number
  source_type: string
  nace: string | null
  grid_point_count: number
}

export interface AircraftEventBandStats {
  observed_events_per_day: number
  avg_altitude_m: number
  top_aircraft: string
}

export interface AircraftTopFlight {
  lmax_db: number
  cpa_distance_m: number
  altitude_m: number
  period: number // 0=day, 1=evening, 2=night
  date: string // "YYYY-MM-DD"
  profile: string
  /** ICAO typecode ("B738", "A320"). Distinct from `profile` (the
   *  Doc 29 anchor name). Empty when typecode was unknown at extract. */
  aircraft_type: string
  /** ATC callsign / flight number (e.g. "TVS100P"). Empty when missing. */
  callsign: string
  /** % of total airborne Lden energy. Cruise rows report 0 (per-fid
   *  energy split would be artificial since one bucket aggregates many
   *  real flights). */
  energy_pct: number
  geometry: [[number, number], [number, number]]
  /** ICAO 24-bit transponder address as 6-char lowercase hex
   *  ("4b1805"); empty string for synthetic ids. */
  icao_hex: string
  /** Unix timestamp seconds of flight start. `null` for synthetic. */
  start_unix: number | null
  /** True for synthetic flight ids — anonymous-transponder traces or
   *  cruise R8-bucket aggregates; UI hides ICAO + time for these. */
  synthetic: boolean
}

export interface CruiseHexTopFlight {
  lmax_db: number
  altitude_m: number
  date: string // "YYYY-MM-DD"
  time_utc: string // "HH:MM:SS"
  icao_hex: string
  aircraft_type: string
  callsign: string
  class_name: string
}

/** Server-side proxy response from `/api/aircraft/:hex` (hexdb.io). */
export interface AircraftInfo {
  hex: string
  registration: string | null
  icao_typecode: string | null
  manufacturer: string | null
  type: string | null
  operator: string | null
  operator_icao: string | null
  source: 'hexdb' | 'unknown'
  fetched_at: number
}

export interface AircraftAirborneDetail {
  periods: NoisePeriodsData
  observed_flights_per_day: number
  helicopter_flights_per_day: number
  /**
   * Distinct cruise-phase transits (real flight_id dedup) visible at this
   * receiver per day. Contributes to the Lmax band counts below when the
   * transit's peak_lmax crosses 30/45/60 dB; surfaced separately because
   * `observed_flights_per_day` is airborne-only and the bands would
   * otherwise exceed the airborne count without explanation.
   * Upper bound on the cruise contribution to bands: sub-threshold transits
   * are included here but not in band counters. A single real flight can
   * appear in both `observed_flights_per_day` and `cruise_transits_per_day`
   * if it has both a low approach/departure encounter and a high overhead
   * cruise bucket at this receiver (counted per phase, not per distinct
   * flight). Rust serializes this unconditionally — required (not optional).
   * The popup hides the row when value rounds below 0.1/day.
   */
  cruise_transits_per_day: number
  lmax_peak: number | null
  faint: AircraftEventBandStats
  audible: AircraftEventBandStats
  disruptive: AircraftEventBandStats
  top_flights?: AircraftTopFlight[]
}

export interface AircraftGroundOpsClassDetail {
  periods: NoisePeriodsData
  observed_movements_per_day: number | null
  modeled_movements_per_day: number | null
}

/** Ground-ops profile-mix entry: noise class, its share of linear
 *  received energy, and the ICAO typecode of the class anchor. */
export interface ProfileMixEntry {
  class: number
  share: number
  rep_typecode: string
}

export interface AircraftGroundOpsDetail {
  periods: NoisePeriodsData
  periods_free: NoisePeriodsData
  observed_movements_per_day: number | null
  modeled_movements_per_day: number | null
  /** Unique arrival rotations per day at this airport. Computed
   *  from the set of flight_ids whose runway_roll segments had
   *  is_departure=0. NOT an ICAO Annex-14 movement (a one-flight
   *  arrival counts as 1 here; Annex-14 might count it as 2). */
  arrivals_per_day: number | null
  /** Unique departure rotations per day; same semantics as
   *  [`arrivals_per_day`] with is_departure=1. */
  departures_per_day: number | null
  /** Ground Support Equipment events per day, indexed by class
   *  (0=LIGHT, 1=MEDIUM, 2=HEAVY). Pushback tractors, fuel
   *  trucks, follow-me cars classified by callsign prefix at
   *  Stage 0 ingestion. `null` when no GSE seen at this airport. */
  gse_per_day: [number, number, number] | null
  distance_m: number
  emission_db: number
  received_bands: number[]
  runway_roll: AircraftGroundOpsClassDetail
  taxi: AircraftGroundOpsClassDetail
  apron_movement: AircraftGroundOpsClassDetail
  /** Top-3 noise-class shares at this receiver. Optional because
   *  `serde(skip_serializing_if = "Vec::is_empty")` omits the key
   *  when no row contributed a class. */
  profile_mix?: ProfileMixEntry[]
  baseline: PropagationBaseline
  terrain: TerrainBreakdownData
  screening: ScreeningBreakdownData
  vegetation: VegetationBreakdownData
  /** A-weighted ΔL_A per effect (≤ 0 except ground which is signed). */
  terrain_impact_db: number
  screening_impact_db: number
  vegetation_impact_db: number
  atmospheric_impact_db: number
  ground_impact_db: number
}

export interface AircraftMetadata {
  kind: 'aircraft'
  variant: 'airborne' | 'ground_ops'
  airport_name?: string | null
  airport_key?: string | null
  airborne?: AircraftAirborneDetail | null
  ground_ops?: AircraftGroundOpsDetail | null
}

export type SourceMetadata =
  | RoadMetadata
  | RailMetadata
  | BuildingMetadata
  | IndustrialMetadata
  | AircraftMetadata

export interface Contributor {
  source_type: string
  osm_id: number | null
  name: string
  subtype: string
  distance_m: number
  metadata: SourceMetadata | null
  emission_db: number
  emission_bands: number[]
  baseline: PropagationBaseline
  terrain: TerrainBreakdownData
  screening: ScreeningBreakdownData
  vegetation: VegetationBreakdownData
  /** A-weighted ΔL_A per effect: full_lden − no_effect_lden. ≤ 0 except
   * `ground_impact_db` which is signed (over soft ground at 63/125 Hz CF[i]
   * is negative, so the ground term can BOOST LF energy). */
  terrain_impact_db: number
  screening_impact_db: number
  vegetation_impact_db: number
  atmospheric_impact_db: number
  ground_impact_db: number
  received_lden: number
  received_lden_free: number
  received_bands: number[]
  geometry: any | null
}

export interface NoiseComputeData {
  h3_index: string
  h3_center: [number, number]
  elevation_m: number
  total_lden: number | null
  total_lden_free: number | null
  sources: SourceSummary[]
  top_contributors: Contributor[]
  other_sources_lden: number | null
  compute_time_ms: number
  segments?: SegmentTrace[]
  segments_meta?: SegmentTracesSummary | null
}

// Per-segment traces — popup "view into the engine's guts". Mirrors
// `engine/noise-compute/src/types.rs::SegmentTrace`. Aircraft sub-types
// (ground path / airborne sub-segment / cruise R8 hex) are split via
// `SegmentTrace.aircraft_subtype`; SegmentKind below is the UI-side
// dispatch label.

export type SegmentKind =
  | 'road'
  | 'railway'
  | 'aircraft_ground'
  | 'aircraft_airborne'
  | 'aircraft_cruise'
  | 'building'
  | 'industrial'

export interface PerPeriod<T> {
  day: T
  evening: T
  night: T
}

export interface LdenVariants {
  full: number
  /** Divergence + atmospheric + ground only, no path effects. */
  free_field: number
  no_terrain: number
  no_screening: number
  no_vegetation: number
  /** Signed: soft ground at 63/125 Hz has CF[i] < 0, so `no_ground < full`
   * is possible (ground boosts LF there). */
  no_ground: number
  no_atmospheric: number
}

export interface ForestRun {
  t_start: number
  t_end: number
  len_m: number
}

export interface PathProfileTrace {
  t: number[]
  elevation_m: number[]
  building_h_m: number[]
  forest_u8: number[]
  imd_u8: number[]
  dist_m: number
  step_m_med: number
  src_lat: number
  src_lon: number
  rcv_lat: number
  rcv_lon: number
  src_alt_m: number
  rcv_alt_m: number
}

export interface BaselineTrace {
  geometric_db: number
  atmospheric_bands: number[]
  ground_factor_g: number
  source_height_m: number
  finite_line_corr_db: number
  /** Urban reflection boost (ISO 9613-2 §7.5 / CNOSSOS-EU §2.5.18),
   *  clamped 0..5 dB. Per-receiver scalar — same for every segment. */
  reflection_boost_db: number
}

export interface TerrainTrace {
  delta_m: number
  /** Back-compat flag: true for 2 OR 3 edges. UI should read `n_edges`
   * for the exact count (single / double / triple). */
  is_double: boolean
  attenuation_bands: number[]
  /** Number of diffraction edges (0, 1, 2, or 3). */
  n_edges: number
  /** Edge vertices from the upper-convex-hull algorithm. Length == n_edges. */
  edges: EdgePoint[]
  /** CNOSSOS §2.5.6(c) Rayleigh δ* — path difference over the dominant edge
   * with mirror source/receiver across the bare-earth mean-ground planes.
   * Zero when there is no obstruction. Feeds the per-band `δ ≤ λ/4 − δ*` gate. */
  delta_star_m: number
  /** First-to-last edge distance |E₁→Eₙ| (metres) — feeds CNOSSOS C₃.
   * Zero for single-edge or no-edge results. */
  edge_distance_m: number
  /** Index into `edges` of the edge with max LOS excess. 0 when n_edges == 0. */
  dominant_edge_idx: number
}

export interface ScreeningTrace {
  attenuation_bands: number[]
  obstacle: ScreeningObstacleTrace | null
}

export interface VegetationTrace {
  forest_depth_m: number
  sampled_path_m: number
  attenuation_bands: number[]
  forest_runs: ForestRun[]
}

export interface GroundTrace {
  factor_g: number
  attenuation_bands: number[]
}

export type EmissionTrace =
  | {
      kind: 'road'
      aadt_light: number
      aadt_medium: number
      aadt_heavy: number
      aadt_moto: number
      speed_kmh: number
      surface_corr_db: number
      surface: string
      traffic_source: 'matched_external' | 'estimated_service_tree' | 'default_by_class'
      dataset_id: number
      provenance?: DatasetProvenance | null
      road_class: string
      bridge: boolean
      tunnel: boolean
      oneway: boolean
      lanes: number
    }
  | {
      kind: 'railway'
      trains_passenger: number
      trains_freight: number
      trains_passenger_source: 'arrow' | 'default_by_type'
      trains_freight_source: 'arrow' | 'default_by_type'
      dataset_id: number
      provenance?: DatasetProvenance | null
      speed_kmh: number
      bridge: boolean
      highspeed: boolean
      rail_type: string
      service: boolean
    }
  | {
      kind: 'aircraft_ground'
      class: 'runway' | 'taxi' | 'apron'
      /** Unique flight rotations / day that touched THIS microsegment.
       * Derived from `union(row.flight_ids) / n_days` across all rows
       * sharing `(osm_id, segment_idx)`. Includes arrivals + departures
       * + GSE; the three counts below break it down. */
      observed_movements: number | null
      /** Reserved for schedule-synth (Eurocontrol DDR2 / OAG); zero
       * today because the synth driver is scaffolded but not running. */
      modeled_movements: number | null
      // Fields below are optional in the type to survive a stale
      // server JSON cached without them; the renderer defaults to 0
      // / empty when absent.
      /** Runway-roll arrivals on this microsegment / day. */
      arrivals_per_day?: number
      /** Runway-roll departures on this microsegment / day (carry the
       * +2 dB Doc 29 takeoff bonus in their band_energy). */
      departures_per_day?: number
      /** GSE movements per GSE class (LIGHT / MEDIUM / HEAVY) / day. */
      gse_per_day?: [number, number, number]
      /** Top aircraft classes by energy share at THIS microsegment.
       * Same shape as AircraftGroundOpsDetail.profile_mix (airport-
       * aggregate) so the popup can reuse one renderer. */
      class_mix?: ProfileMixEntry[]
      /** OSM aeroway `ref` tag (e.g. "06/24" for runway "06/24"); null
       * for synth strips and OSM ways without a `ref`. */
      osm_ref?: string | null
    }
  | {
      kind: 'aircraft_airborne'
      class: string
      callsign: string
      aircraft_type: string
      cpa_distance_m: number
      altitude_m_at_cpa: number
      /** Empty for synthetic (anonymous-transponder) fids. */
      icao_hex: string
      /** Flight start (Unix s); `null` for synthetic. UI derives the
       *  YYYY-MM-DD date for the globe.adsb.lol trace deep-link. */
      start_unix: number | null
    }
  | {
      kind: 'aircraft_cruise'
      r8_hex: string
      n_unique_flights: number
      rep_alt_m: number
    }
  | {
      kind: 'building'
      building_type: string
      height_m: number
      floors: number
      area_m2: number
    }
  | {
      kind: 'industrial'
      source_type: string
      area_m2: number
      nace: string | null
      hub_height_m: number | null
      rated_power_kw: number | null
      effective_area_source_dist_m: number
    }

/** One bucket inside a cruise R8 hex aggregate trace. */
export interface CruiseBucketBreakdown {
  class: number
  fl_bin: number
  period: number
  is_dep: boolean
  n_flights: number
  received_lden: number
}

export interface SegmentTrace {
  /**
   * Engine SourceKind. Aircraft splits further via `aircraft_subtype`:
   * 1 = ground path, 2 = airborne sub-segment, 3 = cruise R8 hex.
   * UI dispatch helper is `traceKind()` in `SegmentList`.
   */
  kind: 'road' | 'railway' | 'building' | 'industrial' | 'aircraft'
  osm_id: number | null
  segment_idx: number
  name: string
  subtype: string
  is_dominant_of_group: boolean
  start_lat: number
  start_lon: number
  end_lat: number
  end_lon: number
  cp_lat: number
  cp_lon: number
  length_m: number
  dist_m: number
  d_slant_m: number
  bridge: boolean
  tunnel: boolean
  emission: EmissionTrace
  // Band entries are null for periods with no emission (e.g. runway segments
  // where day/evening had no observed traffic — see fmtDb / bandsTooltip).
  lw_bands: PerPeriod<(number | null)[]>
  lw_db_a: PerPeriod<number>
  baseline: BaselineTrace
  path_profile: PathProfileTrace
  terrain: TerrainTrace
  screening: ScreeningTrace
  vegetation: VegetationTrace
  ground: GroundTrace
  received_bands: PerPeriod<number[]>
  /**
   * Per-segment Lden contribution (energy-summing across all visible
   * segments approaches the source-aggregate Lden for that layer, modulo
   * the segment top-K cap). Same semantics across road / rail /
   * buildings / industrial / aircraft (ground / airborne / cruise) — the
   * `full` slot is what the popup row displays; `free_field` /
   * `no_terrain` / `no_screening` / `no_vegetation` only meaningful for
   * road / rail / buildings / industrial / aircraft ground (path-effect
   * variants), zero for airborne / cruise.
   */
  received_lden: LdenVariants
  /** 0 = non-aircraft / unset, 1 = ground path, 2 = airborne sub-segment, 3 = cruise hex. */
  aircraft_subtype?: number
  /** Polyline of `[lat, lon]` pairs; aircraft ground paths only. */
  polyline?: [number, number][]
  /** Closed polygon ring (last vertex = first vertex); aircraft cruise hexes only. */
  hex_polygon?: [number, number][]
  /** Per-bucket breakdown inside a cruise hex; sorted by `received_lden` desc. */
  cruise_buckets?: CruiseBucketBreakdown[]
  /** Top contributing flights inside a cruise hex (peak Lmax desc, ≤5 entries). */
  cruise_top_flights?: CruiseHexTopFlight[]
  /** Ground path `[runway, taxi, apron]` lengths in meters. */
  length_m_per_kind?: [number, number, number]
}

/** Per-kind segment counts. `*_count` is what the response includes
 * (after the per-kind top-K cap); `*_total` is how many were actually
 * computed and folded into Lden. Frontends render the pair as
 * "shown / total" so users see how aggressively the response was
 * truncated; Lden values themselves always reflect the full set.
 *
 * Aircraft splits into three sub-buckets: ground path / airborne
 * sub-segment / cruise R8 hex. Each is capped separately by the
 * backend so a busy airport doesn't drown one tab in another's
 * truncation; the popup renders three sub-tabs keyed off these
 * counters directly. */
export interface SegmentTracesSummary {
  total_count: number
  truncated: boolean
  road_count: number
  railway_count: number
  aircraft_ground_count: number
  aircraft_airborne_count: number
  aircraft_cruise_count: number
  building_count: number
  industrial_count: number
  road_total: number
  railway_total: number
  aircraft_ground_total: number
  aircraft_airborne_total: number
  aircraft_cruise_total: number
  building_total: number
  industrial_total: number
}

/**
 * Aircraft sub-type discriminator on `SegmentTrace.aircraft_subtype`.
 * Mirrors the `u8` values the backend stamps on each aircraft trace.
 * Use this constant in switches instead of bare `1`/`2`/`3` so the
 * dispatch sites stay in sync if the wire schema renumbers.
 */
export const AIRCRAFT_SUBTYPE = {
  GROUND: 1,
  AIRBORNE: 2,
  CRUISE: 3,
} as const
