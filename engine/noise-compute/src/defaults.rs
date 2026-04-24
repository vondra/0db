//! Hierarchical traffic-default cascade.
//!
//! For any H3R4 cell whose segment has no enriched AADT (i.e. no spatial
//! match against a national census + no service-tree heuristic), the engine
//! picks a default via this cascade:
//!
//! ```text
//!   city default (tier-1 metro override)   e.g. São Paulo, Bangkok, NYC, ...
//!   │   ↓ fallback
//!   country default                        e.g. BR rural, TH rural, ...
//!   │   ↓ fallback
//!   continent default                      e.g. SA/AF coarse averages
//!   │   ↓ fallback
//!   WORLD_DEFAULT                          EU-generic (same as pre-redesign)
//! ```
//!
//! `WORLD_DEFAULT` reproduces the legacy `normalize.rs::default_road_traffic`
//! table bit-for-bit so today's non-admin call sites see no behavior change.
//! Country and city arms are populated where the 12 national enrichers
//! previously hard-coded tier tables — BR CLASS_AADT × metro-tier, TH DOH
//! rural/Bangkok split, etc. Other countries will be added as enrichers get
//! audited in Phase A.1.
//!
//! Data format: `Aadt = (light, medium, heavy, moto)`, all in vehicles/day
//! both-directions total. Vehicle-class split follows the country's typical
//! fleet composition (e.g. TH has ~25 % motorcycles in Bangkok, BR has
//! higher heavy-vehicle share on rural freight corridors).

use crate::admin::{Admin, Continent};

/// Vehicle-class AADT tuple: (light, medium, heavy, moto), veh/day
/// both-directions total.
pub type Aadt = (f64, f64, f64, f64);

// ─── WORLD default ─────────────────────────────────────────────────────────
// Exact copy of the pre-redesign `normalize.rs::default_road_traffic` table.
// Must match bit-for-bit so non-admin call sites (the legacy
// `default_road_traffic(class)` wrapper) see zero behavior change.

pub const WORLD_DEFAULT: [Aadt; 13] = [
    (21600.0, 2400.0, 5700.0, 300.0),  // 0 motorway — 30k
    (11700.0, 1200.0, 1800.0, 300.0),  // 1 trunk — 15k
    (7470.0, 540.0, 810.0, 180.0),     // 2 primary
    (2640.0, 120.0, 180.0, 60.0),      // 3 secondary
    (720.0, 26.0, 38.0, 16.0),         // 4 tertiary
    (480.0, 5.0, 10.0, 5.0),           // 5 residential
    (98.0, 0.0, 1.0, 1.0),             // 6 living_street
    (240.0, 2.0, 5.0, 3.0),            // 7 service: parking aisles, driveways
    (4.0, 0.0, 1.0, 0.0),              // 8 track: tractor + occasional delivery
    (1200.0, 30.0, 80.0, 30.0),        // 9 unclassified: rural connector
    // Ramps — 15 % of respective mainline (HCM 7 / FEHRL / CERTU lower-range).
    // Previously 20 %; A.6 lowers to 15 % after Pasito Blanco GC-1 validation
    // (user reported 6000/day link seemed too loud; 4500/day matches perception).
    (3240.0, 360.0, 855.0, 45.0),      // 10 motorway_link — 4500
    (1755.0, 180.0, 270.0, 45.0),      // 11 trunk_link    — 2250
    (1120.5, 81.0, 121.5, 27.0),       // 12 primary_link  — 1350
];

// ─── City ids — synced with scripts/h3-admin-metros.json ───────────────────

