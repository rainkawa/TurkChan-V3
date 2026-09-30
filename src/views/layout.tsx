import type { FC, Child } from 'hono/jsx'
import { t } from '../i18n/tr'
import { profilePath } from './helpers'
import { isAdminPower } from '../services/ranks'
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
  /** Okunmamış bildirim sayısı (başlıktaki zil rozeti). */
  unread?: number
  /** Okunmamış DM sayısı (başlıktaki mesaj rozeti ve alt bar). */
  dmUnread?: number
  og?: OgTags
  flash?: { kind: 'ok' | 'error' | 'warn'; message: string } | null
  /** Bottom-nav active section. */
  active?: 'home' | 'communities' | 'create' | 'inbox' | 'messages' | 'me'
  /** Tam ekran görünüm: alt bar gizlenir, sayfa kendi içinde kaydırılır (sohbet). */
  immersive?: boolean
  /** Suppress the bottom bar (not used on the profile page itself). */
  children?: Child
}

const BrandMark: FC<{ size?: number; class?: string }> = ({ size = 26, class: cls = '' }) => (
  <svg
    class={`brand-mark ${cls}`.trim()}
    width={String(size)}
    height={String(size)}
    viewBox="0 0 64 64"
    role="img"
    aria-label={t.siteName}
  >
    <rect width="64" height="64" rx="14" fill="var(--brand)" />
    <path
      d="M14 46V20a4 4 0 0 1 4-4h20a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H26l-8 8v-8h-4z"
      fill="#fff"
    />
    <path d="M26 26h16M26 32h10" stroke="var(--brand)" stroke-width="3" stroke-linecap="round" />
  </svg>
)

const NavIcon: FC<{ name: 'home' | 'communities' | 'create' | 'inbox' | 'me' }> = ({ name }) => {
  if (name === 'home') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 10.5 12 3l9 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M5.5 9.5V20h13V9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    )
  }
  if (name === 'communities') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2" />
        <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <path d="M16 6.5a3 3 0 0 1 0 5.5M18 19c0-2.2-.8-3.8-2-4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    )
  }
  if (name === 'create') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
      </svg>
    )
  }
  if (name === 'inbox') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 13h5l1.5 3h5L16 13h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M5 5h14l2 8v6H3v-6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.5" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  )
}

