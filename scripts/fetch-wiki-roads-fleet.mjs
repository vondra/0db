#!/usr/bin/env node
// Fetch country vehicle fleet and road network from Wikipedia:
//   - https://en.wikipedia.org/wiki/List_of_countries_and_territories_by_motor_vehicles_per_capita
//   - https://en.wikipedia.org/wiki/List_of_countries_by_road_network_size
//
// Combined signal → vehicles_per_km = total_vehicles / total_road_km
// This is a direct proxy for average AADT on that country's existing
// road network (Norway: low, Egypt: high). Better than GDP alone which
// mis-ranks low-GDP countries with concentrated networks (Egypt, India)
// and high-GDP countries with sparse networks (Norway, Canada).
//
// Output: scripts/wiki-roads-fleet.json — committed to git.

import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'scripts', 'wiki-roads-fleet.json')

// Wikipedia country name → ISO 3166-1 alpha-2.
// Manually curated to disambiguate "Congo" / "Korea" / "Ireland" / etc.
// Keys are the anchor text Wikipedia uses in the two tables.
// ~230 entries cover >99 % of world population + road network.
const NAME_TO_ISO = {
  // — A —
  'Afghanistan': 'AF', 'Albania': 'AL', 'Algeria': 'DZ', 'American Samoa': 'AS',
  'Andorra': 'AD', 'Angola': 'AO', 'Anguilla': 'AI', 'Antigua and Barbuda': 'AG',
  'Argentina': 'AR', 'Armenia': 'AM', 'Aruba': 'AW', 'Australia': 'AU', 'Austria': 'AT',
  'Azerbaijan': 'AZ',
  // — B —
  'Bahamas': 'BS', 'The Bahamas': 'BS', 'Bahrain': 'BH', 'Bangladesh': 'BD', 'Barbados': 'BB',
  'Belarus': 'BY', 'Belgium': 'BE', 'Belize': 'BZ', 'Benin': 'BJ', 'Bermuda': 'BM',
  'Bhutan': 'BT', 'Bolivia': 'BO', 'Bosnia and Herzegovina': 'BA', 'Botswana': 'BW',
  'Brazil': 'BR', 'British Virgin Islands': 'VG', 'Brunei': 'BN', 'Bulgaria': 'BG',
  'Burkina Faso': 'BF', 'Burundi': 'BI',
  // — C —
  'Cabo Verde': 'CV', 'Cape Verde': 'CV', 'Cambodia': 'KH', 'Cameroon': 'CM', 'Canada': 'CA',
  'Cayman Islands': 'KY', 'Central African Republic': 'CF', 'Chad': 'TD', 'Chile': 'CL',
  'China': 'CN', 'Colombia': 'CO', 'Comoros': 'KM',
  'Democratic Republic of the Congo': 'CD', 'DR Congo': 'CD', 'DRC': 'CD',
  'Republic of the Congo': 'CG', 'Congo': 'CG',
  'Cook Islands': 'CK', 'Costa Rica': 'CR', 'Croatia': 'HR', 'Cuba': 'CU', 'Curaçao': 'CW',
  'Cyprus': 'CY', 'Czech Republic': 'CZ', 'Czechia': 'CZ',
  // — D —
  'Denmark': 'DK', 'Djibouti': 'DJ', 'Dominica': 'DM', 'Dominican Republic': 'DO',
  // — E —
  'East Timor': 'TL', 'Timor-Leste': 'TL', 'Ecuador': 'EC', 'Egypt': 'EG', 'El Salvador': 'SV',
  'Equatorial Guinea': 'GQ', 'Eritrea': 'ER', 'Estonia': 'EE', 'Eswatini': 'SZ',
  'Swaziland': 'SZ', 'Ethiopia': 'ET',
  // — F —
  'Falkland Islands': 'FK', 'Faroe Islands': 'FO', 'Fiji': 'FJ', 'Finland': 'FI', 'France': 'FR',
  'French Guiana': 'GF', 'French Polynesia': 'PF',
  // — G —
  'Gabon': 'GA', 'Gambia': 'GM', 'Georgia': 'GE', 'Germany': 'DE', 'Ghana': 'GH',
  'Gibraltar': 'GI', 'Greece': 'GR', 'Greenland': 'GL', 'Grenada': 'GD', 'Guadeloupe': 'GP',
  'Guam': 'GU', 'Guatemala': 'GT', 'Guernsey': 'GG', 'Bailiwick of Guernsey': 'GG',
  'Guinea': 'GN', 'Guinea-Bissau': 'GW', 'Guyana': 'GY',
  // — H —
  'Haiti': 'HT', 'Honduras': 'HN', 'Hong Kong': 'HK', 'Hungary': 'HU',
  // — I —
  'Iceland': 'IS', 'India': 'IN', 'Indonesia': 'ID', 'Iran': 'IR', 'Iraq': 'IQ',
  'Ireland': 'IE', 'Republic of Ireland': 'IE', 'Isle of Man': 'IM', 'Israel': 'IL', 'Italy': 'IT',
  'Ivory Coast': 'CI', "Côte d'Ivoire": 'CI',
  // — J —
  'Jamaica': 'JM', 'Japan': 'JP', 'Jersey': 'JE', 'Jordan': 'JO',
  // — K —
  'Kazakhstan': 'KZ', 'Kenya': 'KE', 'Kiribati': 'KI', 'North Korea': 'KP', 'South Korea': 'KR',
  'Korea, North': 'KP', 'Korea, South': 'KR', 'Kosovo': 'XK', 'Kuwait': 'KW', 'Kyrgyzstan': 'KG',
  // — L —
  'Laos': 'LA', 'Latvia': 'LV', 'Lebanon': 'LB', 'Lesotho': 'LS', 'Liberia': 'LR',
  'Libya': 'LY', 'Liechtenstein': 'LI', 'Lithuania': 'LT', 'Luxembourg': 'LU',
  // — M —
  'Macau': 'MO', 'Macao': 'MO', 'Madagascar': 'MG', 'Malawi': 'MW', 'Malaysia': 'MY',
  'Maldives': 'MV', 'Mali': 'ML', 'Malta': 'MT', 'Marshall Islands': 'MH', 'Martinique': 'MQ',
  'Mauritania': 'MR', 'Mauritius': 'MU', 'Mexico': 'MX', 'Micronesia': 'FM', 'Moldova': 'MD',
  'Monaco': 'MC', 'Mongolia': 'MN', 'Montenegro': 'ME', 'Montserrat': 'MS', 'Morocco': 'MA',
  'Mozambique': 'MZ', 'Myanmar': 'MM', 'Burma': 'MM',
  // — N —
  'Namibia': 'NA', 'Nauru': 'NR', 'Nepal': 'NP', 'Netherlands': 'NL',
  'New Caledonia': 'NC', 'New Zealand': 'NZ', 'Nicaragua': 'NI', 'Niger': 'NE', 'Nigeria': 'NG',
  'Niue': 'NU', 'North Macedonia': 'MK', 'Macedonia': 'MK',
  'Northern Mariana Islands': 'MP', 'Norway': 'NO',
  // — O —
  'Oman': 'OM',
  // — P —
  'Pakistan': 'PK', 'Palau': 'PW', 'Palestine': 'PS', 'State of Palestine': 'PS',
  'Panama': 'PA', 'Papua New Guinea': 'PG', 'Paraguay': 'PY', 'Peru': 'PE',
  'Philippines': 'PH', 'Poland': 'PL', 'Portugal': 'PT', 'Puerto Rico': 'PR',
  // — Q —
  'Qatar': 'QA',
  // — R —
  'Romania': 'RO', 'Russia': 'RU', 'Russian Federation': 'RU', 'Rwanda': 'RW',
  // — S —
  'Saint Kitts and Nevis': 'KN', 'Saint Lucia': 'LC',
  'Saint Vincent and the Grenadines': 'VC', 'Samoa': 'WS', 'San Marino': 'SM',
  'São Tomé and Príncipe': 'ST', 'Sao Tome and Principe': 'ST',
  'Saudi Arabia': 'SA', 'Senegal': 'SN', 'Serbia': 'RS', 'Seychelles': 'SC',
  'Sierra Leone': 'SL', 'Singapore': 'SG', 'Sint Maarten': 'SX', 'Slovakia': 'SK',
  'Slovenia': 'SI', 'Solomon Islands': 'SB', 'Somalia': 'SO', 'South Africa': 'ZA',
  'South Sudan': 'SS', 'Spain': 'ES', 'Sri Lanka': 'LK', 'Sudan': 'SD', 'Suriname': 'SR',
  'Sweden': 'SE', 'Switzerland': 'CH', 'Syria': 'SY',
  // — T —
  'Taiwan': 'TW', 'Tajikistan': 'TJ', 'Tanzania': 'TZ', 'Thailand': 'TH', 'Togo': 'TG',
  'Tonga': 'TO', 'Trinidad and Tobago': 'TT', 'Tunisia': 'TN', 'Turkey': 'TR', 'Türkiye': 'TR',
  'Turkmenistan': 'TM', 'Turks and Caicos Islands': 'TC', 'Tuvalu': 'TV',
  // — U —
  'Uganda': 'UG', 'Ukraine': 'UA', 'United Arab Emirates': 'AE',
  'United Kingdom': 'GB', 'UK': 'GB', 'United States': 'US',
  'United States Virgin Islands': 'VI', 'U.S. Virgin Islands': 'VI',
  'Uruguay': 'UY', 'Uzbekistan': 'UZ',
  // — V —
  'Vanuatu': 'VU', 'Vatican City': 'VA', 'Venezuela': 'VE', 'Vietnam': 'VN',
  'Viet Nam': 'VN', 'Wallis and Futuna': 'WF',
  // — Y —
  'Yemen': 'YE',
  // — Z —
  'Zambia': 'ZM', 'Zimbabwe': 'ZW',
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()
}

