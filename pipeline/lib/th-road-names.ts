/**
 * Thai from-to road-name matching (M6, TH pilot of the worldwide from-to
 * matcher; plan v3.2 §3 ladder level 2 "from-to/identity names").
 *
 * The DRR 2024 rural-road census (`enrich-roads-th.ts`) names each road by
 * its endpoints — `บ้านX - บ้านY` (village-to-village) or
 * `แยกทางหลวงหมายเลข N (กม.ที่ K) - บ้านY` (highway junction to village) —
 * while OSM tags the same corridors `ถนนX-Y`. OSM `ref` coverage is sparse
 * (Koh Phangan: 436 no-ref secondary vs 290 with ref), so exact-ref matching
 * leaves measured rows unjoined. This lib is the name layer on top:
 *
 *   match(OSM name) = the UNIQUE census row whose endpoint place-set shares
 *   ≥ 2 places with the OSM name's place-set, gated by
 *     (a) province extent — road_code prefix (สฎ., กจ., …) located by the
 *         robust bbox of OSM segments carrying that exact ref prefix (the
 *         province gate is DATA-DERIVED, not a hand table: 77 of 78 census
 *         prefixes have ref coverage; the 78th, ส. = Bangkok bridges, is
 *         name-unmatchable anyway). A mis-tagged ref can only widen an
 *         extent, so the gate fails safe (looser), never wrong-side;
 *     (b) class rank — DRR 1xxx–5xxx rows ↔ OSM primary/secondary/tertiary
 *         (2,3,4), 6xxx/7xxx minor rural rows ↔ secondary/tertiary (3,4)
 *         only; never residential/living/service/track/unclassified/links;
 *     (c) uniqueness — >1 census row candidate for a segment ⇒ NO match
 *         (logged, counted): ambiguity is a miss, never a guess.
 *
 * Name-pair match is REQUIRED (plan: "keep it simple: name-pair match is
 * required; geometry is a tiebreak/confirmation only"). The single-endpoint
 * + geometry alternative in the task spec is NOT implementable tonight:
 * no OSM place nodes exist in the hex layers (buildings/leisure carry venue
 * names, not settlements), so the census corridor's other endpoint has no
 * determinable position. Documented consequence: Koh Phangan's
 * ถนนท้องศาลา-บ้านค่าย corridor shares only one place (ท้องศาลา) with census
 * row สฎ.6038 and zero places with its true row สฎ.6064 (บ้านใต้ - หาดริ้น),
 * so the corridor stays unmatched — a recall miss, never a false claim.
 *
 * Thai normalization choices (all documented per /gg "no silent fold"):
 *   - ำ (U+0E33) unified from its ํ+า (U+0E4D U+0E32) two-codepoint form —
 *     OSM and government CSVs disagree on this encoding;
 *   - tone marks (U+0E48–0E4B) and thanthakhat (U+0E4C) stripped — OSM
 *     frequently drops/mistypes them (หาดริ้น vs หาดริน);
 *   - ณ folded to น — official-vs-common spelling variants (พระณ/น…);
 *   - ล folded to ร — the common ร/ล swap in colloquial spelling
 *     (โฉลก↔โฉรก). This CAN merge distinct names that differ only in ล/ร;
 *     accepted: equality stays symmetric both sides, and the uniqueness
 *     rule (c) discards collisions instead of guessing;
 *   - all whitespace removed (บ้านน้ำย้อย vs บ้านน้ำ ย้อย) and case folded
 *     (Latin names).
 *
 * One LEADING structural type word is stripped per side (บ้าน, หาด, วัด, …)
 * so บ้านท้องศาลา ≡ ท้องศาลา. Interior words are never touched: บ้านทุ่งทอง
 * and บ้านทอง stay distinct. Trailing digits survive (ซอยบ้านแหลม 4 ≠
 * บ้านแหลม) — a numbered side street must not inherit the main road's count.
 */

// ── Normalization ────────────────────────────────────────────────────────

/** Thai tone marks + thanthakhat (U+0E48 MAI EK .. U+0E4C THANTHAKHAT). */
const TONE_MARKS = /[่-์]/g
/** ํ (U+0E4D NIKHAHIT) + า (U+0E32 SARA AA) → precomposed ำ (U+0E33 SARA AM). */
const SARA_AM_DECOMPOSED = /ํา/g