export const Layout: FC<LayoutProps> = ({
  title,
  viewer,
  unread = 0,
  dmUnread = 0,
  og,
  flash,
  active,
  immersive,
  children,
}) => {
  const meHref = viewer ? profilePath(viewer.username) : '/login'
  // Rozetler kırmızı; bildirim ve DM sayıları birlikte gösterilir.
  const totalBadge = unread + dmUnread
  const badgeText = (n: number) => (n > 99 ? '99+' : String(n))
  return (
    <html lang="tr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{title ? `${title} · ${t.siteName}` : t.siteTitle}</title>
        <meta name="description" content={t.ogDescription} />
        <meta name="theme-color" content="#ffffff" />
        <link rel="icon" href="/static/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/static/favicon.svg" />
        <link rel="stylesheet" href="/static/style.css" />
        {og && (
          <>
            <meta property="og:title" content={og.title} />
            <meta property="og:type" content="website" />
            {og.description && <meta property="og:description" content={og.description} />}
            {og.image && <meta property="og:image" content={og.image} />}
            {og.url && <meta property="og:url" content={og.url} />}
            <meta property="og:site_name" content={t.siteName} />
            <meta property="og:locale" content="tr_TR" />
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content={og.title} />
            {og.description && <meta name="twitter:description" content={og.description} />}
          </>
        )}
      </head>
      <body class={`${viewer ? 'is-member' : 'is-guest'}${immersive ? ' is-chat' : ''}`}>
        <a class="skip-link" href="#main">{t.nav.mainNavigation}</a>
        {viewer && (
          <>

        <header class="app-header">
          {/*
            İki satırlı üst bölüm:
              1) Logo — tam ortada, tek satırda.
              2) hamburger · arama · bildirim
            Küçük favicon ikonu kaldırıldı; marka artık kelime logosu.
          */}
          <div class="app-header-brand">
            <a class="wordmark" href="/" aria-label={t.siteName}>
              <img src="/static/logo.svg" alt={t.siteName} width="150" height="40" />
            </a>
          </div>

          <div class="app-header-inner">
            <button
              class="icon-btn drawer-toggle"
              type="button"
              data-drawer-toggle
              aria-label={t.nav.openMenu}
              aria-controls="site-drawer"
              aria-expanded="false"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>

            <form class="app-search" action="/search" method="get" role="search">
              <svg class="app-search-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
                <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              <input
                type="search"
                name="q"
                placeholder={t.nav.searchPlaceholder}
                aria-label={t.nav.searchPlaceholder}
                autocomplete="off"
              />
            </form>

            <a
              class="icon-btn header-bell"
              href="/notifications"
              aria-label={t.nav.notifications}
              data-notification-badge={String(totalBadge)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                <path d="M10 18a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              {totalBadge > 0 && <span class="notif-badge">{badgeText(totalBadge)}</span>}
            </a>
          </div>
        </header>

        <div class="drawer" id="site-drawer" data-drawer hidden>
          <div class="drawer-scrim" data-drawer-close></div>
          <nav class="drawer-panel" aria-label={t.nav.drawer}>
            <div class="drawer-head">
              <a class="brand" href="/">
                <BrandMark size={30} />
                <span>{t.siteName}</span>
              </a>
              <button class="icon-btn" type="button" data-drawer-close aria-label={t.nav.closeMenu}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </button>
            </div>
            <ul class="drawer-list">
              <li><a href="/">{t.nav.home}</a></li>
              <li><a href="/communities">{t.nav.communities}</a></li>
              <li><a href="/notifications">{t.nav.notifications}</a></li>
              {viewer && <li><a href="/messages">{t.nav.messages}</a></li>}
              {viewer && <li><a href={profilePath(viewer.username)}>{t.nav.profile}</a></li>}
              {viewer && <li><a href="/settings">{t.nav.settings}</a></li>}
              {isAdminPower(viewer) && <li><a href="/admin">{t.nav.admin}</a></li>}
              <li><a href="/privacy">{t.footer.privacy}</a></li>
            </ul>
            <div class="drawer-foot">
              {viewer ? (
                <form action="/logout" method="post">
                  <button class="btn secondary" type="submit">{t.nav.logout}</button>
                </form>
              ) : (
                <div class="drawer-auth">
                  <a class="btn" href="/login">{t.nav.login}</a>
                  <a class="btn secondary" href="/register">{t.nav.register}</a>
                </div>
              )}
            </div>
          </nav>
        </div>
          </>
        )}

        <main class="page" id="main">
          {flash && <div class={`flash ${flash.kind}`}>{flash.message}</div>}
          {children}
        </main>

        {viewer && !immersive && (
          <>
        <footer class="footer">
          <a href="/privacy">{t.footer.privacy}</a>
          <span>{t.tagline}</span>
        </footer>

        <nav class="bottom-nav" aria-label={t.nav.mainNavigation}>
          <a href="/" class={active === 'home' ? 'active' : ''} aria-current={active === 'home' ? 'page' : undefined}>
            <NavIcon name="home" />
            <span>{t.nav.home}</span>
          </a>
          <a
            href="/communities"
            class={active === 'communities' ? 'active' : ''}
            aria-current={active === 'communities' ? 'page' : undefined}
          >
            <NavIcon name="communities" />
            <span>{t.nav.communities}</span>
          </a>
          <a
            href={viewer ? '/submit' : '/register'}
            class={`bottom-create${active === 'create' ? ' active' : ''}`}
            aria-current={active === 'create' ? 'page' : undefined}
          >
            <span class="bottom-create-btn">
              <NavIcon name="create" />
            </span>
            <span>{t.nav.create}</span>
          </a>
          <a
            href="/messages"
            class={active === 'messages' ? 'active' : ''}
            aria-current={active === 'messages' ? 'page' : undefined}
          >
            <span class="bottom-inbox" data-notification-badge={String(totalBadge)}>
              <NavIcon name="inbox" />
              {totalBadge > 0 && <span class="notif-badge">{badgeText(totalBadge)}</span>}
            </span>
            <span>{t.nav.inbox}</span>
          </a>
          <a
            href={meHref}
            class={active === 'me' ? 'active' : ''}
            aria-current={active === 'me' ? 'page' : undefined}
          >
            <NavIcon name="me" />
            <span>{t.nav.me}</span>
          </a>
        </nav>
          </>
        )}

        <script src="/static/app.js" defer></script>
      </body>
    </html>
  )
}

export const ErrorPage: FC<{ viewer: UserRow | null; unread?: number; dmUnread?: number; heading: string; message: string }> = ({
  viewer,
  unread,
  dmUnread,
  heading,
  message,
}) => (
  <Layout title={heading} viewer={viewer} unread={unread} dmUnread={dmUnread}>
    <div class="card empty-state">
      <div class="big">{heading}</div>
      <p>{message}</p>
      <a class="btn" href="/">
        {t.errors.backHome}
      </a>
    </div>
  </Layout>
)
