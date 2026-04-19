/**
 * Central registry of data sources used to enrich roads, railways, buildings,
 * and industrial layers. Each row in an Arrow file (or nace-lookup.json entry)
 * carries a `dataset_id` pointing back here, so the popup can show the user
 * which dataset contributed the data.
 *
 * Conventions:
 *   - `id` is globally unique, monotonically assigned, NEVER recycled.
 *     Allocate with `npx tsx pipeline/lib/allocate-dataset-id.ts <layer> <key>`.
 *   - `key` is a stable slug; also unique.
 *   - `priority`: global datasets 50, national authority 80 (wins over global),
 *     regional/city 20, heuristic/synthetic 10, legacy sentinel 0.
 *   - ID = 0 is reserved for "unspecified" — pre-provenance legacy rows.
 *
 * See plan at /home/vondra/.claude/plans/cached-gliding-kettle.md for rationale.
 */

export interface Dataset {
  id: number
  layer: 'roads' | 'railways' | 'buildings' | 'industrial' | 'any'
  key: string
  name: string
  year: number | null
  license: string | null
  url: string | null
  priority: number
}

export const DATASETS: Dataset[] = [
  // ── Sentinel ──
  {
    id: 0,
    layer: 'any',
    key: 'unspecified',
    name: 'Unspecified / pre-provenance legacy',
    year: null,
    license: null,
    url: null,
    priority: 0,
  },

  // ── Roads: global ──
  {
    id: 10,
    layer: 'roads',
    key: 'eu-city-traffic',
    name: 'EU Harmonized Traffic Volumes (Nature Scientific Data)',
    year: 2023,
    license: 'CC-BY-4.0',
    url: 'https://github.com/XavB64/traffic-volume-data-EU-cities',
    priority: 50,
  },
  {
    id: 11,
    layer: 'roads',
    key: 'service-tree-heuristic',
    name: 'Service-tree residential flow heuristic',
    year: 2025,
    license: 'project-internal',
    url: null,
    priority: 10,
  },

  // ── Roads: national ──
  {
    id: 20,
    layer: 'roads',
    key: 'cz-rsd-scitani',
    name: 'ŘSD Celostátní sčítání dopravy',
    year: 2020,
    license: 'CC-BY-4.0',
    url: 'https://geoportal.rsd.cz/',
    priority: 80,
  },
  {
    id: 21,
    layer: 'roads',
    key: 'us-fhwa-hpms',
    name: 'FHWA Highway Performance Monitoring System',
    year: 2022,
    license: 'public-domain',
    url: 'https://www.fhwa.dot.gov/policyinformation/hpms.cfm',
    priority: 80,
  },
  {
    id: 22,
    layer: 'roads',
    key: 'de-bast-autobahn',
    name: 'BASt SVZ Autobahnen',
    year: 2021,
    license: 'DL-DE BY 2.0',
    url: 'https://www.bast.de/',
    priority: 80,
  },
  {
    id: 23,
    layer: 'roads',
    key: 'de-bast-bundesstrassen',
    name: 'BASt SVZ Bundesstraßen',
    year: 2021,
    license: 'DL-DE BY 2.0',
    url: 'https://www.bast.de/',
    priority: 80,
  },
  {
    id: 24,
    layer: 'roads',
    key: 'fr-cerema-tmja',
    name: 'Cerema Trafic Moyen Journalier Annuel',
    year: 2024,
    license: 'etalab-2.0',
    url: 'https://www.data.gouv.fr/',
    priority: 80,
  },

  // ── Railways: global ──
  {
    id: 100,
    layer: 'railways',
    key: 'global-gtfs-transit',
    name: 'Global GTFS transit feeds',
    year: 2025,
    license: 'mixed (per-operator)',
    url: null,
    priority: 50,
  },

  // ── Railways: national ──
  {
    id: 110,
    layer: 'railways',
    key: 'cz-szcd-gtfs',
    name: 'Správa železnic GTFS',
    year: 2025,
    license: 'CC-BY-4.0',
    url: 'https://www.spravazeleznic.cz/',
    priority: 80,
  },

  // ── Buildings ──
  {
    id: 200,
    layer: 'buildings',
    key: 'cz-ruian-vfr',
    name: 'ČÚZK RÚIAN VFR',
    year: 2024,
    license: 'CC-BY-4.0',
    url: 'https://www.cuzk.cz/Uvod/Produkty-a-sluzby/RUIAN/',
    priority: 80,
  },
  {
    id: 201,
    layer: 'buildings',
    key: 'es-catastro',
    name: 'Dirección General del Catastro',
    year: 2024,
    license: 'CC-BY-4.0',
    url: 'https://www.catastro.minhap.es/',
    priority: 80,
  },

  // ── Industrial: global ──
  {
    id: 300,
    layer: 'industrial',
    key: 'global-gppd',
    name: 'Global Power Plant Database',
    year: 2021,
    license: 'CC-BY-4.0',
    url: 'https://datasets.wri.org/dataset/globalpowerplantdatabase',
    priority: 50,
  },
  {
    id: 301,
    layer: 'industrial',
    key: 'global-uswtdb',
    name: 'US Wind Turbine Database',
    year: 2024,
    license: 'public-domain',
    url: 'https://eerscmap.usgs.gov/uswtdb/',
    priority: 80,
  },

  // ── Industrial: regional / continental ──
  {
    id: 310,
    layer: 'industrial',
    key: 'europe-eprtr',
    name: 'European Pollutant Release and Transfer Register',
    year: 2022,
    license: 'CC-BY-4.0',
    url: 'https://industry.eea.europa.eu/',
    priority: 70,
  },

  // ── Industrial: national ──
  {
    id: 320,
    layer: 'industrial',
    key: 'cz-irz',
    name: 'ČHMÚ Integrovaný registr znečišťování',
    year: 2023,
    license: 'CC-BY-4.0',
    url: 'https://www.irz.cz/',
    priority: 80,
  },
]

/** Fast lookups — built once at module load. */
export const DATASETS_BY_ID = new Map<number, Dataset>(DATASETS.map(d => [d.id, d]))
export const DATASETS_BY_KEY = new Map<string, Dataset>(DATASETS.map(d => [d.key, d]))

/** Convenience: returns the seeded "unspecified" entry (always id=0). */
export const UNSPECIFIED: Dataset = DATASETS_BY_ID.get(0)!
