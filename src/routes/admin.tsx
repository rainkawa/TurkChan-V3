import { Hono } from 'hono'
import type { Ctx } from '../context'
import { t, visibilityLabel } from '../i18n/tr'
import { Layout } from '../views/layout'
import { requireAdmin, getCommunityById } from '../services/access'
import {
  listUsers,
  listAllCommunities,
  suspendUser,
  unsuspendUser,
  setCommunityArchived,
  deleteCommunity,
  restoreCommunity,
  createInvite,
  listInvites,
  exportCommunity,
  getExport,
} from '../services/admin'
import { reportQueue } from '../services/reports'
import { siteAdminLog } from '../services/modlog'
import { getSettings, updateSettings, type SiteSettings } from '../services/settings'
import { getComment } from '../services/comments'
import { AppError, notFound } from '../services/errors'
import { relativeTime, formatDate } from '../views/helpers'
import { type AppEnv, formData, loginRedirect, setFlash, takeFlash, unread } from './helpers'
import { readFile } from 'node:fs/promises'

export function adminRoutes(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/admin', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    requireAdmin(viewer)
    const tab = c.req.query('tab') ?? 'reports'
    const settings = getSettings(ctx)
    const now = ctx.now()

    const tabs = (
      <nav class="sort-tabs">
        {(['reports', 'users', 'communities', 'settings', 'invites', 'log'] as const).map((tb) => (
          <a href={`/admin?tab=${tb}`} class={tab === tb ? 'active' : ''}>
            {tb === 'reports' ? t.admin.reports : tb === 'users' ? t.admin.users : tb === 'communities' ? t.admin.communities : tb === 'settings' ? t.admin.settings : tb === 'invites' ? t.admin.invites : t.admin.adminLog}
          </a>
        ))}
      </nav>
    )

    let content
    if (tab === 'users') {
      const query = c.req.query('q') ?? ''
      const users = listUsers(ctx, viewer, query)
      content = (
        <div class="card">
          <form method="get" action="/admin">
            <input type="hidden" name="tab" value="users" />
            <input type="search" name="q" value={query} placeholder={t.admin.filterByUsername} />
          </form>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>{t.admin.user}</th>
                  <th>{t.admin.email}</th>
                  <th>{t.admin.status}</th>
                  <th>{t.admin.joined}</th>
                  <th>{t.admin.actions}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const suspended = u.suspended_indefinitely === 1 || (u.suspended_until !== null && u.suspended_until > now)
                  return (
                    <tr>
                      <td><a href={`/u/${u.username}`}>u/{u.username}</a>{u.is_admin === 1 && ' ⭐'}</td>
                      <td>{u.email_lower ?? '—'}</td>
                      <td>
                        {u.deleted === 1
                          ? t.admin.deleted
                          : suspended
                            ? `${t.admin.suspended}${u.suspended_until ? ` — ${formatDate(u.suspended_until)}` : ` (${t.admin.indefinite})`}`
                            : t.admin.active}
                      </td>
                      <td>{formatDate(u.created_at)}</td>
                      <td>
                        {u.deleted === 0 && u.is_admin === 0 && (
                          suspended ? (
                            <form method="post" action={`/admin/users/${u.id}/unsuspend`} style="display:inline">
                              <button class="btn secondary small" type="submit">{t.admin.unsuspend}</button>
                            </form>
                          ) : (
                            <form method="post" action={`/admin/users/${u.id}/suspend`} style="display:inline">
                              <select name="days" style="width:auto;padding:0.2rem">
                                <option value="3">{t.admin.days3}</option>
                                <option value="7">{t.admin.days7}</option>
                                <option value="30">{t.admin.days30}</option>
                                <option value="indefinite">{t.admin.indefinite}</option>
                              </select>{' '}
                              <input name="reason" type="text" placeholder={t.admin.reasonPlaceholder} style="width:8rem;padding:0.2rem" />{' '}
                              <button class="btn danger small" type="submit">{t.admin.suspend}</button>
                            </form>
                          )
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )
    } else if (tab === 'communities') {
      const communities = listAllCommunities(ctx, viewer)
      content = (
        <div class="card">
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>{t.admin.community}</th>
                  <th>{t.admin.memberCount}</th>
                  <th>{t.admin.postCount}</th>
                  <th>{t.admin.status}</th>
                  <th>{t.admin.actions}</th>
                </tr>
              </thead>
              <tbody>
                {communities.map((cm) => (
                  <tr>
                    <td>
                      <a href={`/c/${cm.name}`}>c/{cm.name}</a> · {visibilityLabel(cm.visibility)}
                    </td>
                    <td>{cm.member_count}</td>
                    <td>{cm.post_count}</td>
                    <td>
                      {cm.deleted_at !== null
                        ? `${t.admin.deleted} ${formatDate(cm.deleted_at)}`
                        : cm.archived === 1
                          ? t.admin.archivedStatus
                          : t.admin.active}
                    </td>
                    <td>
                      {cm.deleted_at === null ? (
                        <>
                          <form method="post" action={`/admin/communities/${cm.id}/${cm.archived === 1 ? 'unarchive' : 'archive'}`} style="display:inline">
                            <button class="btn secondary small" type="submit">{cm.archived === 1 ? t.admin.unarchive : t.admin.archive}</button>
                          </form>{' '}
                          <form method="post" action={`/admin/export/${cm.id}`} style="display:inline">
                            <button class="btn secondary small" type="submit">{t.admin.export}</button>
                          </form>{' '}
                          <form method="post" action={`/admin/communities/${cm.id}/delete`} style="display:inline">
                            <input name="confirmName" type="text" placeholder={`${t.admin.typeName} "${cm.name}"`} style="width:9rem;padding:0.2rem" />{' '}
                            <button class="btn danger small" type="submit">{t.admin.delete}</button>
                          </form>
                        </>
                      ) : (
                        <form method="post" action={`/admin/communities/${cm.id}/restore`} style="display:inline">
                          <button class="btn secondary small" type="submit">{t.admin.restore}</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )
    } else if (tab === 'settings') {
      content = (
        <div class="card form-narrow">
          <form method="post" action="/admin/settings">
            <div class="field">
              <label for="registrationMode">{t.admin.registration}</label>
              <select id="registrationMode" name="registrationMode">
                {(['open', 'invite', 'closed'] as const).map((mode) => (
                  <option value={mode} selected={settings.registrationMode === mode}>
                    {mode === 'open' ? t.admin.registrationOpen : mode === 'invite' ? t.admin.registrationInvite : t.admin.registrationClosed}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for="communityCreation">{t.admin.communityCreation}</label>
              <select id="communityCreation" name="communityCreation">
                <option value="member" selected={settings.communityCreation === 'member'}>{t.admin.anyMember}</option>
                <option value="admin" selected={settings.communityCreation === 'admin'}>{t.admin.adminOnly}</option>
              </select>
            </div>
            <div class="field">
              <label for="hotDecaySeconds">{t.admin.hotDecay}</label>
              <input id="hotDecaySeconds" name="hotDecaySeconds" type="number" min={1000} value={String(settings.hotDecaySeconds)} />
              <div class="hint">{t.admin.hotDecayHint}</div>
            </div>
            <div class="field">
              <label for="postsPer10Min">{t.admin.postsPer10Min}</label>
              <input id="postsPer10Min" name="postsPer10Min" type="number" min={1} value={String(settings.postsPer10Min)} />
            </div>
            <div class="field">
              <label for="commentsPer10Min">{t.admin.commentsPer10Min}</label>
              <input id="commentsPer10Min" name="commentsPer10Min" type="number" min={1} value={String(settings.commentsPer10Min)} />
            </div>
            <div class="field">
              <label for="votesPerMinute">{t.admin.votesPerMinute}</label>
              <input id="votesPerMinute" name="votesPerMinute" type="number" min={1} value={String(settings.votesPerMinute)} />
            </div>
            <div class="field">
              <label for="reportsPerHour">{t.admin.reportsPerHour}</label>
              <input id="reportsPerHour" name="reportsPerHour" type="number" min={1} value={String(settings.reportsPerHour)} />
            </div>
            <button class="btn" type="submit">{t.post.save}</button>
          </form>
        </div>
      )
    } else if (tab === 'invites') {
      const invites = listInvites(ctx, viewer)
      content = (
        <div class="card">
          <form method="post" action="/admin/invites">
            <div class="field">
              <label>{t.admin.newInviteLink}</label>
              <input name="expiresInDays" type="number" min={1} max={365} value="7" style="width:6rem" /> {t.admin.days},{' '}
              <input name="maxUses" type="number" min={1} max={1000} value="10" style="width:6rem" /> {t.admin.uses}{' '}
              <button class="btn small" type="submit">{t.admin.create}</button>
            </div>
          </form>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>{t.admin.link}</th>
                  <th>{t.admin.expires}</th>
                  <th>{t.admin.uses}</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <tr>
                    <td><code>/register?invite={inv.code}</code></td>
                    <td>{formatDate(inv.expires_at)}</td>
                    <td>{inv.uses}/{inv.max_uses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )
    } else if (tab === 'log') {
      const entries = siteAdminLog(ctx)
      content = (
        <div class="card">
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>{t.admin.when}</th>
                  <th>{t.admin.action}</th>
                  <th>{t.admin.target}</th>
                  <th>{t.admin.detail}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr>
                    <td>{relativeTime(e.created_at, now)}</td>
                    <td>{e.action}</td>
                    <td>{e.target_type ? `${e.target_type}:${e.target_id}` : '—'}</td>
                    <td>{[e.reason, e.detail].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )
    } else {
      const queue = reportQueue(ctx, viewer, null)
      content = (
        <div class="card">
          {queue.length === 0 && <p class="placeholder">{t.admin.noOpenReports}</p>}
          {queue.length > 0 && (
            <div class="table-wrap">
              <table class="data">
                <thead>
                  <tr>
                    <th>{t.admin.community}</th>
                    <th>{t.admin.content}</th>
                    <th>{t.admin.reportsCol}</th>
                    <th>{t.admin.reasons}</th>
                    <th>{t.admin.age}</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((entry) => {
                    const link = entry.target_type === 'post'
                      ? `/c/${entry.community_name}/comments/${entry.target_id}`
                      : (() => {
                          const comment = getComment(ctx, entry.target_id)
                          return comment ? `/c/${entry.community_name}/comments/${comment.post_id}/comment/${entry.target_id}` : '#'
                        })()
                    return (
                      <tr>
                        <td><a href={`/c/${entry.community_name}/mod/queue`}>c/{entry.community_name}</a></td>
                        <td><a href={link}>{entry.title ?? entry.body_preview ?? entry.target_id}</a></td>
                        <td>{entry.report_count}</td>
                        <td>{entry.reasons}</td>
                        <td>{relativeTime(entry.oldest_report_at, now)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )
    }

    return c.html(
      <Layout title={t.admin.dashboard} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <h1 style="font-family:var(--font-display)">{t.admin.dashboard}</h1>
        {tabs}
        {content}
      </Layout>,
    )
  })

  app.post('/admin/users/:id/suspend', async (c) => {
    const viewer = c.get('viewer')
    requireAdmin(viewer)
    const body = await formData(c)
    try {
      suspendUser(ctx, viewer, c.req.param('id'), {
        days: body.days === 'indefinite' ? null : Number(body.days ?? 7),
        reason: body.reason || null,
      })
      setFlash(c, 'ok', t.admin.userSuspended)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect('/admin?tab=users')
  })

  app.post('/admin/users/:id/unsuspend', (c) => {
    const viewer = c.get('viewer')
    requireAdmin(viewer)
    unsuspendUser(ctx, viewer, c.req.param('id'))
    return c.redirect('/admin?tab=users')
  })

  app.post('/admin/communities/:id/:action', async (c) => {
    const viewer = c.get('viewer')
    requireAdmin(viewer)
    const community = getCommunityById(ctx, c.req.param('id'))
    if (!community) throw notFound()
    const action = c.req.param('action')
    const body = await formData(c)
    try {
      if (action === 'archive') setCommunityArchived(ctx, viewer, community, true)
      else if (action === 'unarchive') setCommunityArchived(ctx, viewer, community, false)
      else if (action === 'delete') deleteCommunity(ctx, viewer, community, body.confirmName ?? '')
      else if (action === 'restore') restoreCommunity(ctx, viewer, community)
      else throw notFound()
      setFlash(c, 'ok', `${t.admin.community} — ${
        action === 'archive'
          ? t.admin.archivedStatus
          : action === 'unarchive'
            ? t.admin.unarchive
            : action === 'delete'
              ? t.admin.deleted
              : t.admin.restore
      }`)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect('/admin?tab=communities')
  })

  app.post('/admin/settings', async (c) => {
    const viewer = c.get('viewer')
    requireAdmin(viewer)
    const body = await formData(c)
    const patch: Partial<SiteSettings> = {}
    if (body.registrationMode && ['open', 'invite', 'closed'].includes(body.registrationMode)) {
      patch.registrationMode = body.registrationMode as SiteSettings['registrationMode']
    }
    if (body.communityCreation && ['member', 'admin'].includes(body.communityCreation)) {
      patch.communityCreation = body.communityCreation as SiteSettings['communityCreation']
    }
    for (const key of ['hotDecaySeconds', 'postsPer10Min', 'commentsPer10Min', 'votesPerMinute', 'reportsPerHour'] as const) {
      const value = Number(body[key])
      if (Number.isFinite(value) && value >= 1) patch[key] = Math.trunc(value)
    }
    updateSettings(ctx, patch)
    const { logAction } = await import('../services/modlog')
    logAction(ctx, { communityId: null, actorId: (viewer as NonNullable<typeof viewer>).id, action: 'site_settings_update', detail: JSON.stringify(patch) })
    setFlash(c, 'ok', t.admin.siteSettingsUpdated)
    return c.redirect('/admin?tab=settings')
  })

  app.post('/admin/invites', async (c) => {
    const viewer = c.get('viewer')
    requireAdmin(viewer)
    const body = await formData(c)
    createInvite(ctx, viewer, {
      expiresInDays: Number(body.expiresInDays ?? 7),
      maxUses: Number(body.maxUses ?? 10),
    })
    return c.redirect('/admin?tab=invites')
  })

  app.post('/admin/export/:communityId', async (c) => {
    const viewer = c.get('viewer')
    requireAdmin(viewer)
    const community = getCommunityById(ctx, c.req.param('communityId'))
    if (!community) throw notFound()
    const { token } = await exportCommunity(ctx, viewer, community)
    setFlash(c, 'ok', `${t.admin.exportReady} /exports/${token}`)
    return c.redirect('/admin?tab=communities')
  })

  app.get('/exports/:token', async (c) => {
    const viewer = c.get('viewer')
    requireAdmin(viewer)
    const filePath = await getExport(ctx, c.req.param('token'))
    if (!filePath) throw notFound(t.admin.exportInvalid)
    const contents = await readFile(filePath)
    return c.body(contents.buffer as ArrayBuffer, 200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="community-export.json"',
    })
  })

  return app
}
