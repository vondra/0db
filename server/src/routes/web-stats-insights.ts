// Rule-based one-liners for /a/stats ("read conclusions, not tables"). Plain
// thresholds over the day-over-day aggregates — no ML, each line carries the
// number it stands on, max 5 lines ranked by novelty. Pure functions over a
// small input struct so the rules stay unit-testable without a DB or log.

export interface InsightInputs {
  /** Latest day present in the DB (YYYY-MM-DD); null when the DB is empty. */
  today: string | null
  previousDay: string | null
  /** The site's own domain — internal navigation, never a referer insight. */
  selfDomain: string
  /** ISO code → first day ever seen in the DB. */
  countryFirstSeen: Record<string, string>
  countryNames: Record<string, string>
  referersToday: { domain: string; visits: number }[]
  referersPrevious: { domain: string; visits: number }[]
  refererFirstSeen: Record<string, string>
  topPopupCell: { lat: number; lng: number; opens: number } | null
  /** Today-window popup rates by device class; null when the log is unreadable. */
  deviceRates: {
    mobile: { visitors: number; popups: number }
    desktop: { visitors: number; popups: number }
  } | null
}

export interface Insight {
  id: string
  text: string
}

/** Referers that carry no information about who sent the visitor. */
const NON_REFERERS = new Set(['direct', 'ip-literal'])

const MAX_INSIGHTS = 5
const NEW_REFERER_WINDOW_DAYS = 6
const MIN_POPUP_RATE_VISITORS = 5
const POPUP_RATE_RATIO = 1.5

function shiftDay(day: string, daysBack: number): string {
  const shifted = new Date(`${day}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() - daysBack)
  return shifted.toISOString().slice(0, 10)
}

function formatRatio(ratio: number): string {
  if (ratio >= 10) return String(Math.round(ratio))
  const rounded = Math.round(ratio * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function buildInsights(inputs: InsightInputs): Insight[] {
  if (!inputs.today) return []
  const insights: Insight[] = []
  const { today } = inputs

  // 1. First-ever country (first-seen day = today). Several can land on the
  //    same day — list up to three by name.
  const firstCountries = Object.entries(inputs.countryFirstSeen)
    .filter(([, first]) => first === today)
    .map(([code]) => inputs.countryNames[code] ?? code)
    .sort()
  if (firstCountries.length > 0) {
    const shown = firstCountries.slice(0, 3).join(', ')
    const rest = firstCountries.length > 3 ? ` and ${firstCountries.length - 3} more` : ''
    insights.push({
      id: 'first-country',
      text: `First-ever ${firstCountries.length === 1 ? 'visitor' : 'visitor countries'}: ${shown}${rest} (${today}).`,
    })
  }

  // 2. Referer movement: prefer a NEW external referer (first seen within the
  //    week, ≥2 visits today), else a spike vs the previous day (≥2×, ≥3).
  const informative = inputs.referersToday.filter((r) => !NON_REFERERS.has(r.domain) && r.domain !== inputs.selfDomain)
  const newReferer = informative.find(
    (r) => r.visits >= 2 && (inputs.refererFirstSeen[r.domain] ?? today) >= shiftDay(today, NEW_REFERER_WINDOW_DAYS),
  )
  if (newReferer) {
    insights.push({
      id: 'new-referer',
      text: `New referer ${newReferer.domain} — ${newReferer.visits} visits today, first seen ${inputs.refererFirstSeen[newReferer.domain]}.`,
    })
  } else if (inputs.previousDay) {
    const previousVisits = new Map(inputs.referersPrevious.map((r) => [r.domain, r.visits]))
    const spike = informative.find((r) => {
      const before = previousVisits.get(r.domain) ?? 0
      return r.visits >= 3 && r.visits >= 2 * Math.max(1, before)
    })
    if (spike) {
      const before = previousVisits.get(spike.domain) ?? 0
      insights.push({
        id: 'referer-spike',
        text: `${spike.domain} brought ${formatRatio(spike.visits / Math.max(1, before))}× more visits than yesterday (${spike.visits} vs ${before}).`,
      })
    }
  }

  // 3. The "where do people explore quiet" headline — top clicked cell today.
  if (inputs.topPopupCell) {
    const { lat, lng, opens } = inputs.topPopupCell
    insights.push({
      id: 'top-cell',
      text: `Most clicked place today: cell ${lat.toFixed(2)}, ${lng.toFixed(2)} (${opens} popup ${opens === 1 ? 'open' : 'opens'}).`,
    })
  }

  // 4. Mobile-vs-desktop popup rate from the live window — only with a real
  //    base on both sides (≥ MIN_POPUP_RATE_VISITORS distinct visitors each).
  const rates = inputs.deviceRates
  if (rates && rates.mobile.visitors >= MIN_POPUP_RATE_VISITORS && rates.desktop.visitors >= MIN_POPUP_RATE_VISITORS) {
    const mobileRate = rates.mobile.popups / rates.mobile.visitors
    const desktopRate = rates.desktop.popups / rates.desktop.visitors
    if (mobileRate >= POPUP_RATE_RATIO * desktopRate && mobileRate > 0) {
      insights.push({
        id: 'device-popup-rate',
        text: `Mobile popup rate is ${formatRatio(mobileRate / Math.max(desktopRate, 0.01))}× desktop today (${rates.mobile.popups} opens / ${rates.mobile.visitors} mobile visitors vs ${rates.desktop.popups}/${rates.desktop.visitors}).`,
      })
    } else if (desktopRate >= POPUP_RATE_RATIO * mobileRate && desktopRate > 0) {
      insights.push({
        id: 'device-popup-rate',
        text: `Desktop popup rate is ${formatRatio(desktopRate / Math.max(mobileRate, 0.01))}× mobile today (${rates.desktop.popups} opens / ${rates.desktop.visitors} desktop visitors vs ${rates.mobile.popups}/${rates.mobile.visitors}).`,
      })
    }
  }

  return insights.slice(0, MAX_INSIGHTS)
}
