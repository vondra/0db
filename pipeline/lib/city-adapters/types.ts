/** Normalized output of a city adapter — one record per street (or street
 *  section where the source carries geometry). The driver matches records to
 *  arrow rows by normalized street name (and `osmId` where the source
 *  publishes it — e.g. Montpellier), inside the city polygon. */
export interface CityRecord {
  /** Street name as published; the driver normalizes for matching. */
  street: string
  /** CNOSSOS buckets, whole street, both directions, per day. */
  aadtLight: number
  aadtMedium: number
  aadtHeavy: number
  aadtMoto: number
  /** Direct OSM way join key when the source publishes it. */
  osmId?: number
}
