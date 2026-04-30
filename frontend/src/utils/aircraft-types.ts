/**
 * Aircraft typecode display helpers.
 *
 * The popup must be a FAITHFUL view of what's in the data. We compress long
 * strings to fit columns but never hide the underlying value — tooltips
 * expose the full string and explain how it's produced.
 *
 * Backend popup payload:
 *   • `top_aircraft` (per band) = noise-class label, e.g. "WING_B738",
 *     "HELICOPTER", "WING_FALLBACK". Source:
 *     `engine/noise-compute/src/emission/profiles_generated.rs`
 *     `CLASS_NAMES[noise_class_of(top_profile_idx)]`.
 *   • `top_flights[].profile` = `Profile.name` string built by the generator
 *     (`scripts/build-aircraft-profiles.py`) as `f"{typecode}/{acft.acft_id}"`.
 *     `typecode` = ICAO Doc 8643 4-letter; `acft_id` = EASA ANP database ID.
 *     Special case: `FALLBACK/737800` — typecode "FALLBACK" was hand-curated
 *     against ANP's 737-800 row as a placeholder; `recompute_fallback_npd`
 *     later overwrites the NPD values to a traffic-weighted energy-mean of
 *     all 123 profiles, but the display string keeps the historical
 *     placeholder.
 */

