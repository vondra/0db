import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import { setDocumentTitle } from '../utils/page-title'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

interface DocData {
  title: string
  intro: string
  body: string
  children: { slug: string; title: string; status: string | null }[]
  breadcrumb: { slug: string; title: string }[]
}

const PROSE = [
  'prose prose-sm max-w-none',
  'prose-headings:text-foreground',
  // Classic descending hierarchy (owner 2026-07-10): the previous
  // h2-as-small-caps-eyebrow rendered section titles SMALLER than their
  // subsections and read as inverted importance.
  'prose-h2:text-2xl prose-h2:font-bold prose-h2:mt-12 prose-h2:mb-3',
  'prose-h3:text-lg prose-h3:font-semibold prose-h3:mt-8 prose-h3:mb-2',
  'prose-p:text-muted-foreground prose-p:leading-relaxed',
  'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
  'prose-li:text-muted-foreground',
  'prose-strong:text-foreground',
  'prose-table:text-sm prose-th:text-left prose-th:font-semibold prose-th:text-foreground prose-td:text-muted-foreground',
  'prose-code:text-xs prose-code:bg-muted prose-code:text-foreground prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md',
  'prose-pre:bg-muted prose-pre:text-xs prose-pre:rounded-lg prose-pre:border prose-pre:border-border',
  '[&_details]:border [&_details]:border-border [&_details]:rounded-lg [&_details]:px-4 [&_details]:py-2 [&_details]:my-3',
  '[&_details_summary]:cursor-pointer [&_details_summary]:text-foreground [&_details_summary]:font-medium [&_details_summary]:text-sm',
].join(' ')

/** Footer with the contact address assembled at render time from parts —
 *  the literal string never appears in the bundle or static HTML, which
 *  defeats source-grepping harvesters (the mailbot + Resend filtering handle
 *  whatever gets through anyway). */
function PageFooter() {
  const contact = ['info', '0db.app'].join('@')
  return (
    <div className="mt-12 flex items-center justify-between border-t border-border pt-6 text-sm text-muted-foreground/60">
      <a href="https://0db.app" className="hover:underline">0db.app</a>
      <a
        href="#contact"
        onClick={(e) => { e.preventDefault(); window.location.href = `mailto:${contact}` }}
        className="hover:underline"
      >
        {contact}
      </a>
    </div>
  )
}

export default function AboutPage() {
  const [doc, setDoc] = useState<DocData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const subpath = window.location.pathname.replace(/^\/about\/?/, '')
  const apiUrl = subpath ? `/api/docs/about/${subpath}` : '/api/docs/about'

  useEffect(() => {
    fetch(apiUrl)
      .then(res => { if (!res.ok) throw new Error(`${res.status}`); return res.json() })
      .then((data: DocData) => {
        setDoc(data)
        // Root About = "About - 0db.app"; subpages carry their own title
        // ("Czechia - 0db.app"). /about is a full page load, no restore needed.
        setDocumentTitle([data.breadcrumb.length > 1 ? data.title : 'About'])
      })
      .catch(err => setError(err.message))
  }, [apiUrl])

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'auto' }} className="bg-background">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <a href="/" className="text-sm text-primary hover:underline mb-6 inline-block">&larr; Back to map</a>

        {error && <div className="text-destructive">Error: {error}</div>}

        {doc && (
          <>
            {doc.breadcrumb.length > 1 && (
              <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-4">
                {doc.breadcrumb.map((crumb, i) => (
                  <span key={crumb.slug}>
                    {i > 0 && <span className="mx-1">/</span>}
                    {i < doc.breadcrumb.length - 1 ? (
                      <a href={crumb.slug} className="text-primary hover:underline">{crumb.title}</a>
                    ) : (
                      <span className="text-foreground font-medium">{crumb.title}</span>
                    )}
                  </span>
                ))}
              </nav>
            )}

            {doc.breadcrumb.length === 1 ? (
              <h1 className="mb-4 flex items-center gap-3">
                <img
                  src="/favicon.svg"
                  alt=""
                  className="size-14 shrink-0"
                />
                <span className="text-4xl font-semibold tracking-[-0.04em] text-foreground">{doc.title}</span>
              </h1>
            ) : (
              <h1 className="text-3xl font-bold text-foreground mb-2">{doc.title}</h1>
            )}
            {doc.intro && <p className="text-lg text-muted-foreground mb-6">{doc.intro}</p>}

            {doc.children.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-8">
                {doc.children.map(child => (
                  <a
                    key={child.slug}
                    href={`${window.location.pathname.replace(/\/$/, '')}/${child.slug}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-accent transition-colors"
                  >
                    <span className="text-sm font-medium text-foreground">{child.title}</span>
                    {child.status && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        child.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'
                      }`}>
                        {child.status}
                      </span>
                    )}
                  </a>
                ))}
              </div>
            )}

            {doc.body && (
              <div className={PROSE}>
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw]}
                  components={{
                    img: ({ src, alt, ...props }) => (
                      <img
                        src={src && !src.startsWith('http') ? `/api/docs/assets/${src}` : src}
                        alt={alt}
                        {...props}
                      />
                    ),
                  }}
                >
                  {doc.body.replace(/<!-- MAP -->/g, '')}
                </Markdown>
              </div>
            )}
          </>
        )}

        {!doc && !error && <div className="text-muted-foreground">Loading...</div>}

        <PageFooter />
      </div>
    </div>
  )
}
