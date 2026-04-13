import { FastifyInstance } from 'fastify'

interface SearchResult {
  display_name: string
  secondary: string
  lat: number
  lon: number
}

interface PhotonFeature {
  properties: {
    name?: string
    street?: string
    housenumber?: string
    city?: string
    district?: string
    locality?: string
    state?: string
    country?: string
  }
  geometry: {
    coordinates: [number, number]
  }
}

function formatPhotonResult(p: PhotonFeature['properties']): { display_name: string; secondary: string } {
  let primary = ''
  const secondaryParts: string[] = []

  if (p.street) {
    let num = p.housenumber
    if (num) {
      const slash = num.indexOf('/')
      if (slash !== -1) num = num.substring(slash + 1)
      primary = `${p.street} ${num}`
    } else {
      primary = p.street
    }
  } else if (p.name) {
    primary = p.name
  }

  const city = p.city
  const district = p.district || p.locality
  if (city) {
    if (district && district !== city) {
      secondaryParts.push(`${city} – ${district}`)
    } else {
      secondaryParts.push(city)
    }
  } else if (district) {
    secondaryParts.push(district)
  } else if (p.state) {
    secondaryParts.push(p.state)
  }

  if (p.country) secondaryParts.push(p.country)

  return {
    display_name: primary || p.name || '?',
    secondary: secondaryParts.join(', '),
  }
}

const cache = new Map<string, { data: SearchResult[]; expires: number }>()
const CACHE_TTL = 60 * 60 * 1000

export async function searchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; lat?: string; lon?: string } }>('/api/search', async (request, reply) => {
    const q = request.query.q?.trim()
    if (!q || q.length < 2) return reply.send([])

    const lat = request.query.lat || '50.08'
    const lon = request.query.lon || '14.42'
    const cacheKey = `${q.toLowerCase()}|${parseFloat(lat).toFixed(1)}|${parseFloat(lon).toFixed(1)}`

    const entry = cache.get(cacheKey)
    if (entry && entry.expires > Date.now()) return reply.send(entry.data)

    try {
      const url = new URL('https://photon.komoot.io/api/')
      url.searchParams.set('q', q)
      url.searchParams.set('lat', lat)
      url.searchParams.set('lon', lon)
      url.searchParams.set('lang', 'default')
      url.searchParams.set('limit', '5')

      const res = await fetch(url.toString(), {
        headers: { 'User-Agent': 'QuietMap/1.0 (noise atlas)' },
        signal: AbortSignal.timeout(3000),
      })

      if (!res.ok) return reply.send([])

      const data = await res.json() as { features: PhotonFeature[] }
      const results: SearchResult[] = data.features.map(f => {
        const { display_name, secondary } = formatPhotonResult(f.properties)
        return {
          display_name,
          secondary,
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
        }
      })

      cache.set(cacheKey, { data: results, expires: Date.now() + CACHE_TTL })
      if (cache.size > 1000) {
        const now = Date.now()
        for (const [k, v] of cache) { if (v.expires < now) cache.delete(k) }
        // Hard cap: if still over limit after expiry sweep, drop oldest entries
        if (cache.size > 1000) {
          const excess = cache.size - 800
          let removed = 0
          for (const k of cache.keys()) {
            if (removed >= excess) break
            cache.delete(k)
            removed++
          }
        }
      }

      return reply.send(results)
    } catch {
      return reply.send([])
    }
  })
}
