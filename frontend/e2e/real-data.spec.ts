import { expect, test } from '@playwright/test'
import {
  TILE_Z,
  canvasCenter,
  hm3PixelCenter,
  mockTerrainBasemap,
  type PixelCenter,
} from './support'

// HM3 stores 0.5 dB steps (≤0.25 dB quantisation error) and both surfaces
// display one decimal. One dB leaves a conservative numeric/projection margin
// while still catching a user-visible map/popup disagreement.
const REAL_PARITY_TOLERANCE_DB = 1

const SCENARIOS = [
  { name: 'D4 49.8486,14.1639', point: hm3PixelCenter(49.8486, 14.1639) },
  { name: 'LKPR mid-runway', point: hm3PixelCenter(50.114, 14.27) },
] as const

test('real data: D4 and LKPR map hover match the clicked popup', async ({ page, request }, testInfo) => {
  test.skip(!process.env.E2E_REAL_BASE_URL, 'set E2E_REAL_BASE_URL to run the real-data smoke')

  const ready = await request.get('/api/ready')
  expect(ready.status()).toBe(200)
  const manifestResponse = await request.get('/api/tiles-manifest')
  expect(manifestResponse.status()).toBe(200)
  const manifest = await manifestResponse.json() as {
    build?: string
    layers?: Record<string, { build?: string; file?: string }>
  }
  const totalEntry = manifest.layers?.total
  const fileBuild = totalEntry?.file?.match(/\.(b\d+)\.pmtiles$/)?.[1]
  const totalBuild = totalEntry?.build ?? fileBuild ?? manifest.build
  expect(totalBuild).toMatch(/^b\d+$/)

  await mockTerrainBasemap(page)
  await page.route('**/api/reverse?**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ place: 'E2E real-data point' }),
  }))

  for (const [scenarioIndex, scenario] of SCENARIOS.entries()) {
    await test.step(scenario.name, async () => {
      const point: PixelCenter = scenario.point
      const tilePath = `/api/tiles/${totalBuild}/total/${TILE_Z}/${point.tx}/${point.ty}.bin`
      const targetTile = page.waitForResponse(response => new URL(response.url()).pathname === tilePath)
      // A changed, ignored query forces a fresh MapApp for the second point;
      // changing only the hash would leave useUrlState's initial view intact.
      await page.goto(
        `/?e2e-real=${scenarioIndex}#lat=${point.lat}&lng=${point.lng}&z=${TILE_Z}&bm=terrain`,
      )
      expect((await targetTile).status()).toBe(200)

      const { x, y } = await canvasCenter(page)
      await page.mouse.move(x, y)
      // Real smoke may target the currently deployed frontend, which can lag
      // this branch's test hooks. The visible value is the stable user-facing
      // contract; hermetic tests still exercise the dedicated test id.
      const hover = page.getByText(/^Lden: \d+\.\d dB$/)
      await expect(hover).toHaveText(/^Lden: \d+\.\d dB$/)
      const hoverText = await hover.textContent()
      const hoverDb = Number(hoverText!.match(/([0-9]+\.[0-9])/)![1])

      const popupResponse = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/noise-onfly-v2',
      )
      await page.mouse.click(x, y)
      const response = await popupResponse
      expect(response.status()).toBe(200)
      const api = await response.json() as { total_lden: number | null }
      expect(typeof api.total_lden).toBe('number')
      const popupDb = api.total_lden!
      await expect(page.locator('[data-testid="noise-badge"]:visible'))
        .toHaveText(`${popupDb.toFixed(1)} dB`)

      const requestUrl = new URL(response.url())
      expect(Math.abs(Number(requestUrl.searchParams.get('lat')) - point.lat)).toBeLessThan(1e-6)
      expect(Math.abs(Number(requestUrl.searchParams.get('lng')) - point.lng)).toBeLessThan(1e-6)
      const deltaDb = Math.abs(hoverDb - popupDb)
      const values = { scenario: scenario.name, hover_db: hoverDb, popup_db: popupDb, delta_db: deltaDb }
      console.log(`real-data ${scenario.name}: HM3 ${hoverDb.toFixed(1)} dB, popup ${popupDb.toFixed(1)} dB, |Δ| ${deltaDb.toFixed(2)} dB`)
      await testInfo.attach(`${scenario.name}-values`, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(values, null, 2)),
      })
      expect(deltaDb).toBeLessThanOrEqual(REAL_PARITY_TOLERANCE_DB)
    })
  }
})
