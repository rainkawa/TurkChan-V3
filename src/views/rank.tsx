import type { FC } from 'hono/jsx'
import { t } from '../i18n/tr'
import { rankBadgeFor, type UserRank } from '../services/ranks'
import { profilePath } from './helpers'

/**
 * Kullanıcı adının hemen yanında gösterilen **tek** rozet görseli.
 *
 * `rankBadgeFor` tek rozeti çözer: kısıtlama > yönetim yetkisi > karma rütbesi.
 * Yönetim yetkisi olan bir kullanıcıda karma rütbesi gösterilmez, böylece iki
 * rozet asla yan yana görünmez. Görsel yüklenemezse `rank-badge-text` yedeği
 * devreye girer (bkz. `public/app.js`); kırık resim ikonu gösterilmez.
 */
export const RankBadges: FC<{ info?: UserRank | null; class?: string }> = ({ info, class: cls = '' }) => {
  if (!info) return null
  const badge = rankBadgeFor(info)
  const prefix = badge.kind === 'staff' ? t.rank.roleLabel : t.rank.label
  return (
    <span class={`rank-badges ${cls}`.trim()}>
      <span
        class={`rank-badge-img rank-${badge.variant}${badge.kind === 'staff' ? ` role-${badge.variant}` : ''}`.trim()}
        data-rank={badge.variant}
        title={`${prefix}: ${badge.label}`}
      >
        <img class="rank-img" src={badge.src} alt={badge.label} width={64} height={64} loading="lazy" decoding="async" />
        <span class="rank-badge-text">{badge.label}</span>
      </span>
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
