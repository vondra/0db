//! Per-country and per-continent AADT scale factors relative to
//! WORLD_DEFAULT. Generated from `scripts/wb-country-2022.json`
//! by `scripts/gen-country-defaults-rs.mjs`.
//!
//! Source: World Bank indicator `EN.POP.DNST` (people per km², 2022).
//!
//! Method (plan v5 §I.3, density-based):
//!   scale(country) = clamp(0.7, 1.3,
//!                          1.0 + 0.3 × tanh(log₂(density / 60)))
//!
//! Why population density:
//!   AADT on an existing road is vehicle fleet / road km. Wealth drives
//!   motorization but sparse networks (Norway, Canada) dilute AADT and
//!   dense networks (Egypt, India) concentrate it. Density is the best
//!   single proxy we can pull from WB API; direct road_km + fleet have
//!   been discontinued since 2011.
//!
//!   tanh smooths the log-ratio so Singapore (8000/km²) and Macao
//!   (21000/km²) don't explode the scale. ±30% band is deliberately
//!   conservative — in the absence of direct fleet/road data we prefer
//!   modest departures from WORLD_DEFAULT over overconfident ones.
//!
//! Applied to motorway/trunk/primary/link classes (0/1/2/10/11/12) in
//! `defaults.rs::country_default`. Local road classes (3-9) stay at
//! WORLD_DEFAULT — density is still a weak signal for local streets,
//! whose AADT depends more on informal transport + pedestrian share.
//!
//! Continent scales are population-weighted averages of their countries'
//! factors (reaches only hexes whose country centroid fell outside every
//! Natural Earth polygon, e.g. contested boundaries, micro-ocean cells).
//!
//! To refresh:
//!   node scripts/fetch-wb-country-data.mjs 2022
//!   node scripts/gen-country-defaults-rs.mjs
//!   # commit both JSON + this file

use crate::admin::Continent;