export function normalizeThaiPlace(s: string): string {
  return s
    // Tone marks FIRST: น + NIKHAHIT + tone + า must not leave a dangling
    // NIKHAHIT that the compose below then misses (/gg M6 #9 — the commoner
    // order merges "นํา" and "นำ" as intended).
    .replace(TONE_MARKS, '')
    .replace(SARA_AM_DECOMPOSED, 'ำ')
    .replace(/ณ/g, 'น')
    .replace(/ล/g, 'ร')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** Structural leading type words, longest-first so หมู่บ้าน beats บ้าน. */
const PLACE_TYPE_PREFIXES = [
  'อ่างเก็บน้ำ',
  'ท่าอากาศยาน',
  'หน้าอำเภอ',
  'สนามบิน',
  'โรงเรียน',
  'หมู่บ้าน',
  'น้ำตก',
  'ท่าเรือ',
  'สถานี',
  'สะพาน',
  'ทางแยก',
  'สามแยก',
  'สี่แยก',
  'เขื่อน',
  'ตลาด',
  'เมือง',
  'บ้าน',
  'หมู่',
  'หาด',
  'อ่าว',
  'แหลม',
  'เกาะ',
  'วัด',
  'แยก',
  'ถนน',
  'ทาง',
  'สาย',
] as const

/** Strip leading structural type words (never interior words). At most TWO
 *  strips, and the second round only fires for junction/road words — that
 *  covers แยก+ถนน ("แยกถนนพัฒนาการคูขวาง" → "พัฒนาการคูขวาง") without
 *  eating name-integral words (บ้านแหลม must NOT become 4-less "…", and
 *  บ้านหาดเฉวง ≠ หาดเฉวง: the village and the beach are different places).
 *  Interior words like ทุ่ง in บ้านทุ่งทอง always stay. */
const SECOND_STRIP_PREFIXES = new Set(['แยก', 'ถนน', 'ทาง', 'สาย'])
export function stripPlacePrefix(side: string): string {
  let s = side
  for (let round = 0; round < 2; round++) {
    let stripped = false
    for (const p of PLACE_TYPE_PREFIXES) {
      if (round === 1 && !SECOND_STRIP_PREFIXES.has(p)) continue
      if (s.startsWith(p) && s.length > p.length) {
        s = s.slice(p.length)
        stripped = true
        break
      }
    }
    if (!stripped) break
  }
  // One route-word + one settlement-word after any earlier strip: the
  // commonest OSM TH shape ถนนสายบ้านX ("route X") — the census writes the
  // same place as บ้านX → X. Never more than one of each, never from a bare
  // place name (บ้านทุ่งทอง ≠ ทุ่งทอง — the village and the plain are
  // different places).
  if (side !== s) {
    if (s.startsWith('สาย') && s.length > 3) s = s.slice(3)
    for (const p of ['บ้าน', 'หาด', 'เมือง']) {
      if (s.startsWith(p) && s.length > p.length) {
        s = s.slice(p.length)
        break
      }
    }
  }
  return s
}

/** A usable place token: ≥2 normalized chars and at least one letter.
 *  (Ban Tai ใต้ → ใต is 2 base chars once the tone mark is stripped; 2-char
 *  tokens are safe here because a match still needs the whole PAIR to
 *  co-occur, inside one province extent, uniquely.) */
function usablePlace(norm: string): boolean {
  return norm.length >= 2 && /[a-z\u0E01-\u0E5B]/.test(norm)
}

const PARENS = /\([^)]*\)/g
const SIDE_SPLIT = /\s*[-–—/]+\s*/

/**
 * Census `road_name` → endpoint place-set. Returns an empty set for rows the
 * name layer cannot speak for: highway-junction designations
 * (`แยกทางหลวงหมายเลข N (กม.ที่ K) - …` — the junction side is a km-post
 * reference, not a gazetteer place), line designations (`สาย ก (ง) ผังเมือง…`),
 * and single-endpoint names (`แยกน้ำตกธารเสด็จ`) — a pair needs ≥2 places.
 */
export function extractCensusPlaces(roadName: string): Set<string> {
  const cleaned = roadName.replace(PARENS, ' ').replace(/[\r\n\t]+/g, ' ')
  const out = new Set<string>()
  for (const rawSide of cleaned.split(SIDE_SPLIT)) {
    // A highway-junction reference trailing inside a side is never part of
    // the place: "ถนนอุทุมพร แยกทางหลวงชนบท ชพ.5056 (กม.…)" → "ถนนอุทุมพร".
    const side = rawSide
      .replace(/\s*(แยก|ทางแยก|สามแยก|สี่แยก)\s*ทางหลวง.*$/, '')
      .trim()
    if (!side) continue
    // Junction-with-highway side: "แยกทางหลวงหมายเลข 324 (กม.…) ",
    // "แยกทางหลวงชนบท สฎ.2007", "แยกทางหลวงแผ่นดิน …" — not a place.
    if (/^(แยก|ทางแยก|สามแยก|สี่แยก)?\s*ทางหลวง/.test(side)) continue
    // Line designation: "สาย ก (ง) ผังเมืองรวม…", "สาย 2 ฝั่งขวา" — not a place.
    if (/^สาย(\s|$)/.test(side)) continue
    // A bare type word carries no place ("หน้าอำเภอ" = "district office front").
    if ((PLACE_TYPE_PREFIXES as readonly string[]).includes(side)) continue
    const norm = normalizeThaiPlace(stripPlacePrefix(side))
    if (usablePlace(norm)) out.add(norm)
  }
  return out
}

