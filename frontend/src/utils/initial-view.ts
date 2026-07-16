// First-visit map view (no #hash in the URL): approximate the visitor's
// city/country WITHOUT any permission prompt — Google-style layering:
//   1. shared link (#hash) wins — handled by useUrlState, never reaches here
//   2. server IP-city guess (`fetchIpCityView` → /api/initial-view, DB-IP
//      lite on the server) — bounded, raced before the map mounts
//   3. browser language REGION subtag (cs-CZ, en-GB, de-AT…) → country view
//   4. unambiguous single-country languages (cs, pl, hu…) → country view
//   5. fallback: whole Europe
// Precise location is a separate, user-triggered gesture (the locate
// button) — auto-prompting for GPS on load is hostile UX and browsers
// deprioritize it.

export interface InitialView {
  lat: number
  lng: number
  zoom: number
}

export const EUROPE_VIEW: InitialView = { lat: 50.5, lng: 9.5, zoom: 4 }

// Country centroids at a "whole country on screen" zoom. Small countries get
// z7, mid z6, large z5 — coarse is fine, this is a first guess, not a fix.
const COUNTRY_VIEW: Record<string, InitialView> = {
  CZ: { lat: 49.8, lng: 15.5, zoom: 7 },
  SK: { lat: 48.7, lng: 19.7, zoom: 7 },
  DE: { lat: 51.2, lng: 10.4, zoom: 6 },
  AT: { lat: 47.6, lng: 14.1, zoom: 7 },
  CH: { lat: 46.8, lng: 8.2, zoom: 7 },
  PL: { lat: 52.1, lng: 19.4, zoom: 6 },
  FR: { lat: 46.6, lng: 2.5, zoom: 6 },
  ES: { lat: 40.2, lng: -3.6, zoom: 6 },
  PT: { lat: 39.6, lng: -8.0, zoom: 7 },
  IT: { lat: 42.8, lng: 12.5, zoom: 6 },
  GB: { lat: 54.0, lng: -2.5, zoom: 6 },
  IE: { lat: 53.4, lng: -8.0, zoom: 7 },
  NL: { lat: 52.2, lng: 5.3, zoom: 7 },
  BE: { lat: 50.6, lng: 4.7, zoom: 7 },
  LU: { lat: 49.8, lng: 6.1, zoom: 9 },
  DK: { lat: 56.0, lng: 10.0, zoom: 7 },
  NO: { lat: 62.0, lng: 9.5, zoom: 5 },
  SE: { lat: 62.5, lng: 16.0, zoom: 5 },
  FI: { lat: 63.0, lng: 26.0, zoom: 5 },
  EE: { lat: 58.7, lng: 25.5, zoom: 7 },
  LV: { lat: 56.9, lng: 24.9, zoom: 7 },
  LT: { lat: 55.3, lng: 23.9, zoom: 7 },
  HU: { lat: 47.2, lng: 19.4, zoom: 7 },
  SI: { lat: 46.1, lng: 14.8, zoom: 8 },
  HR: { lat: 45.0, lng: 16.4, zoom: 7 },
  RO: { lat: 45.9, lng: 25.0, zoom: 6 },
  BG: { lat: 42.7, lng: 25.3, zoom: 7 },
  GR: { lat: 39.0, lng: 22.9, zoom: 6 },
  US: { lat: 39.8, lng: -98.6, zoom: 4 },
  CA: { lat: 56.0, lng: -96.0, zoom: 4 },
}

// Languages spoken overwhelmingly in ONE country — safe without a region
// subtag. Multi-country languages (en, de, fr, es, pt, nl, sv…) stay out:
// guessing DE for plain `de` would misplace Austrians and Swiss.
const UNAMBIGUOUS_LANGUAGE_COUNTRY: Record<string, string> = {
  cs: 'CZ', sk: 'SK', pl: 'PL', hu: 'HU', sl: 'SI', hr: 'HR', ro: 'RO',
  bg: 'BG', el: 'GR', da: 'DK', nb: 'NO', nn: 'NO', fi: 'FI', et: 'EE',
  lv: 'LV', lt: 'LT', it: 'IT',
}

/**
 * Server-side city-level guess from the visitor's IP (/api/initial-view,
 * DB-IP City Lite looked up in memory on our origin). Bounded by `timeoutMs`
 * so a slow origin can never hold up the first map paint; any failure,
 * timeout or `source:'none'` → null → the language fallback below.
 */
export async function fetchIpCityView(timeoutMs: number): Promise<InitialView | null> {
  try {
    const res = await fetch('/api/initial-view', { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as { source?: unknown; lat?: unknown; lng?: unknown; zoom?: unknown }
    if (body.source !== 'ip-city') return null
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number' || typeof body.zoom !== 'number') return null
    if (!(body.lat >= -90 && body.lat <= 90) || !(body.lng >= -180 && body.lng <= 180)) return null
    return { lat: body.lat, lng: body.lng, zoom: body.zoom }
  } catch {
    return null
  }
}

export function resolveInitialView(languages: readonly string[] = navigator.languages ?? []): InitialView {
  for (const tag of languages) {
    const region = tag.split('-')[1]?.toUpperCase()
    if (region && COUNTRY_VIEW[region]) return COUNTRY_VIEW[region]
  }
  for (const tag of languages) {
    const lang = tag.split('-')[0].toLowerCase()
    const country = UNAMBIGUOUS_LANGUAGE_COUNTRY[lang]
    if (country && COUNTRY_VIEW[country]) return COUNTRY_VIEW[country]
  }
  return EUROPE_VIEW
}
