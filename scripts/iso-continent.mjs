// ISO alpha-2 → continent — ONE table shared by
// scripts/gen-country-defaults-rs.mjs (continent scale averages) and
// pipeline/lib/admin-at.ts (AdminAt continent resolution). Must match
// engine/noise-compute/src/admin.rs::Continent and
// scripts/h3-admin-metros.json continent ids.
// Source: UN standard M49 region codes (https://unstats.un.org/unsd/methodology/m49/).
export const CONTINENT = {
  Europe: new Set('AD,AL,AM,AT,AX,AZ,BA,BE,BG,BY,CH,CY,CZ,DE,DK,EE,ES,FI,FO,FR,GB,GE,GG,GI,GR,HR,HU,IE,IM,IS,IT,JE,LI,LT,LU,LV,MC,MD,ME,MK,MT,NL,NO,PL,PT,RO,RS,RU,SE,SI,SJ,SK,SM,TR,UA,VA,XK'.split(',')),
  NorthAmerica: new Set('AG,AI,AW,BB,BL,BM,BQ,BS,BZ,CA,CR,CU,CW,DM,DO,GD,GL,GP,GT,HN,HT,JM,KN,KY,LC,MF,MQ,MS,MX,NI,PA,PM,PR,SV,SX,TC,TT,US,VC,VG,VI'.split(',')),
  SouthAmerica: new Set('AR,BO,BR,CL,CO,EC,FK,GF,GY,PE,PY,SR,UY,VE'.split(',')),
  Asia: new Set('AE,AF,BD,BH,BN,BT,CC,CN,CX,HK,ID,IL,IN,IO,IQ,IR,JO,JP,KG,KH,KP,KR,KW,KZ,LA,LB,LK,MM,MN,MO,MV,MY,NP,OM,PH,PK,PS,QA,SA,SG,SY,TH,TJ,TL,TM,TW,UZ,VN,YE'.split(',')),
  Africa: new Set('AO,BF,BI,BJ,BW,CD,CF,CG,CI,CM,CV,DJ,DZ,EG,EH,ER,ET,GA,GH,GM,GN,GQ,GW,KE,KM,LR,LS,LY,MA,MG,ML,MR,MU,MW,MZ,NA,NE,NG,RE,RW,SC,SD,SH,SL,SN,SO,SS,ST,SZ,TD,TG,TN,TZ,UG,YT,ZA,ZM,ZW'.split(',')),
  Oceania: new Set('AS,AU,CK,FJ,FM,GU,KI,MH,MP,NC,NF,NR,NU,NZ,PF,PG,PN,PW,SB,TK,TO,TV,UM,VU,WF,WS'.split(',')),
}

export function isoContinent(iso) {
  for (const [c, set] of Object.entries(CONTINENT)) if (set.has(iso)) return c
  return null
}