pub const CITY_SAO_PAULO: u16 = 1;
pub const CITY_RIO: u16 = 2;
pub const CITY_BUENOS_AIRES: u16 = 3;
pub const CITY_LIMA: u16 = 4;
pub const CITY_SANTIAGO: u16 = 5;
pub const CITY_BOGOTA: u16 = 6;
pub const CITY_MEXICO_CITY: u16 = 7;
pub const CITY_CARACAS: u16 = 8;
pub const CITY_MOSCOW: u16 = 9;
pub const CITY_ISTANBUL: u16 = 10;
pub const CITY_LONDON: u16 = 11;
pub const CITY_PARIS: u16 = 12;
pub const CITY_BERLIN: u16 = 13;
pub const CITY_MADRID: u16 = 14;
pub const CITY_ROME: u16 = 15;
pub const CITY_TOKYO: u16 = 16;
pub const CITY_SEOUL: u16 = 17;
pub const CITY_BEIJING: u16 = 18;
pub const CITY_SHANGHAI: u16 = 19;
pub const CITY_DELHI: u16 = 20;
pub const CITY_MUMBAI: u16 = 21;
pub const CITY_BANGKOK: u16 = 22;
pub const CITY_JAKARTA: u16 = 23;
pub const CITY_MANILA: u16 = 24;
pub const CITY_NEW_YORK: u16 = 25;
pub const CITY_LOS_ANGELES: u16 = 26;
pub const CITY_CHICAGO: u16 = 27;
pub const CITY_CAIRO: u16 = 28;
pub const CITY_LAGOS: u16 = 29;
pub const CITY_JOHANNESBURG: u16 = 30;
pub const CITY_PRAGUE: u16 = 31;

// ─── Cascade resolver ──────────────────────────────────────────────────────

/// Returns the best-known default (light, medium, heavy, moto) AADT for a
/// segment with no spatial / ref / service-tree data. Cascades most-specific
/// → least-specific: city → country → continent → world. `class` clamps to
/// the WORLD_DEFAULT array bounds.
pub fn resolve_traffic_default(class: u8, admin: Admin) -> Aadt {
    if admin.city_id != 0 {
        if let Some(v) = city_default(admin.city_id, class) {
            return v;
        }
    }
    if let Some(v) = country_default(&admin.country_iso, class) {
        return v;
    }
    if let Some(v) = continent_default(admin.continent, class) {
        return v;
    }
    let idx = (class as usize).min(WORLD_DEFAULT.len() - 1);
    WORLD_DEFAULT[idx]
}

// ─── City defaults ─────────────────────────────────────────────────────────
// One arm per (city_id, class). Values reflect each metro's published or
// enricher-coded tier defaults. Missing classes fall through to country.

fn city_default(city_id: u16, class: u8) -> Option<Aadt> {
    match (city_id, class) {
        // ─── São Paulo + Rio — BR tier-1 (×2.0) split 70/10/15/5 ─────────
        // Source: pipeline/enrich-roads-br.ts CLASS_AADT × tierMultiplier(1)
        // × splitVehicles(tier=1).
        (CITY_SAO_PAULO, 0) | (CITY_RIO, 0) => Some((70000.0, 10000.0, 15000.0, 5000.0)), // 100k motorway
        (CITY_SAO_PAULO, 1) | (CITY_RIO, 1) => Some((35000.0, 5000.0, 7500.0, 2500.0)),   // 50k trunk
        (CITY_SAO_PAULO, 2) | (CITY_RIO, 2) => Some((16800.0, 2400.0, 3600.0, 1200.0)),   // 24k primary
        (CITY_SAO_PAULO, 3) | (CITY_RIO, 3) => Some((7000.0, 1000.0, 1500.0, 500.0)),     // 10k secondary
        (CITY_SAO_PAULO, 4) | (CITY_RIO, 4) => Some((2800.0, 400.0, 600.0, 200.0)),       // 4k tertiary
        (CITY_SAO_PAULO, 5) | (CITY_RIO, 5) => Some((1400.0, 200.0, 300.0, 100.0)),       // 2k residential

        // ─── Bangkok — TH tier-1 (×1.5) split 60/8/7/25 ────────────────────
        // Source: pipeline/enrich-roads-th.ts THBKK_MULT = 1.5 + thaiClassSplit(isBangkok=true).
        (CITY_BANGKOK, 0) => Some((54000.0, 7200.0, 6300.0, 22500.0)), // 90k motorway
        (CITY_BANGKOK, 1) => Some((27000.0, 3600.0, 3150.0, 11250.0)), // 45k trunk
        (CITY_BANGKOK, 2) => Some((13500.0, 1800.0, 1575.0, 5625.0)),  // 22.5k primary
        (CITY_BANGKOK, 3) => Some((5400.0, 720.0, 630.0, 2250.0)),     // 9k secondary
        (CITY_BANGKOK, 4) => Some((2250.0, 300.0, 263.0, 937.0)),      // 3.75k tertiary
        (CITY_BANGKOK, 5) => Some((1080.0, 144.0, 126.0, 450.0)),      // 1.8k residential

        _ => None,
    }
}

