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
  ld_db: number
  le_db: number
  ln_db: number
  lden_db: number
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
  height_m: number
  t: number
  screen_h_m: number
  delta_m: number
  samples_taken: number
  step_m: number
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
  energy_pct: number
  geometry: [[number, number], [number, number]]
}

export interface AircraftAirborneDetail {
  periods: NoisePeriodsData
  observed_flights_per_day: number
  helicopter_flights_per_day: number
  lmax_peak: number | null
  faint: AircraftEventBandStats
  audible: AircraftEventBandStats
  disruptive: AircraftEventBandStats
  top_flights?: AircraftTopFlight[]
}

export interface AircraftGroundOpsClassDetail {
  periods: NoisePeriodsData
  observed_movements_per_day: number
  modeled_movements_per_day: number
}

export interface AircraftGroundOpsDetail {
  periods: NoisePeriodsData
  periods_free: NoisePeriodsData
  observed_movements_per_day: number
  modeled_movements_per_day: number
  distance_m: number
  emission_db: number
  received_bands: number[]
  runway_roll: AircraftGroundOpsClassDetail
  taxi: AircraftGroundOpsClassDetail
  apron_movement: AircraftGroundOpsClassDetail
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
  airborne_traces?: AirborneTrace[]
  segments_meta?: SegmentTracesSummary | null
}

// Per-segment traces — popup "view into the engine's guts". Mirrors
// `engine/noise-compute/src/types.rs` (SegmentTrace, AirborneTrace, …).

export type SegmentKind =
  | 'road'
  | 'railway'
  | 'aircraft_ground'
  | 'aircraft_airborne'
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
}

export interface TerrainTrace {
  delta_m: number
  is_double: boolean
  attenuation_bands: number[]
  attenuation_db_a: number
  edge_apex_t: number | null
  edge_apex_elev_m: number | null
}

export interface ScreeningTrace {
  attenuation_bands: number[]
  attenuation_db_a: number
  obstacle: ScreeningObstacleTrace | null
}

export interface VegetationTrace {
  forest_depth_m: number
  sampled_path_m: number
  attenuation_bands: number[]
  attenuation_db_a: number
  forest_runs: ForestRun[]
}

export interface GroundTrace {
  factor_g: number
  attenuation_bands: number[]
  attenuation_db_a: number
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
      speed_kmh: number
      bridge: boolean
      highspeed: boolean
      rail_type: string
      service: boolean
    }
  | {
      kind: 'aircraft_ground'
      class: 'runway' | 'taxi' | 'apron'
      observed_movements: number
      modeled_movements: number
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

export interface SegmentTrace {
  /**
   * Engine SourceKind. `'aircraft'` here is ground ops only — airborne
   * aircraft are emitted via `AirborneTrace` with Doc 29 primitives. The UI
   * splits these into `SegmentKind = 'aircraft_ground' | 'aircraft_airborne'`
   * via `traceKind()` in SegmentList.
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
  lw_bands: PerPeriod<number[]>
  lw_db_a: PerPeriod<number>
  baseline: BaselineTrace
  path_profile: PathProfileTrace
  terrain: TerrainTrace
  screening: ScreeningTrace
  vegetation: VegetationTrace
  ground: GroundTrace
  received_bands: PerPeriod<number[]>
  received_lden: LdenVariants
}

export interface AirborneTrace {
  flight_id: number
  date: string
  period: 0 | 1 | 2
  profile: string
  lmax_db: number
  sel_db: number
  cpa_distance_m: number
  altitude_m_at_cpa: number
  elevation_angle_deg: number
  n_days_normalized: number
  geometry: [[number, number], [number, number]]
  received_lden: number
}

export interface SegmentTracesSummary {
  total_count: number
  truncated: boolean
  road_count: number
  railway_count: number
  aircraft_ground_count: number
  aircraft_airborne_count: number
  building_count: number
  industrial_count: number
}
