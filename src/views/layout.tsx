import type { FC, Child } from 'hono/jsx'
import { t } from '../i18n/en'
import type { UserRow } from '../types'

export interface OgTags {
  title: string
  description?: string
  image?: string | null
  url?: string
}

export interface LayoutProps {
  title?: string
  viewer: UserRow | null
  unread?: number
  og?: OgTags
  flash?: { kind: 'ok' | 'error' | 'warn'; message: string } | null
  children?: Child
}

export const Layout: FC<LayoutProps> = ({ title, viewer, unread = 0, og, flash, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title ? `${title} · ${t.siteName}` : t.siteName}</title>
      <link rel="stylesheet" href="/static/style.css" />
      {og && (
        <>
          <meta property="og:title" content={og.title} />
          <meta property="og:type" content="website" />
          {og.description && <meta property="og:description" content={og.description} />}
          {og.image && <meta property="og:image" content={og.image} />}
          {og.url && <meta property="og:url" content={og.url} />}
          <meta property="og:site_name" content={t.siteName} />
        </>
      )}
    </head>
    <body>
      <header class="site-header">
        <div class="bar">
          <a class="brand" href="/">
            {t.siteName}
            <span class="dot">.</span>
          </a>
          <form class="header-search" action="/search" method="get">
            <input type="search" name="q" placeholder={t.nav.search} aria-label={t.nav.search} />
          </form>
          <nav class="header-nav" aria-label="Main navigation">
            <a href="/communities">{t.nav.communities}</a>
            {viewer ? (
              <>
                <a href="/notifications">
                  {t.nav.notifications}
                  {unread > 0 && <span class="notif-badge">{unread > 99 ? '99+' : unread}</span>}
                </a>
                {viewer.is_admin === 1 && <a href="/admin">{t.nav.admin}</a>}
                <a href={`/u/${viewer.username}`}>u/{viewer.username}</a>
                <form action="/logout" method="post" style="display:inline">
                  <button class="linklike" type="submit">
                    {t.nav.logout}
                  </button>
                </form>
              </>
            ) : (
              <>
                <a href="/login">{t.nav.login}</a>
                <a href="/register">{t.nav.register}</a>
              </>
            )}
          </nav>
        </div>
      </header>
      <main class="page">
        {flash && <div class={`flash ${flash.kind}`}>{flash.message}</div>}
        {children}
      </main>
      <footer class="footer">
        <a href="/privacy">{t.footer.privacy}</a>
        <span>{t.tagline}</span>
      </footer>
      <script src="/static/app.js" defer></script>
    </body>
  </html>
)

export const ErrorPage: FC<{ viewer: UserRow | null; unread?: number; heading: string; message: string }> = ({
  viewer,
  unread,
  heading,
  message,
}) => (
  <Layout title={heading} viewer={viewer} unread={unread}>
    <div class="card empty-state">
      <div class="big">{heading}</div>
      <p>{message}</p>
      <a class="btn" href="/">
        {t.errors.backHome}
      </a>
    </div>
  </Layout>
)