/// Per-country scale factor vs WORLD_DEFAULT motorway. 240 entries.
pub const COUNTRY_SCALES: &[(&[u8; 2], f64)] = &[
    (b"AD", 1.271), // pop_density 2022 169.6/km²
    (b"AE", 1.254), // pop_density 2022 141.9/km²
    (b"AF", 1.016), // pop_density 2022 62.2/km²
    (b"AG", 1.284), // pop_density 2022 211.0/km²
    (b"AL", 1.156), // pop_density 2022 89.5/km²
    (b"AM", 1.201), // pop_density 2022 105.3/km²
    (b"AO", 0.763), // pop_density 2022 28.6/km²
    (b"AR", 0.714), // pop_density 2022 16.6/km²
    (b"AS", 1.289), // pop_density 2022 241.7/km²
    (b"AT", 1.210), // pop_density 2022 109.6/km²
    (b"AU", 0.700), // pop_density 2022 3.4/km²
    (b"AW", 1.299), // pop_density 2022 596.2/km²
    (b"AZ", 1.232), // pop_density 2022 122.7/km²
    (b"BA", 1.018), // pop_density 2022 62.6/km²
    (b"BB", 1.299), // pop_density 2022 656.6/km²
    (b"BD", 1.300), // pop_density 2022 1300.4/km²
    (b"BE", 1.297), // pop_density 2022 383.0/km²
    (b"BF", 1.128), // pop_density 2022 82.3/km²
    (b"BG", 0.997), // pop_density 2022 59.6/km²
    (b"BH", 1.300), // pop_density 2022 1930.0/km²
    (b"BI", 1.299), // pop_density 2022 518.7/km²
    (b"BJ", 1.231), // pop_density 2022 122.0/km²
    (b"BM", 1.300), // pop_density 2022 1199.1/km²
    (b"BN", 1.145), // pop_density 2022 86.4/km²
    (b"BO", 0.705), // pop_density 2022 11.1/km²
    (b"BR", 0.745), // pop_density 2022 25.2/km²
    (b"BS", 0.840), // pop_density 2022 39.7/km²
    (b"BT", 0.726), // pop_density 2022 20.5/km²
    (b"BW", 0.700), // pop_density 2022 4.3/km²
    (b"BY", 0.886), // pop_density 2022 45.5/km²
    (b"BZ", 0.717), // pop_density 2022 17.7/km²
    (b"CA", 0.700), // pop_density 2022 4.4/km²
    (b"CD", 0.884), // pop_density 2022 45.2/km²
    (b"CF", 0.702), // pop_density 2022 8.2/km²
    (b"CG", 0.717), // pop_density 2022 17.7/km²
    (b"CH", 1.287), // pop_density 2022 222.2/km²
    (b"CI", 1.176), // pop_density 2022 95.6/km²
    (b"CL", 0.751), // pop_density 2022 26.3/km²
    (b"CM", 0.989), // pop_density 2022 58.5/km²
    (b"CN", 1.260), // pop_density 2022 150.4/km²
    (b"CO", 0.895), // pop_density 2022 46.6/km²
    (b"CR", 1.187), // pop_density 2022 99.5/km²
    (b"CU", 1.204), // pop_density 2022 106.5/km²
    (b"CV", 1.241), // pop_density 2022 129.0/km²
    (b"CW", 1.296), // pop_density 2022 345.3/km²
    (b"CY", 1.256), // pop_density 2022 144.1/km²
    (b"CZ", 1.251), // pop_density 2022 138.3/km²
    (b"DE", 1.289), // pop_density 2022 238.1/km²
    (b"DJ", 0.915), // pop_density 2022 49.1/km²
    (b"DK", 1.258), // pop_density 2022 147.6/km²
    (b"DM", 1.155), // pop_density 2022 89.1/km²
    (b"DO", 1.288), // pop_density 2022 233.0/km²
    (b"DZ", 0.721), // pop_density 2022 19.1/km²
    (b"EC", 1.076), // pop_density 2022 71.8/km²
    (b"EE", 0.781), // pop_density 2022 31.6/km²
    (b"EG", 1.217), // pop_density 2022 113.1/km²
    (b"ER", 0.761), // pop_density 2022 28.1/km²
    (b"ES", 1.176), // pop_density 2022 95.6/km²
    (b"ET", 1.213), // pop_density 2022 111.1/km²
    (b"EU", 1.215), // pop_density 2022 111.9/km²
    (b"FI", 0.719), // pop_density 2022 18.3/km²
    (b"FJ", 0.925), // pop_density 2022 50.3/km²
    (b"FM", 1.267), // pop_density 2022 160.2/km²
    (b"FO", 0.837), // pop_density 2022 39.4/km²
    (b"FR", 1.238), // pop_density 2022 126.5/km²
    (b"GA", 0.703), // pop_density 2022 9.4/km²
    (b"GB", 1.293), // pop_density 2022 279.4/km²
    (b"GD", 1.296), // pop_density 2022 343.9/km²
    (b"GE", 1.034), // pop_density 2022 65.0/km²
    (b"GH", 1.257), // pop_density 2022 145.7/km²
    (b"GI", 1.300), // pop_density 2022 3760.9/km²
    (b"GL", 0.700), // pop_density 2022 0.1/km²
    (b"GM", 1.291), // pop_density 2022 260.5/km²
    (b"GN", 0.979), // pop_density 2022 57.2/km²
    (b"GQ", 1.030), // pop_density 2022 64.3/km²
    (b"GR", 1.122), // pop_density 2022 81.0/km²
    (b"GT", 1.270), // pop_density 2022 166.6/km²
    (b"GU", 1.295), // pop_density 2022 305.9/km²
    (b"GW", 1.093), // pop_density 2022 74.9/km²
    (b"GY", 0.700), // pop_density 2022 3.9/km²
    (b"HK", 1.300), // pop_density 2022 6996.3/km²
    (b"HN", 1.170), // pop_density 2022 93.5/km²
    (b"HR", 1.059), // pop_density 2022 68.9/km²
    (b"HT", 1.298), // pop_density 2022 417.4/km²
    (b"HU", 1.201), // pop_density 2022 105.2/km²
    (b"ID", 1.258), // pop_density 2022 147.3/km²
    (b"IE", 1.097), // pop_density 2022 75.7/km²
    (b"IL", 1.298), // pop_density 2022 441.7/km²
    (b"IM", 1.258), // pop_density 2022 147.6/km²
    (b"IN", 1.299), // pop_density 2022 479.4/km²
    (b"IQ", 1.192), // pop_density 2022 101.5/km²
    (b"IR", 0.964), // pop_density 2022 55.2/km²
    (b"IS", 0.700), // pop_density 2022 3.8/km²
    (b"IT", 1.282), // pop_density 2022 199.6/km²
    (b"JM", 1.292), // pop_density 2022 262.2/km²
    (b"JO", 1.238), // pop_density 2022 126.8/km²
    (b"JP", 1.296), // pop_density 2022 343.3/km²
    (b"KE", 1.169), // pop_density 2022 93.4/km²
    (b"KG", 0.814), // pop_density 2022 36.4/km²
    (b"KH", 1.181), // pop_density 2022 97.4/km²
    (b"KI", 1.267), // pop_density 2022 161.1/km²
    (b"KM", 1.298), // pop_density 2022 448.2/km²
    (b"KN", 1.276), // pop_density 2022 179.7/km²
    (b"KP", 1.286), // pop_density 2022 218.7/km²
    (b"KR", 1.299), // pop_density 2022 529.4/km²
    (b"KW", 1.291), // pop_density 2022 257.6/km²
    (b"KY", 1.294), // pop_density 2022 298.3/km²
    (b"KZ", 0.701), // pop_density 2022 7.4/km²
    (b"LA", 0.789), // pop_density 2022 32.8/km²
    (b"LB", 1.299), // pop_density 2022 561.5/km²
    (b"LC", 1.294), // pop_density 2022 293.1/km²
    (b"LI", 1.290), // pop_density 2022 246.8/km²
    (b"LK", 1.297), // pop_density 2022 358.6/km²
    (b"LR", 0.969), // pop_density 2022 55.8/km²
    (b"LS", 1.095), // pop_density 2022 75.3/km²
    (b"LT", 0.884), // pop_density 2022 45.2/km²
    (b"LU", 1.291), // pop_density 2022 253.7/km²
    (b"LV", 0.773), // pop_density 2022 30.2/km²
    (b"LY", 0.700), // pop_density 2022 4.1/km²
    (b"MA", 1.134), // pop_density 2022 83.6/km²
    (b"MC", 1.300), // pop_density 2022 18680.9/km²
    (b"MD", 1.151), // pop_density 2022 88.1/km²
    (b"ME", 0.893), // pop_density 2022 46.4/km²
    (b"MF", 1.299), // pop_density 2022 577.4/km²
    (b"MG", 0.941), // pop_density 2022 52.3/km²
    (b"MH", 1.287), // pop_density 2022 222.7/km²
    (b"MK", 1.081), // pop_density 2022 72.6/km²
    (b"ML", 0.721), // pop_density 2022 18.9/km²
    (b"MM", 1.128), // pop_density 2022 82.4/km²
    (b"MN", 0.700), // pop_density 2022 2.2/km²
    (b"MO", 1.300), // pop_density 2022 20524.2/km²
    (b"MP", 1.189), // pop_density 2022 100.2/km²
    (b"MR", 0.700), // pop_density 2022 4.7/km²
    (b"MT", 1.300), // pop_density 2022 1659.7/km²
    (b"MU", 1.299), // pop_density 2022 632.2/km²
    (b"MV", 1.300), // pop_density 2022 1747.0/km²
    (b"MW", 1.286), // pop_density 2022 218.2/km²
    (b"MX", 1.042), // pop_density 2022 66.2/km²
    (b"MY", 1.202), // pop_density 2022 105.6/km²
    (b"MZ", 0.854), // pop_density 2022 41.5/km²
    (b"NA", 0.700), // pop_density 2022 3.5/km²
    (b"NC", 0.712), // pop_density 2022 15.7/km²
    (b"NE", 0.724), // pop_density 2022 20.0/km²
    (b"NG", 1.290), // pop_density 2022 245.0/km²
    (b"NI", 0.970), // pop_density 2022 55.9/km²
    (b"NL", 1.299), // pop_density 2022 525.7/km²
    (b"NO", 0.711), // pop_density 2022 15.0/km²
    (b"NP", 1.284), // pop_density 2022 207.3/km²
    (b"NR", 1.299), // pop_density 2022 590.0/km²
    (b"NZ", 0.722), // pop_density 2022 19.3/km²
    (b"OE", 0.835), // pop_density 2022 39.0/km²
    (b"OM", 0.711), // pop_density 2022 15.3/km²
    (b"PA", 0.995), // pop_density 2022 59.3/km²
    (b"PE", 0.750), // pop_density 2022 26.2/km²
    (b"PF", 1.121), // pop_density 2022 80.8/km²
    (b"PG", 0.734), // pop_density 2022 22.5/km²
    (b"PH", 1.297), // pop_density 2022 382.2/km²
    (b"PK", 1.295), // pop_density 2022 316.1/km²
    (b"PL", 1.229), // pop_density 2022 120.3/km²
    (b"PR", 1.297), // pop_density 2022 363.0/km²
    (b"PS", 1.300), // pop_density 2022 837.1/km²
    (b"PT", 1.218), // pop_density 2022 113.9/km²
    (b"PW", 0.831), // pop_density 2022 38.6/km²
    (b"PY", 0.716), // pop_density 2022 17.1/km²
    (b"QA", 1.288), // pop_density 2022 231.3/km²
    (b"RO", 1.130), // pop_density 2022 82.8/km²
    (b"RS", 1.114), // pop_density 2022 79.3/km²
    (b"RU", 0.702), // pop_density 2022 8.8/km²
    (b"RW", 1.299), // pop_density 2022 553.3/km²
    (b"SA", 0.711), // pop_density 2022 15.0/km²
    (b"SB", 0.759), // pop_density 2022 27.9/km²
    (b"SC", 1.291), // pop_density 2022 260.6/km²
    (b"SD", 0.752), // pop_density 2022 26.4/km²
    (b"SE", 0.748), // pop_density 2022 25.7/km²
    (b"SG", 1.300), // pop_density 2022 7851.0/km²
    (b"SI", 1.200), // pop_density 2022 104.9/km²
    (b"SK", 1.217), // pop_density 2022 113.0/km²
    (b"SL", 1.220), // pop_density 2022 114.7/km²
    (b"SM", 1.299), // pop_density 2022 562.6/km²
    (b"SN", 1.164), // pop_density 2022 91.7/km²
    (b"SO", 0.762), // pop_density 2022 28.4/km²
    (b"SR", 0.700), // pop_density 2022 3.9/km²
    (b"SS", 0.717), // pop_density 2022 17.4/km²
    (b"ST", 1.289), // pop_density 2022 235.7/km²
    (b"SV", 1.294), // pop_density 2022 303.1/km²
    (b"SX", 1.300), // pop_density 2022 1239.4/km²
    (b"SY", 1.232), // pop_density 2022 122.3/km²
    (b"SZ", 1.071), // pop_density 2022 70.9/km²
    (b"TC", 0.909), // pop_density 2022 48.3/km²
    (b"TD", 0.710), // pop_density 2022 14.7/km²
    (b"TG", 1.270), // pop_density 2022 167.1/km²
    (b"TH", 1.252), // pop_density 2022 140.4/km²
    (b"TJ", 1.085), // pop_density 2022 73.4/km²
    (b"TL", 1.165), // pop_density 2022 92.1/km²
    (b"TM", 0.712), // pop_density 2022 15.4/km²
    (b"TN", 1.108), // pop_density 2022 78.0/km²
    (b"TO", 1.257), // pop_density 2022 145.9/km²
    (b"TR", 1.212), // pop_density 2022 110.4/km²
    (b"TT", 1.292), // pop_density 2022 266.2/km²
    (b"TV", 1.296), // pop_density 2022 333.1/km²
    (b"TZ", 1.083), // pop_density 2022 73.1/km²
    (b"UA", 1.071), // pop_density 2022 70.8/km²
    (b"UG", 1.289), // pop_density 2022 236.0/km²
    (b"US", 0.816), // pop_density 2022 36.5/km²
    (b"UY", 0.722), // pop_density 2022 19.4/km²
    (b"UZ", 1.115), // pop_density 2022 79.3/km²
    (b"VC", 1.292), // pop_density 2022 261.7/km²
    (b"VE", 0.784), // pop_density 2022 32.0/km²
    (b"VG", 1.291), // pop_density 2022 255.5/km²
    (b"VI", 1.294), // pop_density 2022 301.2/km²
    (b"VN", 1.295), // pop_density 2022 318.0/km²
    (b"VU", 0.748), // pop_density 2022 25.7/km²
    (b"WS", 1.106), // pop_density 2022 77.4/km²
    (b"XC", 1.238), // pop_density 2022 127.3/km²
    (b"XD", 0.755), // pop_density 2022 27.0/km²
    (b"XE", 0.891), // pop_density 2022 46.1/km²
    (b"XF", 1.063), // pop_density 2022 69.6/km²
    (b"XG", 1.087), // pop_density 2022 73.8/km²
    (b"XH", 1.245), // pop_density 2022 133.0/km²
    (b"XI", 0.997), // pop_density 2022 59.6/km²
    (b"XJ", 0.789), // pop_density 2022 32.7/km²
    (b"XL", 0.968), // pop_density 2022 55.7/km²
    (b"XM", 0.869), // pop_density 2022 43.4/km²
    (b"XN", 1.268), // pop_density 2022 162.8/km²
    (b"XO", 1.138), // pop_density 2022 84.8/km²
    (b"XP", 1.170), // pop_density 2022 93.8/km²
    (b"XQ", 1.073), // pop_density 2022 71.3/km²
    (b"XT", 1.029), // pop_density 2022 64.2/km²
    (b"XU", 0.727), // pop_density 2022 20.8/km²
    (b"YE", 1.079), // pop_density 2022 72.4/km²
    (b"ZA", 0.934), // pop_density 2022 51.4/km²
    (b"ZF", 0.911), // pop_density 2022 48.5/km²
    (b"ZG", 0.935), // pop_density 2022 51.5/km²
    (b"ZH", 0.917), // pop_density 2022 49.3/km²
    (b"ZI", 0.962), // pop_density 2022 55.0/km²
    (b"ZJ", 0.788), // pop_density 2022 32.6/km²
    (b"ZM", 0.755), // pop_density 2022 27.1/km²
    (b"ZQ", 1.014), // pop_density 2022 62.0/km²
    (b"ZT", 1.070), // pop_density 2022 70.7/km²
    (b"ZW", 0.854), // pop_density 2022 41.5/km²
];

/// Binary-search lookup. O(log N), N = 240.
pub fn country_scale(iso: &[u8; 2]) -> Option<f64> {
    COUNTRY_SCALES
        .binary_search_by_key(iso, |(k, _)| **k)
        .ok()
        .map(|idx| COUNTRY_SCALES[idx].1)
}

/// Continent scale factor (population-weighted mean of member countries).
/// Returned when a hex has no country arm (e.g. oceanic cells near coasts).
pub fn continent_scale(continent: Continent) -> Option<f64> {
    match continent {
        Continent::Africa => Some(1.065),
        Continent::Asia => Some(1.255),
        Continent::Europe => Some(1.115),
        Continent::NorthAmerica => Some(0.921),
        Continent::Oceania => Some(0.729),
        Continent::SouthAmerica => Some(0.775),
        Continent::Unknown => None,
    }
}

