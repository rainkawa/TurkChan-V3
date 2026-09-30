import type { FC } from 'hono/jsx'
import { t, relativeTime, formatDate } from '../i18n/tr'
import { accountAge, compactNumber, previewText, communityColor, communityInitials } from './helpers'
import { CommunityAvatar, SocialCard } from './components'
import type { ProfileView } from '../services/users'
import { moderatesAnyCommunity } from '../services/users'
import type { Ctx } from '../context'
import { getMyVotes } from '../services/votes'
import type { UserRow } from '../types'

export type ProfileTab = 'posts' | 'comments' | 'saved' | 'about'

const TABS: Array<{ key: ProfileTab; label: string }> = [
  { key: 'posts', label: t.profile.tabPosts },
  { key: 'comments', label: t.profile.tabComments },
  { key: 'saved', label: t.profile.tabSaved },
  { key: 'about', label: t.profile.tabAbout },
]

/** Profil sayfasının tamamı: kapak, avatar, kimlik, istatistik, sekmeler, içerik. */
export const ProfileView_: FC<{
  ctx: Ctx
  profile: ProfileView
  viewer: UserRow | null
  isModerator: boolean
  tab: ProfileTab
  now: number
}> = ({ ctx, profile, viewer, isModerator, tab, now }) => {
  const { user, karma, posts, comments } = profile
  const isSelf = viewer?.id === user.id
  const displayName = user.display_name?.trim() || user.username
  const totalKarma = karma.postKarma + karma.commentKarma
  const contributions = posts.length + comments.length
  const postHref = (id: string) => `/c/${id}`

  const role = user.is_admin === 1 ? t.profile.roleAdmin : isModerator ? t.profile.roleModerator : null

  // Sekme içeriği: gönderiler gerçek kartlarla, diğerleri sunucu tarafında.
  const myVotes = new Map<string, number>()
  if (tab === 'posts') {
    for (const [id, v] of getMyVotes(ctx, viewer, 'post', posts.map((p) => p.id))) myVotes.set(id, v)
  }

  return (
    <div class="profile">
      <section class="profile-cover">
        <div class="profile-cover-bg" aria-hidden="true" />
        <div class="profile-cover-scrim" aria-hidden="true" />
        <div class="profile-cover-actions">
          <a class="round-btn" href="/search" aria-label={t.nav.search}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
              <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </a>
          <button class="round-btn" type="button" data-share={`/u/${user.username}`} aria-label={t.profile.shareProfile}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15V4m0 0L8 8m4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
          <details class="overflow-menu profile-menu">
            <summary class="round-btn" aria-label={t.card.more} title={t.card.more}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="5" cy="12" r="2" fill="currentColor" />
                <circle cx="12" cy="12" r="2" fill="currentColor" />
                <circle cx="19" cy="12" r="2" fill="currentColor" />
              </svg>
            </summary>
            <div class="overflow-panel">
              <a href="/privacy">{t.footer.privacy}</a>
              {isSelf && <a href="/settings">{t.nav.settings}</a>}
            </div>
          </details>
        </div>
        <div
          class="profile-avatar"
          style={`--c-bg:${communityColor(user.username)}`}
          aria-label={t.profile.avatarAlt}
        >
          {communityInitials(user.username)}
        </div>
      </section>

      <div class="profile-body">
        <div class="profile-identity">
          <h1 class="profile-name">{displayName}</h1>
          <div class="profile-handle">
            <span class="profile-username">u/{user.username}</span>
            {role && <span class="role-badge">{role}</span>}
            {isSelf && (
              <a class="btn secondary small profile-edit" href="/settings">
                {t.common.edit}
              </a>
            )}
          </div>
          {user.bio && <p class="profile-bio">{user.bio}</p>}
        </div>

        <dl class="profile-stats">
          <div class="profile-stat">
            <dt>{t.profile.statKarma}</dt>
            <dd>{compactNumber(totalKarma)}</dd>
          </div>
          <div class="profile-stat">
            <dt>{t.profile.statContributions}</dt>
            <dd>{compactNumber(contributions)}</dd>
          </div>
          <div class="profile-stat">
            <dt>{t.profile.statAge}</dt>
            <dd>{accountAge(user.created_at, now)}</dd>
          </div>
        </dl>

        {/* İkincil bilgiler: ana istatistiklerin altında, daha küçük. */}
        <p class="profile-meta">
          {t.profile.joined} {formatDate(user.created_at)} · {t.profile.postKarma}: {karma.postKarma} ·{' '}
          {t.profile.commentKarma}: {karma.commentKarma}
        </p>

        <nav class="profile-tabs" role="tablist" aria-label={t.profile.tabsLabel}>
          {TABS.map((item) => (
            <a
              href={`/u/${user.username}?tab=${item.key}`}
              class={`profile-tab${tab === item.key ? ' active' : ''}`}
              role="tab"
              aria-selected={tab === item.key ? 'true' : 'false'}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div class="profile-panel" role="tabpanel">
          {tab === 'posts' &&
            (posts.length === 0 ? (
              <p class="placeholder profile-empty">{t.post.noPosts}</p>
            ) : (
              <div class="social-feed">
                {posts.map((p) => (
                  <SocialCard
                    item={{
                      ...p,
                      community_title: p.community_name,
                      author_username: user.username,
                      hot: 0,
                    }}
                    now={now}
                    myVote={myVotes.get(p.id) ?? 0}
                    viewer={viewer}
                    showCommunity
                  />
                ))}
              </div>
            ))}

          {tab === 'comments' &&
            (comments.length === 0 ? (
              <p class="placeholder profile-empty">{t.post.noComments}</p>
            ) : (
              <div class="profile-comments">
                {comments.map((cm) => (
                  <article class="profile-comment">
                    <header class="profile-comment-head">
                      <CommunityAvatar name={cm.community_name} size={28} />
                      <a class="profile-comment-community" href={postHref(cm.community_name)}>
                        c/{cm.community_name}
                      </a>
                      <span class="social-card-time">{relativeTime(cm.created_at, now)}</span>
                    </header>
                    <p class="profile-comment-text">{previewText(cm.body, 300)}</p>
                    <a class="profile-comment-link" href={`/c/${cm.community_name}/comments/${cm.post_id}/comment/${cm.id}`}>
                      {cm.post_title}
                    </a>
                    <div class="profile-comment-meta">
                      <span>{cm.score} {t.common.points}</span>
                    </div>
                  </article>
                ))}
              </div>
            ))}

          {tab === 'saved' && (
            <div class="profile-saved" data-saved-list>
              <p class="placeholder profile-empty">{t.profile.emptySaved}</p>
              <p class="profile-saved-hint">{t.profile.emptySavedHint}</p>
              <p class="profile-saved-note">{t.card.savedLocally}</p>
            </div>
          )}

          {tab === 'about' && (
            <div class="profile-about">
              <dl class="profile-about-list">
                <div>
                  <dt>{t.profile.joined}</dt>
                  <dd>{formatDate(user.created_at)}</dd>
                </div>
                <div>
                  <dt>{t.profile.postKarma}</dt>
                  <dd>{karma.postKarma}</dd>
                </div>
                <div>
                  <dt>{t.profile.commentKarma}</dt>
                  <dd>{karma.commentKarma}</dd>
                </div>
                <div>
                  <dt>{t.profile.statPosts}</dt>
                  <dd>{posts.length}</dd>
                </div>
                <div>
                  <dt>{t.profile.statComments}</dt>
                  <dd>{comments.length}</dd>
                </div>
                {role && (
                  <div>
                    <dt>{t.profile.roleBadgeLabel}</dt>
                    <dd>{role}</dd>
                  </div>
                )}
              </dl>
              {user.bio && <p class="profile-about-bio">{user.bio}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function resolvesModerator(ctx: Ctx, userId: string): boolean {
  return moderatesAnyCommunity(ctx, userId)
}
