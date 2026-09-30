import type { FC } from 'hono/jsx'
import { t } from '../i18n/tr'
import { STAFF_ROLE_LABELS, rankBadgeLabel, type UserRank } from '../services/ranks'
import { profilePath } from './helpers'

/**
 * Karma rütbesi + yönetim yetkisi rozetleri. İki katman bağımsızdır: bir
 * kullanıcı hem "Legend" rütbesine hem de "Yönetici" yetkisine sahip olabilir.
 */
export const RankBadges: FC<{ info?: UserRank | null; class?: string }> = ({ info, class: cls = '' }) => {
  if (!info) return null
  return (
    <span class={`rank-badges ${cls}`.trim()}>
      <span
        class={`rank-badge ${info.banned ? 'rank-banned' : `rank-${info.rank}`}`}
        title={info.banned ? t.rank.banned : `${t.rank.label}: ${rankBadgeLabel(info)}`}
      >
        {rankBadgeLabel(info)}
      </span>
      {info.staffRole && (
        <span class={`rank-badge role-${info.staffRole}`} title={`${t.rank.roleLabel}: ${STAFF_ROLE_LABELS[info.staffRole]}`}>
          {STAFF_ROLE_LABELS[info.staffRole]}
        </span>
      )}
    </span>
  )
}

/** `/tc/kullanici` + rütbe rozetleri — tüm yerde aynı kullanıcı satırı. */
export const UserByline: FC<{
  username: string
  info?: UserRank | null
  class?: string
  /** Dışarıda zaten bir bağlantı varsa false (iç içe <a> oluşmaz). */
  link?: boolean
}> = ({ username, info, class: cls = '', link = true }) => (
  <span class={`user-byline ${cls}`.trim()}>
    {link ? <a href={profilePath(username)}>/tc/{username}</a> : <span>/tc/{username}</span>}
    <RankBadges info={info} />
  </span>
)
