#!/usr/bin/env node
/**
 * Build-time sitemap generator: emits <outDir>/sitemap.xml listing the map
 * plus every public About page (derived from the committed docs/about tree,
 * so new country/continent pages join the sitemap automatically on the next
 * build). Runs as the last step of the frontend build scripts.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE_URL = 'https://quietmap.org'
const FRONTEND_ROOT = resolve(import.meta.dirname, '..')
const DOCS_ABOUT_DIR = resolve(FRONTEND_ROOT, '../docs/about')

const outDir = resolve(FRONTEND_ROOT, process.argv[2] ?? 'dist')

/** URL paths of one docs file: `europe/cz.md` → `/about/europe/cz`,
 *  `europe/index.md` → `/about/europe`, top-level `index.md` → `/about`. */
function docPathToUrl(relativePath) {
  const withoutExt = relativePath.replace(/\.md$/, '')
  const withoutIndex = withoutExt.replace(/(^|\/)index$/, '')
  return `/about${withoutIndex ? `/${withoutIndex}` : ''}`
}

function lastmodOf(absolutePath) {
  return statSync(absolutePath).mtime.toISOString().slice(0, 10)
}

function* walkMarkdown(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* walkMarkdown(join(dir, entry.name), `${prefix}${entry.name}/`)
    else if (entry.name.endsWith('.md')) yield { absolute: join(dir, entry.name), relative: `${prefix}${entry.name}` }
  }
}

const urls = [{ loc: '/', lastmod: lastmodOf(join(FRONTEND_ROOT, 'index.html')) }]
for (const doc of walkMarkdown(DOCS_ABOUT_DIR)) {
  urls.push({ loc: docPathToUrl(doc.relative), lastmod: lastmodOf(doc.absolute) })
}
urls.sort((a, b) => a.loc.localeCompare(b.loc))

const body = urls
  .map(({ loc, lastmod }) => `  <url><loc>${BASE_URL}${loc}</loc><lastmod>${lastmod}</lastmod></url>`)
  .join('\n')
writeFileSync(
  join(outDir, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
)
console.log(`sitemap: ${urls.length} urls → ${join(outDir, 'sitemap.xml')}`)
