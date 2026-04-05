import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

const DOCS_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'docs')

interface DocFrontmatter {
  title: string
  intro: string
  map?: { center: [number, number]; zoom: number }
  status?: string
}

function parseFrontmatter(raw: string): { data: DocFrontmatter; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { data: { title: '', intro: '' }, content: raw }

  const yaml = match[1]
  const data: Record<string, unknown> = {}
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (!kv) continue
    const [, key, val] = kv
    if (val.startsWith('{')) {
      try { data[key] = JSON.parse(val.replace(/(\w+):/g, '"$1":')) } catch { data[key] = val }
    } else {
      data[key] = val
    }
  }
  return { data: data as unknown as DocFrontmatter, content: match[2] }
}

function getChildren(dirPath: string): { slug: string; title: string; status: string | null }[] {
  if (!fs.existsSync(dirPath)) return []
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const children: { slug: string; title: string; status: string | null }[] = []

  for (const entry of entries) {
    if (entry.name === 'index.md') continue
    if (entry.isDirectory()) {
      const indexPath = path.join(dirPath, entry.name, 'index.md')
      if (fs.existsSync(indexPath)) {
        const { data } = parseFrontmatter(fs.readFileSync(indexPath, 'utf-8'))
        children.push({ slug: entry.name, title: data.title || entry.name, status: data.status ?? null })
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const slug = entry.name.replace(/\.md$/, '')
      const { data } = parseFrontmatter(fs.readFileSync(path.join(dirPath, entry.name), 'utf-8'))
      children.push({ slug, title: data.title || slug, status: data.status ?? null })
    }
  }
  return children.sort((a, b) => a.title.localeCompare(b.title))
}

function buildBreadcrumb(segments: string[]): { slug: string; title: string }[] {
  const crumbs: { slug: string; title: string }[] = []
  let currentPath = path.join(DOCS_DIR, 'about')

  const rootIndex = path.join(currentPath, 'index.md')
  if (fs.existsSync(rootIndex)) {
    const { data } = parseFrontmatter(fs.readFileSync(rootIndex, 'utf-8'))
    crumbs.push({ slug: '/about', title: data.title || 'About' })
  }

  for (let i = 0; i < segments.length; i++) {
    currentPath = path.join(currentPath, segments[i])
    const slug = '/about/' + segments.slice(0, i + 1).join('/')
    const indexFile = path.join(currentPath, 'index.md')
    const mdFile = currentPath + '.md'

    if (fs.existsSync(indexFile)) {
      const { data } = parseFrontmatter(fs.readFileSync(indexFile, 'utf-8'))
      crumbs.push({ slug, title: data.title || segments[i] })
    } else if (fs.existsSync(mdFile)) {
      const { data } = parseFrontmatter(fs.readFileSync(mdFile, 'utf-8'))
      crumbs.push({ slug, title: data.title || segments[i] })
    }
  }
  return crumbs
}

export async function docsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/docs/about', async () => serveDoc([]))
  app.get('/api/docs/about/*', async (request) => {
    const wildcard = (request.params as Record<string, string>)['*']
    return serveDoc(wildcard.split('/').filter(Boolean))
  })
}

function serveDoc(segments: string[]) {
  const aboutDir = path.join(DOCS_DIR, 'about')
  let filePath: string
  let dirPath: string

  if (segments.length === 0) {
    filePath = path.join(aboutDir, 'index.md')
    dirPath = aboutDir
  } else {
    const joined = path.join(aboutDir, ...segments)
    if (fs.existsSync(path.join(joined, 'index.md'))) {
      filePath = path.join(joined, 'index.md')
      dirPath = joined
    } else if (fs.existsSync(joined + '.md')) {
      filePath = joined + '.md'
      dirPath = ''
    } else {
      throw { statusCode: 404, message: 'Page not found' }
    }
  }

  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(path.resolve(DOCS_DIR))) {
    throw { statusCode: 404, message: 'Page not found' }
  }

  const raw = fs.readFileSync(filePath, 'utf-8')
  const { data, content } = parseFrontmatter(raw)

  return {
    title: data.title || '',
    intro: data.intro || '',
    map: data.map ?? null,
    status: data.status ?? null,
    body: content.trim(),
    children: getChildren(dirPath),
    breadcrumb: buildBreadcrumb(segments),
  }
}
