import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import Fastify from 'fastify'
import { stayRoutes, snap, pickPrecision, slim } from './stay.js'

test('snap keeps grid-boundary values in place', () => {
  // Regression: floor(50.05/0.05) is 1000.999… without the epsilon, snapping
  // a whole cell too far and doubling the requested box.
  assert.equal(snap(50.05, false), '50.05')
  assert.equal(snap(50.05, true), '50.05')
  assert.equal(snap(50.063, false), '50.05')
  assert.equal(snap(50.063, true), '50.10')
  assert.equal(snap(-0.02, false), '-0.05')
  assert.equal(snap(-0.02, true), '0.00')
})

test('pickPrecision fits the H3 grid to one page', () => {
  // Central-Prague-sized box (~40 km²): r8 → 54 cells ≤ 100.
  assert.equal(pickPrecision(50.05, 14.35, 50.10, 14.45), 8)
  // City-overview box (~700 km²): r7 would need 131 cells, r6 fits.
  assert.equal(pickPrecision(50.0, 14.2, 50.25, 14.55), 6)
  // Tiny box: finest configured resolution wins.
  assert.equal(pickPrecision(50.05, 14.35, 50.055, 14.355), 10)
})

const SAMPLE = {
  id: '71440222.0000',
  url: 'https://www.stay22.com/allez/roam/usds_71440222.0000?aid=stay22',
  suppliers: {
    booking: { id: '8612595', link: 'https://www.stay22.com/allez/booking/8612595', price: { total: 341 } },
    expedia: { id: 'x', link: 'https://www.stay22.com/allez/expedia/x', price: { total: 299 } },
  },
  name: 'Garden apartment',
  location: { coordinates: { lat: 50.081664, lng: 14.456728 } },
  rating: { value: 8.9, hotelStars: 3, count: 57 },
  capacity: { guests: 3, bedrooms: 1, beds: 2, bathrooms: 1 },
  policies: { instantBook: true, freeCancellation: true },
  media: { thumbnail: 'https://q-xx.bstatic.com/photo.jpg' },
}

test('slim maps a Stay22 result and picks the cheapest supplier price', () => {
  const s = slim(SAMPLE, 2)
  assert.ok(s)
  assert.equal(s.id, '71440222.0000')
  assert.equal(s.lat, 50.081664)
  assert.equal(s.price?.total, 299)
  assert.equal(s.price?.perNight, 150)
  assert.equal(s.rating.stars, 3)
  assert.equal(s.freeCancellation, true)
})

test('slim drops results without coordinates and survives missing fields', () => {
  assert.equal(slim({ name: 'x', url: 'https://x.example/a' }, 2), null)
  const bare = slim({ id: 1, name: 'x', url: 'https://x.example/a', location: { coordinates: { lat: 1, lng: 2 } } }, 2)
  assert.ok(bare)
  assert.equal(bare.price, null)
  assert.equal(bare.rating.value, null)
})

test('slim refuses non-https URLs and non-numeric numbers from upstream', () => {
  // A poisoned javascript: link would execute on click; a stray "8.9" string
  // would throw in the card's toFixed.
  assert.equal(slim({ ...SAMPLE, url: 'javascript:alert(1)' }, 2), null)
  const t = slim({
    ...SAMPLE,
    media: { thumbnail: 'http://insecure.example/p.jpg' },
    rating: { value: '8.9', count: 57, hotelStars: 3 },
    suppliers: { booking: { price: { total: '341' } } },
  }, 2)
  assert.ok(t)
  assert.equal(t.thumbnail, null)
  assert.equal(t.rating.value, null)
  assert.equal(t.rating.count, 57)
  assert.equal(t.price, null)
})

test('GET /api/stay validates the bbox before any upstream call', async (t) => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not be called')
  })
  t.after(() => fetchMock.mock.restore())

  const app = Fastify()
  await app.register(stayRoutes)
  t.after(async () => app.close())

  for (const qs of [
    'swlat=x&swlng=14&nelat=51&nelng=15',            // non-numeric
    'swlat=51&swlng=14&nelat=50&nelng=15',           // inverted
    'swlat=50&swlng=14&nelat=51.6&nelng=15',         // span over cap
  ]) {
    const response = await app.inject(`/api/stay?${qs}`)
    assert.equal(response.statusCode, 400, qs)
  }
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('GET /api/stay serves the second hit from cache', async (t) => {
  const upstream = { results: [SAMPLE] }
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify(upstream), { status: 200 }))
  t.after(() => fetchMock.mock.restore())

  const app = Fastify()
  await app.register(stayRoutes)
  t.after(async () => app.close())

  // Distinct bbox from other tests — the route cache is module-level.
  const qs = 'swlat=48.10&swlng=17.10&nelat=48.15&nelng=17.15'
  const first = await app.inject(`/api/stay?${qs}`)
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().listings.length, 1)
  assert.equal(first.json().listings[0].price.total, 299)

  const second = await app.inject(`/api/stay?${qs}`)
  assert.equal(second.statusCode, 200)
  assert.equal(fetchMock.mock.callCount(), 1)
})
