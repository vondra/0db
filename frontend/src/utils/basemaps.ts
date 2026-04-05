import { CARTO_VECTOR_SOURCE, CARTO_GLYPHS, CARTO_SPRITE } from './label-layers'

export type BasemapId = 'standard' | 'terrain' | 'satellite'
export const DEFAULT_BASEMAP: BasemapId = 'standard'

export interface BasemapDef {
  id: BasemapId
  label: string
  style: string | maplibregl.StyleSpecification
}

export const BASEMAPS: BasemapDef[] = [
  {
    id: 'standard',
    label: 'Standard',
    style: 'https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json',
  },
  {
    id: 'terrain',
    label: 'Terrain',
    style: {
      version: 8,
      sources: {
        opentopomap: {
          type: 'raster',
          tiles: [
            'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
            'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
            'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          attribution: '&copy; OpenStreetMap, &copy; OpenTopoMap',
        },
      },
      layers: [{ id: 'opentopomap', type: 'raster', source: 'opentopomap' }],
    },
  },
  {
    id: 'satellite',
    label: 'Satellite',
    style: {
      version: 8,
      glyphs: CARTO_GLYPHS,
      sprite: CARTO_SPRITE,
      sources: {
        esri: {
          type: 'raster',
          tiles: [
            'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          attribution: '&copy; Esri, Maxar, Earthstar Geographics, &copy; CARTO',
        },
        carto: CARTO_VECTOR_SOURCE,
      },
      layers: [{ id: 'esri-imagery', type: 'raster', source: 'esri' }],
    },
  },
]

export function getBasemapStyle(id: BasemapId): string | maplibregl.StyleSpecification {
  return BASEMAPS.find(b => b.id === id)?.style ?? BASEMAPS[0].style
}