/** Top ~50 ICAO typecodes → human aircraft model. Mapped subset for tooltip. */
const TYPECODE_MODEL: Record<string, string> = {
  // Boeing 737 family
  B737: 'Boeing 737-700', B738: 'Boeing 737-800', B739: 'Boeing 737-900',
  B734: 'Boeing 737-400', B735: 'Boeing 737-500', B733: 'Boeing 737-300',
  B736: 'Boeing 737-600',
  B38M: 'Boeing 737 MAX 8', B39M: 'Boeing 737 MAX 9', B37M: 'Boeing 737 MAX 7',
  // Airbus A320 family
  A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321',
  A19N: 'Airbus A319neo', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo',
  // Airbus A220
  BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300',
  // Boeing 757 / 767 / 777 / 787
  B752: 'Boeing 757-200', B753: 'Boeing 757-300',
  B763: 'Boeing 767-300', B764: 'Boeing 767-400',
  B772: 'Boeing 777-200', B773: 'Boeing 777-300',
  B77W: 'Boeing 777-300ER', B77L: 'Boeing 777-200LR', B77F: 'Boeing 777F',
  B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10',
  // Boeing 747
  B741: 'Boeing 747-100', B742: 'Boeing 747-200', B744: 'Boeing 747-400', B748: 'Boeing 747-8',
  // Airbus A330 / A340 / A350 / A380
  A332: 'Airbus A330-200', A333: 'Airbus A330-300',
  A338: 'Airbus A330-800neo', A339: 'Airbus A330-900neo',
  A342: 'Airbus A340-200', A343: 'Airbus A340-300', A346: 'Airbus A340-600',
  A359: 'Airbus A350-900', A35K: 'Airbus A350-1000',
  A306: 'Airbus A300-600', A310: 'Airbus A310', A388: 'Airbus A380-800',
  // McDonnell Douglas / others
  MD11: 'McDonnell Douglas MD-11', DC10: 'McDonnell Douglas DC-10',
  L101: 'Lockheed L-1011 TriStar', IL76: 'Ilyushin Il-76',
  // Embraer regional + business
  E170: 'Embraer 170', E190: 'Embraer 190', E195: 'Embraer 195',
  E290: 'Embraer E190-E2', E295: 'Embraer E195-E2',
  E75L: 'Embraer 175 (long wing)', E75S: 'Embraer 175 (short wing)',
  E135: 'Embraer ERJ-135', E145: 'Embraer ERJ-145',
  E55P: 'Embraer Phenom 300', E545: 'Embraer Legacy 450', E550: 'Embraer Legacy 500',
  E35L: 'Embraer Legacy 600/650',
  // Bombardier CRJ
  CRJ2: 'Bombardier CRJ-200', CRJ7: 'Bombardier CRJ-700', CRJ9: 'Bombardier CRJ-900',
  // Bombardier Challenger / Global / Learjet / Gulfstream
  CL30: 'Bombardier Challenger 300/350', CL35: 'Bombardier Challenger 350',
  CL60: 'Bombardier Challenger 600', CL64: 'Bombardier Challenger 650',
  GLEX: 'Bombardier Global Express', GLF5: 'Gulfstream G500', GLF6: 'Gulfstream G650',
  GL5T: 'Bombardier Global 5000', GL7T: 'Bombardier Global 7500',
  GLF4: 'Gulfstream G450', GLF7: 'Gulfstream G700',
  LJ45: 'Learjet 45', LJ60: 'Learjet 60',
  // Cessna piston singles
  C150: 'Cessna 150', C152: 'Cessna 152', C170: 'Cessna 170',
  C172: 'Cessna 172 Skyhawk', C177: 'Cessna 177 Cardinal',
  C180: 'Cessna 180', C182: 'Cessna 182 Skylane', C185: 'Cessna 185',
  // Cessna twin / turboprop / jets
  C208: 'Cessna 208 Caravan', C25A: 'Cessna Citation CJ1', C25B: 'Cessna Citation CJ2',
  C25C: 'Cessna Citation CJ4', C510: 'Cessna Citation Mustang',
  C525: 'Cessna CitationJet', C550: 'Cessna Citation II', C560: 'Cessna Citation V',
  C56X: 'Cessna Citation Excel/XLS', C68A: 'Cessna Citation Latitude',
  C700: 'Cessna Citation Longitude', C750: 'Cessna Citation X',
  C310: 'Cessna 310', C402: 'Cessna 402',
  // Piper
  P28A: 'Piper PA-28 Cherokee', P28B: 'Piper PA-28 Warrior', P28R: 'Piper PA-28R Arrow',
  P32R: 'Piper PA-32R Saratoga',
  PA24: 'Piper PA-24 Comanche', PA31: 'Piper PA-31 Navajo',
  PA46: 'Piper PA-46 Malibu',
  // Beechcraft
  BE20: 'Beech King Air 200', BE35: 'Beech V35 Bonanza', BE33: 'Beech 33 Bonanza',
  BE40: 'Beechjet 400', BE58: 'Beech Baron 58', BE95: 'Beech 95 Travel Air',
  BE9L: 'Beech 90 King Air',
  B190: 'Beech 1900', B350: 'Beech King Air 350',
  // Pilatus / TBM / SAAB
  PC12: 'Pilatus PC-12', TBM7: 'Daher TBM-700/850/900',
  SF34: 'Saab 340', SF50: 'Cirrus SF50 Vision Jet',
  // ATR / Dash
  AT72: 'ATR 72', AT75: 'ATR 72-500/600', AT76: 'ATR 72-600',
  DH8A: 'DHC-8-100 Dash 8', DH8C: 'DHC-8-300', DH8D: 'DHC-8-400',
  // Falcon / Hawker / 717
  F2TH: 'Dassault Falcon 2000', F900: 'Dassault Falcon 900',
  H25B: 'Hawker 800XP', B712: 'Boeing 717-200',
  // Cirrus / homebuilt / sport
  S22T: 'Cirrus SR22T', SR20: 'Cirrus SR20', SR22: 'Cirrus SR22',
  RV6: "Vans RV-6", RV9: "Vans RV-9", RV10: "Vans RV-10",
  RV12: "Vans RV-12", RV4: "Vans RV-4",
  // Helicopters
  EC35: 'Eurocopter EC135', EC30: 'Eurocopter EC130', EC75: 'Eurocopter EC175',
  EC55: 'Eurocopter EC155', EC45: 'Eurocopter EC145',
  H125: 'Airbus H125', H130: 'Airbus H130', H135: 'Airbus H135',
  H145: 'Airbus H145', H155: 'Airbus H155', H160: 'Airbus H160',
  H175: 'Airbus H175', H215: 'Airbus H215', H225: 'Airbus H225',
  A109: 'Leonardo A109', A119: 'Leonardo A119', A139: 'Leonardo AW139',
  A169: 'Leonardo AW169', A189: 'Leonardo AW189',
  R22: 'Robinson R22', R44: 'Robinson R44', R66: 'Robinson R66',
  B407: 'Bell 407', B412: 'Bell 412', B429: 'Bell 429', B505: 'Bell 505',
  S76: 'Sikorsky S-76', S92: 'Sikorsky S-92',
}

/**
 * Class label → anchor typecode (the typecode of the Voronoi anchor profile).
 * Used to compress band-row "Top type" cells. WING_B738 → "B738",
 * WING_FALLBACK → "FALLBACK", HELICOPTER → "HELI". Returns the input
 * unchanged when no class prefix matches.
 */
