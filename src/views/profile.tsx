import type { FC } from 'hono/jsx'
import { t, relativeTime, formatDate } from '../i18n/tr'
import { accountAge, compactNumber, previewText, communityColor, communityInitials, formatDateTr, profilePath } from './helpers'
import { CommunityAvatar, SocialCard } from './components'
import { RankBadges } from './rank'
import { STAFF_ROLE_LABELS, rankBadgeLabel, type UserRank } from '../services/ranks'
import type { ProfileView } from '../services/users'
import { moderatesAnyCommunity } from '../services/users'
import type { Ctx } from '../context'
import { getMyVotes } from '../services/votes'
import type { UserRow } from '../types'

export type ProfileTab = 'posts' | 'comments' | 'saved' | 'about'

/** İçerik yokken: ikon + başlık + yönlendirici çağrı. */
const EmptyState: FC<{ title: string; body: string; ctaHref: string; ctaLabel: string }> = ({
  title,
  body,
  ctaHref,
  ctaLabel,
}) => (
  <div class="empty-panel">
    <span class="empty-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <rect x="3.5" y="4.5" width="17" height="15" rx="4" fill="none" stroke="currentColor" stroke-width="1.8" />
        <path d="M8 10h8M8 14h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
    </span>
    <p class="empty-title">{title}</p>
    <p class="empty-body">{body}</p>
    <a class="btn secondary small" href={ctaHref}>{ctaLabel}</a>
  </div>
)

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
  /** Karma rütbesi + yönetim yetkisi (route tarafından çözülür). */
  rank: UserRank
}> = ({ ctx, profile, viewer, isModerator, tab, now, rank }) => {
  const { user, karma, posts, comments } = profile
  const isSelf = viewer?.id === user.id
  const displayName = user.display_name?.trim() || user.username
  const totalKarma = karma.postKarma + karma.commentKarma
  const contributions = posts.length + comments.length
  const postHref = (id: string) => `/c/${id}`

  // Topluluk moderatörü rozeti, yönetim yetkisi rozetinden ayrıdır.
  const communityMod = isModerator && !rank.staffRole ? t.profile.roleModerator : null

  // Sekme içeriği: gönderiler gerçek kartlarla, diğerleri sunucu tarafında.
  const myVotes = new Map<string, number>()
  if (tab === 'posts') {
    for (const [id, v] of getMyVotes(ctx, viewer, 'post', posts.map((p) => p.id))) myVotes.set(id, v)
  }

  return (
    <div class="profile">
      {/*
        * Hero: kapak + kimlik + istatistik tek bir koyu kompozisyon.
        * Kapak görselinin altı scrim ile siyaha kararır; profil bilgileri
        * aynı koyu zeminde devam eder, keskin yatay sınır oluşmaz.
        */}
      <div class="profile-hero">
        <section class="profile-cover">
          <div class="profile-cover-bg" aria-hidden="true" />
          {user.cover_key && (
            <img class="profile-cover-img" src={`/media/${user.cover_key}`} alt={t.profile.coverAlt} />
          )}
          <div class="profile-cover-scrim" aria-hidden="true" />
          <div class="profile-cover-actions">
            <a class="round-btn" href="/search" aria-label={t.nav.search}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
                <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </a>
            <button class="round-btn" type="button" data-share={profilePath(user.username)} aria-label={t.profile.shareProfile}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 15V4m0 0L8 8m4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <div
            class="profile-avatar"
            style={`--c-bg:${communityColor(user.username)}`}
            aria-label={t.profile.avatarAlt}
          >
            {user.avatar_key ? (
              <img src={`/media/${user.avatar_key}`} alt={t.profile.avatarAlt} />
            ) : (
              communityInitials(user.username)
            )}
          </div>
        </section>

        <div class="profile-identity">
          <h1 class="profile-name">{displayName}</h1>
          {/* Kullanıcı adı, rozet ve Düzenle aynı kompakt bölgede. */}
          <div class="profile-handle">
            <span class="profile-username">/tc/{user.username}</span>
            <RankBadges info={rank} />
            {communityMod && <span class="role-badge">{communityMod}</span>}
            {isSelf && (
              <a class="btn secondary small profile-edit" href="/settings">
                {t.common.edit}
              </a>
            )}
          </div>
          {/* Küçük gri ikincil satır: katılma ve karma dağılımı. */}
          <p class="profile-meta">
            {t.profile.joined}: {formatDateTr(user.created_at)} · {t.profile.postKarma}: {karma.postKarma} ·{' '}
            {t.profile.commentKarma}: {karma.commentKarma}
          </p>
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
      </div>

      {/* Koyu hero biter; içerik bölümü açık zeminde ve sekmelerle başlar. */}
      <div class="profile-body">
        <nav class="profile-tabs" role="tablist" aria-label={t.profile.tabsLabel}>
          {TABS.map((item) => (
            <a
              href={`${profilePath(user.username)}?tab=${item.key}`}
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
              <EmptyState
                title={t.post.noPosts}
                body={t.profile.emptyPostsBody}
                ctaHref={isSelf ? '/submit' : '/communities'}
                ctaLabel={isSelf ? t.nav.createPost : t.feed.browseCommunities}
              />
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
                    authorRanks={new Map([[user.id, rank]])}
                    showCommunity
                  />
                ))}
              </div>
            ))}

          {tab === 'comments' &&
            (comments.length === 0 ? (
              <EmptyState
                title={t.post.noComments}
                body={t.profile.emptyCommentsBody}
                ctaHref="/communities"
                ctaLabel={t.feed.browseCommunities}
              />
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
              <EmptyState
                title={t.profile.emptySaved}
                body={t.profile.emptySavedHint}
                ctaHref="/"
                ctaLabel={t.nav.home}
              />
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
                {rank.staffRole && (
                  <div>
                    <dt>{t.profile.roleBadgeLabel}</dt>
                    <dd>{STAFF_ROLE_LABELS[rank.staffRole]}</dd>
                  </div>
                )}
                <div>
                  <dt>{t.profile.rankRow}</dt>
                  <dd>{rankBadgeLabel(rank)}</dd>
                </div>
                <div>
                  <dt>{t.admin.restriction}</dt>
                  <dd>
                    {rank.banned
                      ? `${t.rank.banned}${rank.bannedPermanent ? ` (${t.admin.indefinite})` : ''}`
                      : t.admin.notRestricted}
                  </dd>
                </div>
                {communityMod && (
                  <div>
                    <dt>{t.profile.roleBadgeLabel}</dt>
                    <dd>{communityMod}</dd>
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