const OSM_ROAD_PREFIX = /^(ถนน|ทางหลวงหมายเลข\s*\d+|ทางหลวง|ถ\.|ซอย|ซ\.|ตรอก|thanon|soi|road to|road|rd)\s*/i

/** OSM road `name` → place-set (`ถนนท้องศาลา-บ้านค่าย` → {ท้องศาลา, ค่าย}). */
export function extractOsmPlaces(name: string): Set<string> {
  const cleaned = name.replace(PARENS, ' ').replace(OSM_ROAD_PREFIX, '')
  const out = new Set<string>()
  for (const rawSide of cleaned.split(SIDE_SPLIT)) {
    const side = rawSide.trim()
    if (!side) continue
    const norm = normalizeThaiPlace(stripPlacePrefix(side))
    if (usablePlace(norm)) out.add(norm)
  }
  return out
}

// ── Census rows ──────────────────────────────────────────────────────────

/** One DRR census row with its CNOSSOS split and endpoint place-set. */
export interface DrrCensusRow {
  code: string // e.g. สฎ.6064
  prefix: string // e.g. สฎ (province abbreviation)
  num: number // e.g. 6064
  name: string
  light: number
  medium: number
  heavy: number
  moto: number
  total: number
  places: Set<string>
}

/**
 * DRR per-class columns → CNOSSOS categories. MUST stay aligned with
 * `enrich-roads-th.ts::drrToCnossos` (duplicated by design: the per-country
 * loader stays per-country; the ref enricher is frozen tonight):
 *   light = SV+SVT (cars + trailers), medium = TB2+BD+DRT (2-axle trucks,
 *   buses, minor), heavy = TB3+T4+ART3-6 (3+ axle), moto = MC.
 */
export function drrRowSplit(r: Record<string, string>): { light: number; medium: number; heavy: number; moto: number } {
  const n = (k: string): number => parseFloat(r[k] || '0') || 0
  return {
    light: Math.round(n('SV') + n('SVT')),
    medium: Math.round(n('TB2') + n('BD') + n('DRT')),
    heavy: Math.round(n('TB3') + n('T4') + n('ART3') + n('ART4') + n('ART5') + n('ART6')),
    moto: Math.round(n('MC')),
  }
}

/**
 * Build census rows from parsed CSV records. Rows are kept only when they
 * carry a usable per-class split (same rule as the ref enricher: a positive
 * sum_AADT with all-blank class columns is a loader/join failure shape, not
 * data) — and, for the name layer, when they have ≥2 endpoint places.
 */
export function buildCensusRows(records: Record<string, string>[]): {
  rows: DrrCensusRow[]
  noSplit: number
  noPlaces: number
} {
  const rows: DrrCensusRow[] = []
  let noSplit = 0
  let noPlaces = 0
  for (const r of records) {
    const code = (r['road_code'] || '').trim()
    const dot = code.lastIndexOf('.')
    if (dot <= 0) continue
    const numStr = code.slice(dot + 1)
    if (!/^\d+$/.test(numStr)) continue
    const total = parseFloat(r['sum_AADT'] || '0')
    if (!isFinite(total) || total <= 0) continue
    const split = drrRowSplit(r)
    if (split.light + split.medium + split.heavy + split.moto === 0) {
      noSplit++
      continue
    }
    const name = (r['road_name'] || '').trim()
    const places = extractCensusPlaces(name)
    if (places.size < 2) {
      noPlaces++
      continue
    }
    rows.push({
      code,
      prefix: code.slice(0, dot),
      num: parseInt(numStr, 10),
      name,
      ...split,
      total,
      places,
    })
  }
  return { rows, noSplit, noPlaces }
}

// ── Class-rank gate ──────────────────────────────────────────────────────

/**
 * DRR road-number → allowed OSM road_class codes (engine inputs.rs:
 * 0 motorway … 4 tertiary, 5+ local). DRR rural roads are never motorway/
 * trunk and never residential/living/service/track/unclassified/link:
 *   1xxx–5xxx (major rural collectors) → primary/secondary/tertiary (2,3,4)
 *   6xxx/7xxx (minor rural roads)       → secondary/tertiary (3,4) only
 * Anything else (ส.0xx Bangkok bridges, 3-digit codes) is not class-mapped.
 */