export function classToAnchorTypecode(className: string | null | undefined): string {
  if (!className) return '?'
  if (className === 'HELICOPTER') return 'HELI'
  const m = className.match(/^(?:WING|FUSE|PROP)_(.+)$/)
  return m ? m[1] : className
}

/**
 * Profile name → typecode. The string format `<typecode>/<acft_id>` is set
 * by `build_profiles` in `scripts/build-aircraft-profiles.py`. Returns the
 * full input unchanged if no slash is present.
 */
export function parseProfileName(profileName: string | null | undefined): string {
  if (!profileName) return '?'
  const idx = profileName.indexOf('/')
  return idx < 0 ? profileName : profileName.slice(0, idx)
}

/** ICAO typecode → human model name. Falls back to typecode itself for unknown entries. */
export function modelName(typecode: string): string {
  return TYPECODE_MODEL[typecode] ?? typecode
}

/**
 * Typecode → Voronoi noise-class label. Hand-mirrored from `CLASS_OF_PROFILE`
 * in `engine/noise-compute/src/emission/profiles_generated.rs`.
 *
 * MAINTENANCE HAZARD: any change to the Rust generator's class assignment
 * (Tier 3 EASA v9 supplement adds 14 typecodes; cluster_voronoi can re-map
 * existing ones) silently de-syncs this map until manually re-extracted.
 * Tier 3 backlog item: emit this table from `scripts/build-aircraft-profiles.py`
 * alongside the Rust output to make sync mechanical instead of manual.
 */
const PROFILE_CLASS: Record<string, string> = {
  B738: 'WING_B738', B739: 'WING_B738', B737: 'WING_FALLBACK',
  B734: 'WING_FALLBACK', B735: 'WING_FALLBACK', B733: 'WING_FALLBACK',
  B736: 'WING_FALLBACK', B38M: 'WING_B38M', B39M: 'WING_B38M', B37M: 'WING_B38M',
  A320: 'WING_A320', A20N: 'WING_A320', A319: 'WING_A319', A19N: 'WING_A319',
  BCS3: 'WING_A319', BCS1: 'WING_A319', A321: 'WING_A21N', A21N: 'WING_A21N',
  B752: 'WING_A320', B753: 'WING_A320', B772: 'WING_B789', B773: 'WING_B738',
  B77W: 'WING_FALLBACK', B77L: 'WING_B789', B77F: 'WING_B738',
  B788: 'WING_B789', B789: 'WING_B789', B78X: 'WING_B789',
  A332: 'WING_B738', A333: 'WING_FALLBACK', A338: 'WING_FALLBACK',
  A339: 'WING_FALLBACK', A359: 'WING_A320', A35K: 'WING_A320',
  A306: 'WING_B738', A310: 'WING_B738',
  B763: 'WING_B789', B764: 'WING_FALLBACK',
  MD11: 'WING_FALLBACK', DC10: 'WING_B789', L101: 'WING_B789',
  B744: 'WING_B789', B748: 'WING_B789', B741: 'WING_A21N', B742: 'WING_A21N',
  A342: 'WING_B789', A343: 'WING_B789', A346: 'WING_B789',
  A388: 'WING_FALLBACK', IL76: 'WING_A21N',
  E170: 'WING_A320', E75L: 'WING_A320', E75S: 'WING_A320',
  E190: 'WING_A320', E195: 'WING_A320', E290: 'WING_A320', E295: 'WING_A320',
  CRJ2: 'FUSE_CRJ9', CRJ7: 'FUSE_CRJ9', CRJ9: 'FUSE_CRJ9',
  EMJ: 'FUSE_CRJ9', CL60: 'FUSE_CRJ9',
  C56X: 'FUSE_C56X', C680: 'FUSE_C56X',
  GLEX: 'FUSE_CRJ9', GLF6: 'FUSE_CRJ9', GLF5: 'FUSE_CRJ9',
  FA7X: 'FUSE_CRJ9', PC24: 'FUSE_CRJ9', LJ60: 'FUSE_C56X',
  AT72: 'PROP_DH8D', AT76: 'PROP_DH8D', AT43: 'PROP_DH8D', AT45: 'PROP_DH8D',
  DH8D: 'PROP_DH8D', DH8C: 'PROP_DH8D', DH8A: 'PROP_DH8D', DH8B: 'PROP_DH8D',
  L410: 'PROP_DH8D', EN48: 'PROP_DH8D', SF34: 'PROP_DH8D', F50: 'PROP_DH8D',
  F70: 'FUSE_CRJ9', JS41: 'PROP_DH8D',
  C172: 'PROP_C172', C152: 'PROP_C172', C182: 'PROP_C172',
  PA28: 'PROP_C172', PA34: 'PROP_C172', SR20: 'PROP_C172', SR22: 'PROP_C172',
  DA40: 'PROP_C172', DA42: 'PROP_C172', P28A: 'PROP_C172',
  C210: 'PROP_C172', BE36: 'PROP_C172', M20P: 'PROP_C172',
  C206: 'PROP_C172', PA32: 'PROP_C172', PA44: 'PROP_C172',
  RV7: 'PROP_C172', RV8: 'PROP_C172',
  EC35: 'HELICOPTER', EC45: 'HELICOPTER', EC55: 'HELICOPTER',
  EC30: 'HELICOPTER', EC20: 'HELICOPTER',
  AS50: 'HELICOPTER', AS55: 'HELICOPTER', AS65: 'HELICOPTER',
  H500: 'HELICOPTER', MD52: 'HELICOPTER',
  B06: 'HELICOPTER', B407: 'HELICOPTER', B412: 'HELICOPTER',
  R22: 'HELICOPTER', R44: 'HELICOPTER', R66: 'HELICOPTER',
  S76: 'HELICOPTER', A109: 'HELICOPTER',
  BK17: 'HELICOPTER', B505: 'HELICOPTER', GYRO: 'HELICOPTER',
  FALLBACK: 'WING_FALLBACK',
}

