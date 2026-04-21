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
  geometric_db: number
  atmospheric_db: number
  ground_factor: number
  ground_db: number
  total_db: number
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
  attenuation_db: number
  profile_points: number
}

export interface ScreeningBreakdownData {
  building_path_m: number
  attenuation_db: number
  obstacle: ScreeningObstacleTrace | null
}

export interface VegetationBreakdownData {
  forest_depth_m: number
  attenuation_db: number
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
  terrain: { delta_m: number; is_double: boolean; attenuation_db: number; profile_points: number }
  screening: { building_path_m: number; attenuation_db: number; obstacle: ScreeningObstacleTrace | null }
  vegetation: { forest_depth_m: number; attenuation_db: number; sampled_path_m: number }
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
}
