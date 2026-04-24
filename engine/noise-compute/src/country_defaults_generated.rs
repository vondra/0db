//! Per-country and per-continent AADT scale factors relative to
//! WORLD_DEFAULT. Generated from `scripts/wb-country-2022.json`
//! by `scripts/gen-country-defaults-rs.mjs`.
//!
//! Source: World Bank indicator `NY.GDP.PCAP.PP.CD`
//! (GDP per capita, PPP, current international USD), 2022.
//! Reference: DE ($69049 in 2022).
//!
//! Method:
//!   scale(country) = sqrt(GDP_PPP_country / GDP_PPP_DE)
//!                      .clamp(0.15, 1.3)
//!
//! Applied to motorway/trunk/primary/link classes (0/1/2/10/11/12) in
//! `defaults.rs::country_default`. Local road classes (3-9) stay at
//! WORLD_DEFAULT — local AADT decorrelates from GDP per capita.
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

/// Per-country scale factor vs WORLD_DEFAULT motorway. 224 entries.
pub const COUNTRY_SCALES: &[(&[u8; 2], f64)] = &[
    (b"AD", 0.996), // GDP_PPP 2022 $68470
    (b"AE", 1.043), // GDP_PPP 2022 $75072
    (b"AF", 0.175), // GDP_PPP 2022 $2123
    (b"AG", 0.658), // GDP_PPP 2022 $29934
    (b"AL", 0.566), // GDP_PPP 2022 $22138
    (b"AM", 0.527), // GDP_PPP 2022 $19161
    (b"AO", 0.373), // GDP_PPP 2022 $9588
    (b"AR", 0.657), // GDP_PPP 2022 $29809
    (b"AT", 1.022), // GDP_PPP 2022 $72065
    (b"AU", 0.978), // GDP_PPP 2022 $66103
    (b"AW", 0.778), // GDP_PPP 2022 $41759
    (b"AZ", 0.571), // GDP_PPP 2022 $22552
    (b"BA", 0.560), // GDP_PPP 2022 $21651
    (b"BB", 0.567), // GDP_PPP 2022 $22193
    (b"BD", 0.350), // GDP_PPP 2022 $8451
    (b"BE", 1.001), // GDP_PPP 2022 $69128
    (b"BF", 0.196), // GDP_PPP 2022 $2645
    (b"BG", 0.725), // GDP_PPP 2022 $36320
    (b"BH", 0.945), // GDP_PPP 2022 $61678
    (b"BI", 0.150), // GDP_PPP 2022 $1105
    (b"BJ", 0.236), // GDP_PPP 2022 $3844
    (b"BM", 1.234), // GDP_PPP 2022 $105142
    (b"BN", 1.088), // GDP_PPP 2022 $81802
    (b"BO", 0.422), // GDP_PPP 2022 $12307
    (b"BR", 0.537), // GDP_PPP 2022 $19877
    (b"BS", 0.730), // GDP_PPP 2022 $36791
    (b"BT", 0.467), // GDP_PPP 2022 $15064
    (b"BW", 0.538), // GDP_PPP 2022 $19977
    (b"BY", 0.642), // GDP_PPP 2022 $28429
    (b"BZ", 0.442), // GDP_PPP 2022 $13461
    (b"CA", 0.962), // GDP_PPP 2022 $63944
    (b"CD", 0.152), // GDP_PPP 2022 $1590
    (b"CF", 0.150), // GDP_PPP 2022 $1218
    (b"CG", 0.310), // GDP_PPP 2022 $6647
    (b"CH", 1.169), // GDP_PPP 2022 $94421
    (b"CI", 0.312), // GDP_PPP 2022 $6719
    (b"CL", 0.669), // GDP_PPP 2022 $30932
    (b"CM", 0.274), // GDP_PPP 2022 $5189
    (b"CN", 0.578), // GDP_PPP 2022 $23032
    (b"CO", 0.550), // GDP_PPP 2022 $20854
    (b"CR", 0.616), // GDP_PPP 2022 $26226
    (b"CV", 0.371), // GDP_PPP 2022 $9481
    (b"CW", 0.644), // GDP_PPP 2022 $28641
    (b"CY", 0.900), // GDP_PPP 2022 $55876
    (b"CZ", 0.876), // GDP_PPP 2022 $52947
    (b"DE", 1.000), // GDP_PPP 2022 $69049
    (b"DJ", 0.310), // GDP_PPP 2022 $6621
    (b"DK", 1.069), // GDP_PPP 2022 $78914
    (b"DM", 0.522), // GDP_PPP 2022 $18802
    (b"DO", 0.597), // GDP_PPP 2022 $24626
    (b"DZ", 0.479), // GDP_PPP 2022 $15836
    (b"EC", 0.469), // GDP_PPP 2022 $15198
    (b"EE", 0.836), // GDP_PPP 2022 $48218
    (b"EG", 0.504), // GDP_PPP 2022 $17527
    (b"ES", 0.863), // GDP_PPP 2022 $51399
    (b"ET", 0.203), // GDP_PPP 2022 $2845
    (b"EU", 0.920), // GDP_PPP 2022 $58484
    (b"FI", 0.949), // GDP_PPP 2022 $62133
    (b"FJ", 0.434), // GDP_PPP 2022 $12982
    (b"FM", 0.243), // GDP_PPP 2022 $4087
    (b"FO", 1.044), // GDP_PPP 2022 $75266
    (b"FR", 0.909), // GDP_PPP 2022 $57043
    (b"GA", 0.538), // GDP_PPP 2022 $19993
    (b"GB", 0.925), // GDP_PPP 2022 $59022
    (b"GD", 0.504), // GDP_PPP 2022 $17544
    (b"GE", 0.570), // GDP_PPP 2022 $22461
    (b"GH", 0.323), // GDP_PPP 2022 $7208
    (b"GL", 1.047), // GDP_PPP 2022 $75720
    (b"GM", 0.211), // GDP_PPP 2022 $3067
    (b"GN", 0.243), // GDP_PPP 2022 $4062
    (b"GQ", 0.513), // GDP_PPP 2022 $18140
    (b"GR", 0.757), // GDP_PPP 2022 $39612
    (b"GT", 0.434), // GDP_PPP 2022 $13014
    (b"GW", 0.201), // GDP_PPP 2022 $2789
    (b"GY", 0.758), // GDP_PPP 2022 $39711
    (b"HK", 0.997), // GDP_PPP 2022 $68602
    (b"HN", 0.314), // GDP_PPP 2022 $6805
    (b"HR", 0.781), // GDP_PPP 2022 $42125
    (b"HT", 0.218), // GDP_PPP 2022 $3275
    (b"HU", 0.802), // GDP_PPP 2022 $44366
    (b"ID", 0.455), // GDP_PPP 2022 $14285
    (b"IE", 1.300), // GDP_PPP 2022 $138523
    (b"IL", 0.881), // GDP_PPP 2022 $53619
    (b"IN", 0.365), // GDP_PPP 2022 $9207
    (b"IQ", 0.457), // GDP_PPP 2022 $14391
    (b"IR", 0.504), // GDP_PPP 2022 $17546
    (b"IS", 1.045), // GDP_PPP 2022 $75333
    (b"IT", 0.911), // GDP_PPP 2022 $57261
    (b"JM", 0.415), // GDP_PPP 2022 $11888
    (b"JO", 0.379), // GDP_PPP 2022 $9927
    (b"JP", 0.827), // GDP_PPP 2022 $47192
    (b"KE", 0.292), // GDP_PPP 2022 $5883
    (b"KG", 0.309), // GDP_PPP 2022 $6578
    (b"KH", 0.317), // GDP_PPP 2022 $6919
    (b"KI", 0.220), // GDP_PPP 2022 $3329
    (b"KM", 0.230), // GDP_PPP 2022 $3642
    (b"KN", 0.679), // GDP_PPP 2022 $31871
    (b"KR", 0.897), // GDP_PPP 2022 $55509
    (b"KW", 0.893), // GDP_PPP 2022 $55043
    (b"KY", 1.092), // GDP_PPP 2022 $82296
    (b"KZ", 0.721), // GDP_PPP 2022 $35895
    (b"LA", 0.356), // GDP_PPP 2022 $8766
    (b"LB", 0.422), // GDP_PPP 2022 $12293
    (b"LC", 0.597), // GDP_PPP 2022 $24599
    (b"LK", 0.453), // GDP_PPP 2022 $14194
    (b"LR", 0.157), // GDP_PPP 2022 $1692
    (b"LS", 0.200), // GDP_PPP 2022 $2761
    (b"LT", 0.859), // GDP_PPP 2022 $50936
    (b"LU", 1.300), // GDP_PPP 2022 $146919
    (b"LV", 0.766), // GDP_PPP 2022 $40559
    (b"LY", 0.421), // GDP_PPP 2022 $12266
    (b"MA", 0.367), // GDP_PPP 2022 $9310
    (b"MD", 0.488), // GDP_PPP 2022 $16453
    (b"ME", 0.637), // GDP_PPP 2022 $28050
    (b"MG", 0.158), // GDP_PPP 2022 $1717
    (b"MH", 0.328), // GDP_PPP 2022 $7431
    (b"MK", 0.592), // GDP_PPP 2022 $24212
    (b"ML", 0.209), // GDP_PPP 2022 $3014
    (b"MM", 0.288), // GDP_PPP 2022 $5732
    (b"MN", 0.487), // GDP_PPP 2022 $16402
    (b"MO", 0.964), // GDP_PPP 2022 $64194
    (b"MR", 0.306), // GDP_PPP 2022 $6485
    (b"MT", 0.937), // GDP_PPP 2022 $60589
    (b"MU", 0.624), // GDP_PPP 2022 $26874
    (b"MV", 0.576), // GDP_PPP 2022 $22881
    (b"MW", 0.160), // GDP_PPP 2022 $1778
    (b"MX", 0.579), // GDP_PPP 2022 $23135
    (b"MY", 0.706), // GDP_PPP 2022 $34420
    (b"MZ", 0.151), // GDP_PPP 2022 $1582
    (b"NA", 0.393), // GDP_PPP 2022 $10663
    (b"NE", 0.163), // GDP_PPP 2022 $1840
    (b"NG", 0.347), // GDP_PPP 2022 $8305
    (b"NI", 0.336), // GDP_PPP 2022 $7797
    (b"NL", 1.067), // GDP_PPP 2022 $78630
    (b"NO", 1.300), // GDP_PPP 2022 $125490
    (b"NP", 0.272), // GDP_PPP 2022 $5103
    (b"NR", 0.438), // GDP_PPP 2022 $13245
    (b"NZ", 0.885), // GDP_PPP 2022 $54034
    (b"OE", 0.907), // GDP_PPP 2022 $56825
    (b"OM", 0.786), // GDP_PPP 2022 $42616
    (b"PA", 0.725), // GDP_PPP 2022 $36333
    (b"PE", 0.491), // GDP_PPP 2022 $16669
    (b"PG", 0.253), // GDP_PPP 2022 $4420
    (b"PH", 0.383), // GDP_PPP 2022 $10131
    (b"PK", 0.293), // GDP_PPP 2022 $5920
    (b"PL", 0.823), // GDP_PPP 2022 $46778
    (b"PR", 0.810), // GDP_PPP 2022 $45328
    (b"PS", 0.299), // GDP_PPP 2022 $6163
    (b"PT", 0.810), // GDP_PPP 2022 $45250
    (b"PW", 0.499), // GDP_PPP 2022 $17185
    (b"PY", 0.487), // GDP_PPP 2022 $16347
    (b"QA", 1.300), // GDP_PPP 2022 $122921
    (b"RO", 0.780), // GDP_PPP 2022 $41979
    (b"RS", 0.615), // GDP_PPP 2022 $26143
    (b"RU", 0.770), // GDP_PPP 2022 $40939
    (b"RW", 0.212), // GDP_PPP 2022 $3099
    (b"SA", 1.021), // GDP_PPP 2022 $71968
    (b"SB", 0.190), // GDP_PPP 2022 $2496
    (b"SC", 0.659), // GDP_PPP 2022 $29973
    (b"SD", 0.220), // GDP_PPP 2022 $3355
    (b"SE", 0.986), // GDP_PPP 2022 $67076
    (b"SG", 1.300), // GDP_PPP 2022 $143095
    (b"SI", 0.871), // GDP_PPP 2022 $52347
    (b"SK", 0.776), // GDP_PPP 2022 $41562
    (b"SL", 0.213), // GDP_PPP 2022 $3144
    (b"SM", 1.049), // GDP_PPP 2022 $75941
    (b"SN", 0.256), // GDP_PPP 2022 $4530
    (b"SO", 0.150), // GDP_PPP 2022 $1486
    (b"SR", 0.539), // GDP_PPP 2022 $20079
    (b"ST", 0.296), // GDP_PPP 2022 $6034
    (b"SV", 0.415), // GDP_PPP 2022 $11876
    (b"SX", 0.840), // GDP_PPP 2022 $48761
    (b"SY", 0.263), // GDP_PPP 2022 $4772
    (b"SZ", 0.392), // GDP_PPP 2022 $10635
    (b"TC", 0.662), // GDP_PPP 2022 $30221
    (b"TD", 0.195), // GDP_PPP 2022 $2624
    (b"TG", 0.206), // GDP_PPP 2022 $2935
    (b"TH", 0.568), // GDP_PPP 2022 $22243
    (b"TJ", 0.256), // GDP_PPP 2022 $4514
    (b"TL", 0.288), // GDP_PPP 2022 $5730
    (b"TM", 0.515), // GDP_PPP 2022 $18340
    (b"TN", 0.444), // GDP_PPP 2022 $13619
    (b"TO", 0.325), // GDP_PPP 2022 $7296
    (b"TR", 0.757), // GDP_PPP 2022 $39564
    (b"TT", 0.691), // GDP_PPP 2022 $32979
    (b"TV", 0.286), // GDP_PPP 2022 $5661
    (b"TZ", 0.235), // GDP_PPP 2022 $3800
    (b"UA", 0.463), // GDP_PPP 2022 $14770
    (b"UG", 0.206), // GDP_PPP 2022 $2919
    (b"US", 1.062), // GDP_PPP 2022 $77861
    (b"UY", 0.691), // GDP_PPP 2022 $33001
    (b"UZ", 0.386), // GDP_PPP 2022 $10293
    (b"VC", 0.511), // GDP_PPP 2022 $18035
    (b"VI", 0.849), // GDP_PPP 2022 $49793
    (b"VN", 0.449), // GDP_PPP 2022 $13905
    (b"VU", 0.224), // GDP_PPP 2022 $3453
    (b"WS", 0.316), // GDP_PPP 2022 $6909
    (b"XC", 0.940), // GDP_PPP 2022 $60990
    (b"XD", 0.943), // GDP_PPP 2022 $61423
    (b"XE", 0.219), // GDP_PPP 2022 $3311
    (b"XF", 0.515), // GDP_PPP 2022 $18300
    (b"XG", 0.275), // GDP_PPP 2022 $5220
    (b"XH", 0.318), // GDP_PPP 2022 $6994
    (b"XI", 0.249), // GDP_PPP 2022 $4277
    (b"XJ", 0.537), // GDP_PPP 2022 $19941
    (b"XK", 0.449), // GDP_PPP 2022 $13951
    (b"XL", 0.244), // GDP_PPP 2022 $4096
    (b"XM", 0.182), // GDP_PPP 2022 $2276
    (b"XN", 0.358), // GDP_PPP 2022 $8826
    (b"XO", 0.447), // GDP_PPP 2022 $13817
    (b"XP", 0.466), // GDP_PPP 2022 $14991
    (b"XQ", 0.388), // GDP_PPP 2022 $10375
    (b"XT", 0.560), // GDP_PPP 2022 $21670
    (b"XU", 1.052), // GDP_PPP 2022 $76413
    (b"ZA", 0.462), // GDP_PPP 2022 $14749
    (b"ZF", 0.279), // GDP_PPP 2022 $5373
    (b"ZG", 0.272), // GDP_PPP 2022 $5118
    (b"ZH", 0.252), // GDP_PPP 2022 $4369
    (b"ZI", 0.300), // GDP_PPP 2022 $6220
    (b"ZJ", 0.549), // GDP_PPP 2022 $20842
    (b"ZM", 0.236), // GDP_PPP 2022 $3841
    (b"ZQ", 0.469), // GDP_PPP 2022 $15194
    (b"ZT", 0.461), // GDP_PPP 2022 $14703
    (b"ZW", 0.280), // GDP_PPP 2022 $5396
];

/// Binary-search lookup. O(log N), N = 224.
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
        Continent::Africa => Some(0.290),
        Continent::Asia => Some(0.472),
        Continent::Europe => Some(0.840),
        Continent::NorthAmerica => Some(0.862),
        Continent::Oceania => Some(0.758),
        Continent::SouthAmerica => Some(0.549),
        Continent::Unknown => None,
    }
}