/**
 * Class → anchor (typecode of the profile whose NPD curve the class uses).
 * For 11 of 12 classes the anchor is a real aircraft profile from EASA ANP;
 * `WING_FALLBACK` uses a synthetic energy-mean of all 123 other profiles
 * (see `recompute_fallback_npd` in `scripts/build-aircraft-profiles.py`).
 */
const CLASS_ANCHOR: Record<string, { typecode: string, isEnergyMean: boolean }> = {
  WING_FALLBACK: { typecode: 'FALLBACK', isEnergyMean: true },
  WING_A320: { typecode: 'A320', isEnergyMean: false },
  WING_B738: { typecode: 'B738', isEnergyMean: false },
  WING_A21N: { typecode: 'A21N', isEnergyMean: false },
  PROP_C172: { typecode: 'C172', isEnergyMean: false },
  WING_B789: { typecode: 'B789', isEnergyMean: false },
  WING_B38M: { typecode: 'B38M', isEnergyMean: false },
  WING_A319: { typecode: 'A319', isEnergyMean: false },
  FUSE_CRJ9: { typecode: 'CRJ9', isEnergyMean: false },
  HELICOPTER: { typecode: 'EC35', isEnergyMean: false },
  PROP_DH8D: { typecode: 'DH8D', isEnergyMean: false },
  FUSE_C56X: { typecode: 'C56X', isEnergyMean: false },
}

/**
 * Tooltip for an aircraft cell. Same 3-line format in both Bands and
 * Top flights tables.
 *
 *   line 1 = aircraft model name (from typecode)
 *   line 2 = noise class this typecode falls into (Voronoi assignment)
 *   line 3 = NPD curve provenance — either:
 *              "from this aircraft's own profile"   (typecode = class anchor)
 *              "from <ANCHOR> (Voronoi-assigned)"   (typecode != anchor)
 *              "energy-mean of 123 profiles"        (FALLBACK / WING_FALLBACK)
 *
 * Caller passes typecode (the cell's display value) and optionally className
 * (for Bands, where the band already exposes the class label directly).
 */
export function aircraftTooltip(typecode: string, className?: string | null): string {
  const cls = className ?? PROFILE_CLASS[typecode] ?? null
  const anchor = cls ? CLASS_ANCHOR[cls] : null
  const lines = [modelName(typecode)]
  if (cls) lines.push(`Class: ${cls}`)
  if (anchor) {
    if (anchor.isEnergyMean) {
      lines.push('NPD curve: traffic-weighted energy-mean of 123 profiles')
    } else if (anchor.typecode === typecode) {
      lines.push("NPD curve: this aircraft's own profile")
    } else {
      lines.push(`NPD curve: ${anchor.typecode} (${modelName(anchor.typecode)}) — Voronoi-assigned`)
    }
  }
  return lines.join('\n')
}
