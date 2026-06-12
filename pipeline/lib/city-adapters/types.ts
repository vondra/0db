/** Normalized output of a city adapter — one record per street (or street
 *  section where the source carries geometry). The driver matches records to
 *  arrow rows by normalized street name (and `osmId` where the source
 *  publishes it — e.g. Montpellier), inside the city polygon. Records that
 *  carry `line` are matched by proximity instead (see below). */
export interface CityRecord {
  /** Street name as published; the driver normalizes for matching.
   *  For geometry records this is a display label only (station/segment
   *  names like "Reichsbrücke" are landmarks, not OSM street names). */
  street: string
  /** CNOSSOS buckets, whole street, both directions, per day. */
  aadtLight: number
  aadtMedium: number
  aadtHeavy: number
  aadtMoto: number
  /** Direct OSM way join key when the source publishes it. */
  osmId?: number
  /** Geometry for proximity matching, `[lon, lat]` vertices (GeoJSON-native
   *  order, same as `pointToPolylineDist`). One vertex = a point counting
   *  station (Wien); 2+ = the counted section's polyline (Brno). When set,
   *  the record matches rows by distance ONLY — never by name, because
   *  station labels collide with unrelated same-named OSM ways. */
  line?: ReadonlyArray<readonly [number, number]>
}
