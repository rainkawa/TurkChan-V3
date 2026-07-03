import { Hono } from 'hono'
import type { Ctx } from '../context'
import { t } from '../i18n/en'
import { Layout } from '../views/layout'
import { requireVisibleCommunity, getCommunityById, requireModerator } from '../services/access'
import { pendingRequests, resolveJoinRequest, listModerators, getUserForModeration } from '../services/communities'
import { reportQueue, dismissReports } from '../services/reports'
import {
  removeContent,
  restoreContent,
  banUser,
  unbanUser,
  listBans,
  pinPost,
  unpinPost,
  appointModerator,
  removeModerator,
} from '../services/moderation'
import { communityModLog } from '../services/modlog'
import { getPost } from '../services/posts'
import { getComment } from '../services/comments'
import { AppError, notFound } from '../services/errors'
import { relativeTime } from '../views/helpers'
import { type AppEnv, formData, loginRedirect, setFlash, takeFlash, unread } from './helpers'

export function modRoutes(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** US-030: report queue, oldest-unresolved first. */
  app.get('/c/:name/mod/queue', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    requireModerator(ctx, viewer, community)
    const queue = reportQueue(ctx, viewer, community)
    const now = ctx.now()
    return c.html(
      <Layout title={t.community.modQueue} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card">
          <h2>{t.community.modQueue} — c/{community.name}</h2>
          {queue.length === 0 && <p class="placeholder">Queue is clear. 🎉</p>}
          <div class="table-wrap">
            {queue.length > 0 && (
              <table class="data">
                <thead>
                  <tr><th>Content</th><th>Reports</th><th>Reasons</th><th>Age</th><th>Actions</th></tr>
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
                        <td>
                          {entry.auto_hidden === 1 && <span class="pin-tag">⚠ auto-hidden</span>}{' '}
                          <a href={link}>{entry.title ?? entry.body_preview ?? entry.target_id}</a>
                          {entry.author_username && <div class="hint">by u/{entry.author_username}</div>}
                        </td>
                        <td>{entry.report_count}</td>
                        <td>{entry.reasons}</td>
                        <td>{relativeTime(entry.oldest_report_at, now)}</td>
                        <td>
                          <form method="post" action={`/mod/remove/${entry.target_type}/${entry.target_id}`} style="display:inline" data-confirm="Remove this content?">
                            <button class="btn danger small" type="submit">Remove</button>
                          </form>{' '}
                          <form method="post" action={`/c/${community.name}/mod/dismiss/${entry.target_type}/${entry.target_id}`} style="display:inline">
                            <button class="btn secondary small" type="submit">Dismiss</button>
                          </form>{' '}
                          {entry.author_username && (
                            <a class="btn secondary small" href={`/c/${community.name}/mod/members?ban=${entry.author_username}`}>Ban author</a>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Layout>,
    )
  })

  app.post('/c/:name/mod/dismiss/:type/:id', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    const type = c.req.param('type') === 'comment' ? 'comment' : 'post'
    try {
      dismissReports(ctx, viewer, community, type, c.req.param('id'))
      setFlash(c, 'ok', 'Reports dismissed.')
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}/mod/queue`)
  })

  app.post('/mod/remove/:type/:id', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const type = c.req.param('type') === 'comment' ? 'comment' : 'post'
    const targetId = c.req.param('id')
    const body = await formData(c)
    const target = type === 'post' ? getPost(ctx, targetId) : getComment(ctx, targetId)
    if (!target) throw notFound()
    const postId = type === 'post' ? targetId : (target as { post_id: string }).post_id
    const post = getPost(ctx, postId)
    const community = post ? getCommunityById(ctx, post.community_id) : null
    try {
      removeContent(ctx, viewer, type, targetId, body.rule || null)
      setFlash(c, 'ok', 'Content removed.')
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(community ? `/c/${community.name}/mod/queue` : '/')
  })

  app.post('/mod/restore/:type/:id', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const type = c.req.param('type') === 'comment' ? 'comment' : 'post'
    try {
      restoreContent(ctx, viewer, type, c.req.param('id'))
      setFlash(c, 'ok', 'Content restored.')
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect('/')
  })

  app.post('/posts/:id/pin', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const post = getPost(ctx, c.req.param('id'))
    const community = post ? getCommunityById(ctx, post.community_id) : null
    try {
      pinPost(ctx, viewer, c.req.param('id'))
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(community && post ? `/c/${community.name}/comments/${post.id}` : '/')
  })

  app.post('/posts/:id/unpin', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const post = getPost(ctx, c.req.param('id'))
    const community = post ? getCommunityById(ctx, post.community_id) : null
    try {
      unpinPost(ctx, viewer, c.req.param('id'))
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(community && post ? `/c/${community.name}/comments/${post.id}` : '/')
  })

  /** Membership approvals, moderators, bans. */
  app.get('/c/:name/mod/members', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    requireModerator(ctx, viewer, community)
    const pending = pendingRequests(ctx, viewer, community)
    const moderators = listModerators(ctx, community.id)
    const bans = listBans(ctx, viewer, community)
    const banPrefill = c.req.query('ban') ?? ''
    const now = ctx.now()
    return c.html(
      <Layout title={t.community.approvals} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card">
          <h2>{t.community.approvals} — c/{community.name}</h2>
          {pending.length === 0 && <p class="placeholder">No pending requests.</p>}
          {pending.map((p) => (
            <div class="dir-item">
              <div>
                <a class="name" href={`/u/${p.username}`}>u/{p.username}</a>
                <p class="desc">requested {relativeTime(p.created_at, now)}</p>
              </div>
              <span>
                <form method="post" action={`/c/${community.name}/mod/requests/${p.user_id}/approve`} style="display:inline">
                  <button class="btn small" type="submit">Approve</button>
                </form>{' '}
                <form method="post" action={`/c/${community.name}/mod/requests/${p.user_id}/reject`} style="display:inline">
                  <button class="btn secondary small" type="submit">Reject</button>
                </form>
              </span>
            </div>
          ))}
        </div>

        <div class="card" style="margin-top:1rem">
          <h3>{t.community.moderators}</h3>
          {moderators.map((m) => (
            <div class="dir-item">
              <a class="name" href={`/u/${m.username}`}>u/{m.username}</a>
              <form method="post" action={`/c/${community.name}/mod/moderators/${m.user_id}/remove`} style="display:inline" data-confirm="Remove this moderator?">
                <button class="btn secondary small" type="submit">Remove mod</button>
              </form>
            </div>
          ))}
          <form method="post" action={`/c/${community.name}/mod/moderators/appoint`} style="margin-top:0.75rem">
            <div class="field">
              <label for="appoint-username">Appoint moderator (username)</label>
              <input id="appoint-username" name="username" type="text" required />
            </div>
            <button class="btn small" type="submit">Appoint</button>
          </form>
        </div>

        <div class="card" style="margin-top:1rem">
          <h3>Bans</h3>
          {bans.map((b) => (
            <div class="dir-item">
              <div>
                <span class="name">u/{b.username}</span>
                <p class="desc">
                  {b.expires_at === null ? 'permanent' : `until ${new Date(b.expires_at).toISOString().slice(0, 10)}`}
                  {b.reason ? ` — ${b.reason}` : ''}
                </p>
              </div>
              <form method="post" action={`/c/${community.name}/mod/unban/${b.user_id}`} style="display:inline">
                <button class="btn secondary small" type="submit">Unban</button>
              </form>
            </div>
          ))}
          <form method="post" action={`/c/${community.name}/mod/ban`} style="margin-top:0.75rem">
            <div class="field">
              <label for="ban-username">Ban member (username)</label>
              <input id="ban-username" name="username" type="text" required value={banPrefill} />
            </div>
            <div class="field">
              <label for="ban-duration">Duration</label>
              <select id="ban-duration" name="duration">
                <option value="3">3 days</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="permanent">Permanent</option>
              </select>
            </div>
            <div class="field">
              <label for="ban-reason">Reason (shown to the banned user)</label>
              <input id="ban-reason" name="reason" type="text" maxlength={300} />
            </div>
            <button class="btn danger small" type="submit">Ban</button>
          </form>
        </div>
      </Layout>,
    )
  })

  app.post('/c/:name/mod/requests/:userId/:decision', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    const decision = c.req.param('decision') === 'approve' ? 'approve' : 'reject'
    try {
      resolveJoinRequest(ctx, viewer, community, c.req.param('userId'), decision)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}/mod/members`)
  })

  app.post('/c/:name/mod/ban', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    const body = await formData(c)
    try {
      const target = getUserForModeration(ctx, body.username ?? '')
      if (!target) throw notFound('User not found.')
      const duration = body.duration === 'permanent' ? null : Number(body.duration)
      banUser(ctx, viewer, community, target.id, duration, body.reason || null)
      setFlash(c, 'ok', `u/${target.username} banned.`)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}/mod/members`)
  })

  app.post('/c/:name/mod/unban/:userId', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    try {
      unbanUser(ctx, viewer, community, c.req.param('userId'))
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}/mod/members`)
  })

  app.post('/c/:name/mod/moderators/appoint', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    const body = await formData(c)
    try {
      const target = getUserForModeration(ctx, body.username ?? '')
      if (!target) throw notFound('User not found.')
      appointModerator(ctx, viewer, community, target.id)
      setFlash(c, 'ok', `u/${target.username} is now a moderator.`)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}/mod/members`)
  })

  app.post('/c/:name/mod/moderators/:userId/remove', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    try {
      removeModerator(ctx, viewer, community, c.req.param('userId'))
      setFlash(c, 'ok', 'Moderator removed.')
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}/mod/members`)
  })

  /** US-035: chronological, immutable mod log. */
  app.get('/c/:name/mod/log', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    requireModerator(ctx, viewer, community)
    const entries = communityModLog(ctx, community.id)
    const now = ctx.now()
    const usernames = new Map<string, string>()
    for (const entry of entries) {
      if (!usernames.has(entry.actor_id)) {
        const row = ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(entry.actor_id) as { username: string } | undefined
        usernames.set(entry.actor_id, row?.username ?? '[deleted]')
      }
    }
    return c.html(
      <Layout title={t.community.modLog} viewer={viewer} unread={unread(ctx, viewer)}>
        <div class="card">
          <h2>{t.community.modLog} — c/{community.name}</h2>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Reason / detail</th></tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr>
                    <td>{relativeTime(e.created_at, now)}</td>
                    <td>u/{usernames.get(e.actor_id)}</td>
                    <td>{e.action}</td>
                    <td>{e.target_type ? `${e.target_type}:${e.target_id}` : '—'}</td>
                    <td>{[e.reason, e.detail].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {entries.length === 0 && <p class="placeholder">No moderation actions yet.</p>}
        </div>
      </Layout>,
    )
  })

  return app
}