// ─── Country defaults ──────────────────────────────────────────────────────
// Two-layer policy:
//   (a) Explicit arm for a country whose national road enricher publishes
//       per-class AADT (currently BR rural + TH rural). Takes priority.
//   (b) Data-driven fallback from `country_defaults_generated::country_scale`
//       — World Bank GDP-per-capita-PPP ratio vs DE, clamped [0.15, 1.3],
//       applied to motorway/trunk/primary/link classes. Local roads
//       (class 3-9) stay at WORLD regardless.
//
// The generated table (224 countries, WB 2022) replaces the earlier
// hand-curated tier buckets — refresh via
// `node scripts/fetch-wb-country-data.mjs && node scripts/gen-country-defaults-rs.mjs`.
// Empirical basis: Dargay, Gately & Sommer 2007 "Vehicle Ownership and
// Income Growth, Worldwide" — motorization ~ sqrt(GDP_PPP) over the mid
// range with saturation at the high end.

/// Classes whose default AADT scales with country GDP — motorway, trunk,
/// primary and their ramp classes. Local roads (3-9) stay at WORLD because
/// informal transport, cycling and pedestrian traffic decorrelate local
/// AADT from GDP.
const GDP_SCALED_CLASSES: &[u8] = &[0, 1, 2, 10, 11, 12];

fn country_default(iso: &[u8; 2], class: u8) -> Option<Aadt> {
    // (a) Explicit data-driven arms — BR, TH rural from national enrichers.
    match (iso, class) {
        // ─── Brazil rural (tier 0) — split 60/10/25/5 ────────────────────
        // Source: pipeline/enrich-roads-br.ts CLASS_AADT rural × splitVehicles(tier=0).
        (b"BR", 0) => return Some((30000.0, 5000.0, 12500.0, 2500.0)), // 50k motorway
        (b"BR", 1) => return Some((15000.0, 2500.0, 6250.0, 1250.0)),  // 25k trunk
        (b"BR", 2) => return Some((7200.0, 1200.0, 3000.0, 600.0)),    // 12k primary
        (b"BR", 3) => return Some((3000.0, 500.0, 1250.0, 250.0)),     // 5k secondary
        (b"BR", 4) => return Some((1200.0, 200.0, 500.0, 100.0)),      // 2k tertiary
        (b"BR", 5) => return Some((600.0, 100.0, 250.0, 50.0)),        // 1k residential
        (b"BR", 6) => return Some((240.0, 40.0, 100.0, 20.0)),         // 400 living_street

        // ─── Thailand rural — split 62/10/13/15 ───────────────────────────
        // Source: pipeline/enrich-roads-th.ts THAI_RURAL class defaults
        // × thaiClassSplit(isBangkok=false). Rural baseline, Bangkok hex
        // overrides via CITY_BANGKOK above.
        (b"TH", 0) => return Some((37200.0, 6000.0, 7800.0, 9000.0)),  // 60k motorway
        (b"TH", 1) => return Some((18600.0, 3000.0, 3900.0, 4500.0)),  // 30k trunk
        (b"TH", 2) => return Some((9300.0, 1500.0, 1950.0, 2250.0)),   // 15k primary
        (b"TH", 3) => return Some((3720.0, 600.0, 780.0, 900.0)),      // 6k secondary
        (b"TH", 4) => return Some((1550.0, 250.0, 325.0, 375.0)),      // 2.5k tertiary
        (b"TH", 5) => return Some((744.0, 120.0, 156.0, 180.0)),       // 1.2k residential

        _ => {}
    }

    // (b) WB GDP-scaled fallback from WORLD_DEFAULT.
    if !GDP_SCALED_CLASSES.contains(&class) {
        // Local roads: don't scale with GDP.
        return None;
    }
    let scale = crate::country_defaults_generated::country_scale(iso)?;
    let class_idx = (class as usize).min(WORLD_DEFAULT.len() - 1);
    let base = WORLD_DEFAULT[class_idx];
    Some((base.0 * scale, base.1 * scale, base.2 * scale, base.3 * scale))
}

