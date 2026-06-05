/**
 * Enrich DZ industrial with GEM Global Integrated Power (Algeria filter).
 *
 * Algerian gov portals (Ministère de l'Énergie, Sonelgaz, Sonatrach,
 * Ministère de l'Environnement) publish corporate HTML only. GEM is the only
 * machine-readable source for power infrastructure.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Algeria'):
 *     208 total, 144 operating, ~24.6 GW installed
 *     Operating fuel breakdown: oil/gas 107, solar 34, hydropower 2, wind 1
 *
 *   Algeria has Africa's 2nd-largest thermal fleet after Egypt, overwhelmingly
 *   natural gas from domestic Hassi R'Mel and Hassi Messaoud fields.
 *
 *   Top operating plants (per-unit GEM entries, actual site capacity = sum):
 *     **Bellara 699 MW ×2 = 1,398 MW** (Jijel, El-Milia coastal CCGT)
 *     **Naama 582 MW ×2 = 1,164 MW** (Sud-Ouest, single-cycle turbines)
 *     **Oumache 500 MW ×2 = 1,000 MW** (Biskra, gas CCGT)
 *     **Hadjret En Nouss 409 MW ×3 = 1,227 MW** (Tipaza coastal — one of
 *                                                 Algeria's largest power stations)
 *     **Koudiet Eddraouch 400 MW ×3 = 1,200 MW** (El Taref, near Tunisian border)
 *     **Ras Djinet 400 MW ×3 = 1,200 MW** (Boumerdes coastal)
 *     **Terga 400 MW ×3 = 1,200 MW** (Aïn Témouchent, far west)
 *     **Ain Arnet 338 MW ×3 = 1,014 MW** (Sétif, interior north)
 *     **Mostaganem 450 MW**, **Skikda CCGT 440 MW ×2**, **Boufarik 2 250 MW**
 *     Multiple 250-300 MW peakers at F'kirina, Labreg, Msila, Hassi Ameur
 *     Hydropower: **Beni Haroun pumped storage** (Mila, 423 MW), Erraguene
 *     Solar: **Tihamam**, **Hassi R'Mel Solar (ISCC)**, **Boughezoul**, 30+ CPV
 *     Wind: **Kabertène** (Adrar, Algeria's first wind farm, 2014)
 *
 * Non-power industrial (OSM only):
 *   - **Sonatrach** — one of Africa's largest companies, operates all major
 *     oil/gas upstream and downstream:
 *     - **Hassi Messaoud oil field** — Algeria's main oil field (since 1956),
 *       over 80% of crude production
 *     - **Hassi R'Mel gas field** — **one of the world's largest gas fields**,
 *       Algeria's main gas hub (since 1956)
 *     - **In Salah gas** (BP/Statoil-Sonatrach, 2004)
 *     - **In Amenas gas** (BP/Statoil-Sonatrach, site of 2013 terrorist attack)
 *     - **Skikda** refinery (355k bpd) + **LNG** trains (since 1972)
 *     - **Arzew** refinery + **LNG** (since 1964 — **world's first
 *       industrial-scale LNG export plant**) + petrochemicals + fertilizers
 *     - **Béjaïa refinery**, **Algiers refinery**, **Adrar refinery**
 *   - **El Hadjar steel complex** (Annaba) — **Africa's largest steel complex**
 *     (historic ArcelorMittal, now state-owned Imetal), ~2 Mtpa
 *   - **Cement**: LafargeHolcim (M'Sila, Oggaz), GICA (state), Biskria,
 *     many regional plants
 *   - **Phosphates**: Djebel Onk (Tébessa), not as large as Morocco
 *   - **Ports**: Algiers, Oran, Annaba, Arzew, Skikda, Béjaïa
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-dz.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const DZ_BBOX: readonly [number, number, number, number] = [18.9, -8.7, 37.1, 12.0]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [27.0, -8.7, 37.1, -2.0],
  [22.0, -8.7, 27.0, -3.0],
  [18.9, -8.7, 22.0, -4.5],
  [18.9, -4.5, 25.0, 4.2],
  [18.9, 4.2, 23.5, 12.0],
  [18.9, 10.0, 33.0, 12.0],
  [33.0, 8.3, 37.1, 12.0],
]

await enrichGemIndustrial({
  countryCode: 'dz',
  countryName: "Algeria",
  bbox: DZ_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, DZ_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