function cleanNumber(s) {
  const cleaned = s.replace(/,/g, '').replace(/\[.*?\]/g, '').replace(/\s/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

async function fetchPage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.text()
}

function parseMainTable(html) {
  // Grab all `<tr>…</tr>` blocks; filter to rows with 5+ <td> cells.
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || []
  const parsed = []
  for (const row of rows) {
    const cells = row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) || []
    if (cells.length < 3) continue
    const cleaned = cells.map(stripHtml)
    // First cell usually starts with the country name (after a flag image).
    const firstCell = cleaned[0]
    // Strip leading "   " and trailing parentheticals/refs from country.
    const name = firstCell
      .replace(/^[\s ]+/, '')
      .replace(/\s*\(.*$/, '')
      .replace(/\[.*?\]/g, '')
      .trim()
    parsed.push({ name, cells: cleaned })
  }
  return parsed
}

function extractVehiclesTable(html) {
  // Columns: Country | vehicles/1000 | total vehicles | population | year | ref
  const out = {}
  for (const row of parseMainTable(html)) {
    if (row.cells.length < 3) continue
    const name = row.name
    const iso = NAME_TO_ISO[name]
    if (!iso) continue
    const perK = cleanNumber(row.cells[1])
    const totalVeh = cleanNumber(row.cells[2])
    const pop = cleanNumber(row.cells[3])
    if (!perK || !totalVeh) continue
    out[iso] = { vehicles_per_1000: perK, total_vehicles: totalVeh, population: pop, source: 'wikipedia', page: 'motor_vehicles_per_capita' }
  }
  return out
}

function extractRoadsTable(html) {
  // Columns: Country | total km | km/km² | paved | paved% | unpaved | unpaved% | expressway | expressway% | year
  const out = {}
  for (const row of parseMainTable(html)) {
    if (row.cells.length < 3) continue
    const name = row.name
    const iso = NAME_TO_ISO[name]
    if (!iso) continue
    const totalKm = cleanNumber(row.cells[1])
    const pavedKm = cleanNumber(row.cells[3])
    const expresswayKm = cleanNumber(row.cells[7])
    if (!totalKm) continue
    out[iso] = { road_total_km: totalKm, road_paved_km: pavedKm, expressway_km: expresswayKm, source: 'wikipedia', page: 'road_network_size' }
  }
  return out
}

async function main() {
  console.log('Fetching Wikipedia tables...')
  const vehHtml = await fetchPage('https://en.wikipedia.org/wiki/List_of_countries_and_territories_by_motor_vehicles_per_capita')
  const roadHtml = await fetchPage('https://en.wikipedia.org/wiki/List_of_countries_by_road_network_size')

  const vehicles = extractVehiclesTable(vehHtml)
  const roads = extractRoadsTable(roadHtml)
  console.log(`  vehicles table: ${Object.keys(vehicles).length} countries matched to ISO`)
  console.log(`  roads table:    ${Object.keys(roads).length} countries matched to ISO`)

  // Combine
  const combined = {}
  const allIso = new Set([...Object.keys(vehicles), ...Object.keys(roads)])
  for (const iso of [...allIso].sort()) {
    const v = vehicles[iso] || {}
    const r = roads[iso] || {}
    const totalVeh = v.total_vehicles
    const totalKm = r.road_total_km
    const pavedKm = r.road_paved_km
    // Prefer paved km for AADT proxy if > 0; unpaved roads carry negligible AADT.
    const divisorKm = pavedKm && pavedKm > 0 ? pavedKm : totalKm
    const vehiclesPerKm = (totalVeh && divisorKm && divisorKm > 0)
      ? Math.round((totalVeh / divisorKm) * 10) / 10
      : null
    combined[iso] = {
      vehicles_per_1000: v.vehicles_per_1000 ?? null,
      total_vehicles: totalVeh ?? null,
      population: v.population ?? null,
      road_total_km: totalKm ?? null,
      road_paved_km: pavedKm ?? null,
      expressway_km: r.expressway_km ?? null,
      vehicles_per_km: vehiclesPerKm,
    }
  }

  const both = [...allIso].filter(iso => vehicles[iso] && roads[iso] && combined[iso].vehicles_per_km)
  console.log(`  intersection (both tables): ${both.length} countries with vehicles_per_km`)

  const payload = {
    source: 'Wikipedia',
    pages: [
      'https://en.wikipedia.org/wiki/List_of_countries_and_territories_by_motor_vehicles_per_capita',
      'https://en.wikipedia.org/wiki/List_of_countries_by_road_network_size',
    ],
    fetched_at: new Date().toISOString(),
    countries: combined,
  }
  writeFileSync(OUT, JSON.stringify(payload, null, 2))
  console.log(`Wrote ${OUT}`)

  // Quick sanity print for reference countries
  console.log('\nSanity check — vehicles_per_km for reference:')
  for (const iso of ['DE', 'US', 'NO', 'FI', 'EG', 'IN', 'NG', 'JP', 'SG', 'BR', 'TH', 'CN', 'FR', 'GB', 'IT', 'CZ', 'ES']) {
    const c = combined[iso]
    if (!c || !c.vehicles_per_km) {
      console.log(`  ${iso}: [missing]`)
      continue
    }
    console.log(`  ${iso}: vehicles=${c.total_vehicles?.toLocaleString() ?? '?'}  paved_km=${c.road_paved_km?.toLocaleString() ?? '?'}  ratio=${c.vehicles_per_km}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