export function classCompatible(censusNum: number, osmClass: number): boolean {
  if (censusNum >= 1000 && censusNum <= 5999) return osmClass >= 2 && osmClass <= 4
  if (censusNum >= 6000 && censusNum <= 7999) return osmClass >= 3 && osmClass <= 4
  return false
}

// ── Province extents (data-derived province gate) ────────────────────────

export type Extent = readonly [minLat: number, minLon: number, maxLat: number, maxLon: number]

const EXTENT_MEDIAN_WINDOW_DEG = 0.9 // half-window around the median; Thai provinces span ≤ ~1.6°
const EXTENT_BUFFER_DEG = 0.1 // ~11 km slack for province-edge corridors

/**
 * Robust bbox per road_code prefix from the midpoints of OSM segments
 * carrying that exact ref prefix. A single mis-tagged ref far outside the
 * province must not blow the gate open, so for n ≥ 8 points the extent is
 * computed from the in-window subset only (median ± 0.9°), then padded.
 */
export function buildPrefixExtents(points: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>): Map<string, Extent> {
  const out = new Map<string, Extent>()
  for (const [prefix, pts] of points) {
    if (pts.length === 0) continue
    let kept = pts
    if (pts.length >= 8) {
      const lats = pts.map(p => p[0]).sort((a, b) => a - b)
      const lons = pts.map(p => p[1]).sort((a, b) => a - b)
      const mLa = lats[Math.floor(lats.length / 2)]
      const mLo = lons[Math.floor(lons.length / 2)]
      const inWindow = pts.filter(
        p => Math.abs(p[0] - mLa) <= EXTENT_MEDIAN_WINDOW_DEG && Math.abs(p[1] - mLo) <= EXTENT_MEDIAN_WINDOW_DEG,
      )
      if (inWindow.length > 0) kept = inWindow
    }
    let minLa = Infinity, minLo = Infinity, maxLa = -Infinity, maxLo = -Infinity
    for (const [la, lo] of kept) {
      if (la < minLa) minLa = la
      if (lo < minLo) minLo = lo
      if (la > maxLa) maxLa = la
      if (lo > maxLo) maxLo = lo
    }
    out.set(prefix, [
      minLa - EXTENT_BUFFER_DEG,
      minLo - EXTENT_BUFFER_DEG,
      maxLa + EXTENT_BUFFER_DEG,
      maxLo + EXTENT_BUFFER_DEG,
    ])
  }
  return out
}

export function inExtent(lat: number, lon: number, e: Extent): boolean {
  return lat >= e[0] && lat <= e[2] && lon >= e[1] && lon <= e[3]
}

// ── The matcher ──────────────────────────────────────────────────────────

export type NameMatch =
  | { status: 'match'; row: DrrCensusRow }
  | { status: 'ambiguous'; codes: string[] }
  | { status: 'none' }

/** Inverted index: normalized place token → census rows containing it. */
export function buildPlaceIndex(rows: readonly DrrCensusRow[]): Map<string, DrrCensusRow[]> {
  const idx = new Map<string, DrrCensusRow[]>()
  for (const row of rows) {
    for (const p of row.places) {
      const arr = idx.get(p)
      if (arr) arr.push(row)
      else idx.set(p, [row])
    }
  }
  return idx
}

/**
 * Match one segment (by its OSM name place-set, class and midpoint) against
 * the census. Unique surviving candidate ⇒ match; >1 ⇒ ambiguous (the
 * caller logs + counts, and the segment gets NOTHING); 0 ⇒ none.
 */
export function matchByName(
  osmPlaces: ReadonlySet<string>,
  osmClass: number,
  midLat: number,
  midLon: number,
  placeIndex: ReadonlyMap<string, readonly DrrCensusRow[]>,
  extents: ReadonlyMap<string, Extent>,
): NameMatch {
  if (osmPlaces.size < 2) return { status: 'none' }
  const shared = new Map<DrrCensusRow, number>()
  for (const p of osmPlaces) {
    const rows = placeIndex.get(p)
    if (!rows) continue
    for (const row of rows) shared.set(row, (shared.get(row) ?? 0) + 1)
  }
  const candidates: DrrCensusRow[] = []
  for (const [row, n] of shared) {
    if (n < 2) continue
    if (!classCompatible(row.num, osmClass)) continue
    const ext = extents.get(row.prefix)
    if (!ext || !inExtent(midLat, midLon, ext)) continue
    candidates.push(row)
  }
  if (candidates.length === 0) return { status: 'none' }
  if (candidates.length > 1) return { status: 'ambiguous', codes: candidates.map(r => r.code) }
  return { status: 'match', row: candidates[0] }
}