// ─── Continent defaults ────────────────────────────────────────────────────
// Sparse — only where a continent-wide skew is known to diverge from the EU
// baseline (e.g. Africa has a sparser motorway network, so the class-0
// default is lower).

fn continent_default(continent: Continent, class: u8) -> Option<Aadt> {
    // Reached only when country arm returned None (usually because the
    // ISO is not in the WB dataset or the class isn't GDP-scaled).
    // We still apply continent scaling for GDP-scaled classes because
    // those are the ones where the signal matters — local roads fall
    // through to WORLD_DEFAULT.
    if !GDP_SCALED_CLASSES.contains(&class) {
        return None;
    }
    let scale = crate::country_defaults_generated::continent_scale(continent)?;
    let class_idx = (class as usize).min(WORLD_DEFAULT.len() - 1);
    let base = WORLD_DEFAULT[class_idx];
    Some((base.0 * scale, base.1 * scale, base.2 * scale, base.3 * scale))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admin_for(iso: &[u8; 2], city: u16, continent: Continent) -> Admin {
        Admin {
            continent,
            country_iso: *iso,
            city_id: city,
        }
    }

    #[test]
    fn world_default_matches_legacy_motorway() {
        // Baseline check: cascade with Admin::UNKNOWN = WORLD_DEFAULT.
        assert_eq!(
            resolve_traffic_default(0, Admin::UNKNOWN),
            WORLD_DEFAULT[0]
        );
    }

    #[test]
    fn us_scales_below_world_via_sparse_density() {
        // US pop_density ~37/km² (sparse relative to EU) → scale ≈ 0.89
        // → motorway ≈ 27k. (I.3 density-based, ±30% band.)
        let a = admin_for(b"US", 0, Continent::NorthAmerica);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!(total > 24_000.0 && total < 30_000.0, "US motorway ≈ 27k, got {}", total);
    }

    #[test]
    fn brazil_rural_motorway_is_50k() {
        let a = admin_for(b"BR", 0, Continent::SouthAmerica);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!((total - 50000.0).abs() < 1.0, "BR rural motorway total should be 50k, got {}", total);
    }

    #[test]
    fn sao_paulo_tier1_motorway_is_100k() {
        let a = admin_for(b"BR", CITY_SAO_PAULO, Continent::SouthAmerica);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!((total - 100000.0).abs() < 1.0, "SP motorway total should be 100k, got {}", total);
    }

    #[test]
    fn bangkok_motorway_is_90k_with_heavy_moto_share() {
        let a = admin_for(b"TH", CITY_BANGKOK, Continent::Asia);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!((total - 90000.0).abs() < 1.0, "BKK motorway total should be 90k, got {}", total);
        // Bangkok split is 60/8/7/25 — motorcycles 25 %.
        assert!(x / total > 0.20 && x / total < 0.30, "moto share should be ~25% in BKK, got {}", x / total);
    }

    #[test]
    fn thailand_rural_motorway_is_60k() {
        let a = admin_for(b"TH", 0, Continent::Asia);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!((total - 60000.0).abs() < 1.0, "TH rural motorway total should be 60k, got {}", total);
    }

    #[test]
    fn city_overrides_country() {
        // If admin.city_id matches, city wins over country default.
        let sp = admin_for(b"BR", CITY_SAO_PAULO, Continent::SouthAmerica);
        let br_rural = admin_for(b"BR", 0, Continent::SouthAmerica);
        let sp_motorway = resolve_traffic_default(0, sp).0;
        let br_motorway = resolve_traffic_default(0, br_rural).0;
        assert!(sp_motorway > br_motorway, "SP tier-1 > BR rural");
    }

    #[test]
    fn unknown_city_falls_through_to_country() {
        // Brazilian hex with no metro match (city_id=0) gets BR country default.
        let a = admin_for(b"BR", 0, Continent::SouthAmerica);
        assert_eq!(
            resolve_traffic_default(0, a),
            (30000.0, 5000.0, 12500.0, 2500.0)
        );
    }

    #[test]
    fn dz_algeria_scales_from_density() {
        // Algeria density ~19/km² (sparse) → density-based scale ≈ 0.77
        // → motorway ≈ 23k. (I.3 density-based.)
        let a = admin_for(b"DZ", 0, Continent::Africa);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!(total > 20_000.0 && total < 26_000.0, "DZ motorway ≈ 23k, got {}", total);
    }

    #[test]
    fn class_out_of_range_clamps() {
        // Classes ≥ 13 clamp to primary_link (class 12) as deterministic fallback.
        let v = resolve_traffic_default(200, Admin::UNKNOWN);
        assert_eq!(v, WORLD_DEFAULT[12]);
    }

    // ── Density-based country scaling tests (plan v5 §I.3 revised) ──────
    #[test]
    fn de_dense_country_hits_upper_clamp() {
        // DE density 238/km² → tanh ≈ 0.96 → scale clamps at 1.3 → 39k.
        let a = admin_for(b"DE", 0, Continent::Europe);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!(total > 37_000.0 && total < 40_000.0, "DE motorway ≈ 39k, got {}", total);
    }

    #[test]
    fn high_density_country_scales_up() {
        // NG (Nigeria) density ~230/km² → scale ≈ 1.3 (upper clamp)
        // → motorway ≈ 39k. Data-driven: dense networks concentrate traffic.
        let a = admin_for(b"NG", 0, Continent::Africa);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!(total > 36_000.0 && total < 40_000.0, "NG motorway ≈ 39k, got {}", total);
    }

    #[test]
    fn sparse_country_scales_down() {
        // MN (Mongolia) density ~2/km² → tanh → scale 0.70 (lower clamp)
        // → motorway ≈ 21k. Matches user's Norway-Egypt intuition.
        let a = admin_for(b"MN", 0, Continent::Asia);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!(total > 19_000.0 && total < 23_000.0, "MN motorway ≈ 21k, got {}", total);
    }

    #[test]
    fn country_local_roads_are_not_scaled() {
        // Classes ≥ 3 never scale by GDP — they go straight to WORLD.
        for iso in [b"NG", b"IN", b"LU", b"DE"] {
            for class in [3u8, 4, 5, 6, 7, 8, 9] {
                let a = admin_for(iso, 0, Continent::Unknown);
                assert_eq!(
                    resolve_traffic_default(class, a),
                    WORLD_DEFAULT[class as usize],
                    "{:?} class={} should be WORLD",
                    std::str::from_utf8(iso).unwrap(),
                    class
                );
            }
        }
    }

    #[test]
    fn unknown_country_falls_through_to_continent_or_world() {
        // ZZ is an invalid ISO — the country_scale table returns None.
        // Continent::Unknown → cascade lands on WORLD.
        let a = admin_for(b"ZZ", 0, Continent::Unknown);
        assert_eq!(resolve_traffic_default(0, a), WORLD_DEFAULT[0]);
    }

    #[test]
    fn continent_arm_applies_density_scale() {
        // Unknown ISO in Africa continent → Africa pop-weighted density scale.
        // Africa mean scale ≈ 1.065 → motorway ≈ 32k.
        let a = admin_for(b"ZZ", 0, Continent::Africa);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        let total = l + m + h + x;
        assert!(total > 30_000.0 && total < 34_000.0, "Africa continent mtw ≈ 32k, got {}", total);
    }

    #[test]
    fn explicit_br_takes_priority_over_gdp_scale() {
        // BR is in WB dataset (would give ~15k motorway from sqrt(17k/69k) × 30k ≈ 15k),
        // but the explicit arm is 50k — that must win.
        let a = admin_for(b"BR", 0, Continent::SouthAmerica);
        let (l, m, h, x) = resolve_traffic_default(0, a);
        assert!((l + m + h + x - 50000.0).abs() < 1.0);
    }
}
