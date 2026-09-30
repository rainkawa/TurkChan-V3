/**
 * Rütbe (rank) ve yönetim yetkisi (staff role) sistemi.
 *
 * İki bağımsız katman vardır:
 *  - Rütbe: kullanıcının toplam karma değerinden **dinamik** hesaplanır.
 *    Admin isterse `rank_mode = 'manual'` ile tek bir rütbeyi sabitleyebilir.
 *  - Yetki: karma ile ilgisi yoktur; yalnızca `users.staff_role` (ve geriye
 *    uyumluluk için `is_admin`) üzerinden verilir ve yetkilendirme katmanına
 *    bağlıdır.
 *
 * Kısıtlama (askıya alma) yalnızca **görsel** bir rozet durumudur: asıl rütbe
 * her zaman hesaplanmaya devam eder, böylece kısıtlama kalktığında kullanıcı
 * kendi karma rütbesine kendiliğinden döner.
 *
 * Arayüzde kullanıcı adının yanında **tek bir görsel rozet** gösterilir
 * (`rankBadgeFor`): kısıtlama > yönetim yetkisi > karma rütbesi. Yönetim
 * yetkisi varken karma rütbesi gösterilmez; yönetim paneli ise seçim
 * yaparken metin etiketlerini kullanmaya devam eder.
 */
import { t } from '../i18n/tr'
import type { Ctx } from '../context'
import type { UserRow } from '../types'

/* -------------------------------------------------------------------------- */
/* Rütbeler                                                                    */
/* -------------------------------------------------------------------------- */

export const RANK_IDS = ['new_user', 'active_user', 'super_user', 'angel', 'legend', 'god'] as const
export type RankId = (typeof RANK_IDS)[number]

export interface RankDef {
  id: RankId
  /** Eşik: bu değere eşit ve üstü tutar. */
  min: number
  label: string
}

export const RANKS: readonly RankDef[] = [
  { id: 'new_user', min: 0, label: 'New User' },
  { id: 'active_user', min: 51, label: 'Active User' },
  { id: 'super_user', min: 126, label: 'Super User' },
  { id: 'angel', min: 201, label: 'Angel' },
  { id: 'legend', min: 351, label: 'Legend' },
  { id: 'god', min: 501, label: 'God' },
] as const

export function isRankId(value: unknown): value is RankId {
  return typeof value === 'string' && (RANK_IDS as readonly string[]).includes(value)
}

export function rankDef(id: RankId): RankDef {
  return RANKS.find((r) => r.id === id) as RankDef
}

export function rankLabel(id: RankId): string {
  return rankDef(id).label
}

/** Karma eşiğinden rütbe. Negatif karma "New User" olarak değerlendirilir. */
export function rankForKarma(karma: number): RankId {
  const value = Number.isFinite(karma) ? Math.max(0, Math.floor(karma)) : 0
  let current: RankId = 'new_user'
  for (const rank of RANKS) {
    if (value >= rank.min) current = rank.id
  }
  return current
}

/* -------------------------------------------------------------------------- */
/* Yönetim yetkileri                                                           */
/* -------------------------------------------------------------------------- */

export const STAFF_ROLES = ['moderator', 'super_moderator', 'co_admin', 'admin'] as const
export type StaffRole = (typeof STAFF_ROLES)[number]

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  moderator: 'Moderator',
  super_moderator: 'Super Moderator',
  co_admin: 'Co-Admin',
  admin: 'Admin',
}

/** Rozet/sıralama için yetki gücü: yüksek sayı = daha geniş yetki. */
const STAFF_ROLE_POWER: Record<StaffRole, number> = {
  moderator: 1,
  super_moderator: 2,
  co_admin: 3,
  admin: 4,
}

export function parseStaffRole(raw: unknown): StaffRole | null {
  return typeof raw === 'string' && (STAFF_ROLES as readonly string[]).includes(raw) ? (raw as StaffRole) : null
}

type RoleUser = Pick<UserRow, 'staff_role' | 'is_admin'>

/** Kullanıcının yönetim yetkisi; eski `is_admin` bayrağı da "admin" sayılır. */
export function staffRoleOf(user: RoleUser | null | undefined): StaffRole | null {
  if (!user) return null
  const role = parseStaffRole(user.staff_role)
  if (role) return role
  return user.is_admin === 1 ? 'admin' : null
}

/** Site yöneticiliği düzeyinde yetki (gizli topluluklar, yönetim paneli, …). */
export function isAdminPower(user: RoleUser | null | undefined): boolean {
  const role = staffRoleOf(user)
  return role === 'admin' || role === 'co_admin'
}

/** Herhangi bir toplulukta moderasyon yapabilecek yetki. */
export function isModerationStaff(user: RoleUser | null | undefined): boolean {
  const role = staffRoleOf(user)
  return role !== null
}

/** Süper moderatör ve üzeri: tüm toplulukların moderasyon ekranlarına erişir. */
export function isSitewideModerator(user: RoleUser | null | undefined): boolean {
  const role = staffRoleOf(user)
  return role === 'super_moderator' || role === 'co_admin' || role === 'admin'
}

export function staffRolePower(role: StaffRole): number {
  return STAFF_ROLE_POWER[role]
}

/* -------------------------------------------------------------------------- */
/* Kullanıcı rütbesi                                                            */
/* -------------------------------------------------------------------------- */

export interface UserRank {
  /** Gösterilecek rütbe (kısıtlamada da hesaplanır, sadece görüntülenmez). */
  rank: RankId
  rankMode: 'auto' | 'manual'
  /** Rütbenin dayandığı (veya manuel olarak sabitlenen) değer. */
  karma: number
  staffRole: StaffRole | null
  /** Site genelinde askıya alınmış kullanıcı. */
  banned: boolean
  bannedPermanent: boolean
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

function karmaByUser(ctx: Ctx, userIds: string[]): Map<string, number> {
  const totals = new Map<string, number>()
  if (userIds.length === 0) return totals
  const marks = placeholders(userIds.length)
  const rows = ctx.db
    .prepare(
      `SELECT author_id AS id, COALESCE(SUM(score), 0) AS k FROM posts
       WHERE deleted = 0 AND removed = 0 AND author_id IN (${marks}) GROUP BY author_id`,
    )
    .all(...userIds) as unknown as Array<{ id: string; k: number }>
  for (const row of rows) totals.set(row.id, row.k)
  const commentRows = ctx.db
    .prepare(
      `SELECT author_id AS id, COALESCE(SUM(score), 0) AS k FROM comments
       WHERE deleted = 0 AND removed = 0 AND author_id IN (${marks}) GROUP BY author_id`,
    )
    .all(...userIds) as unknown as Array<{ id: string; k: number }>
  for (const row of commentRows) totals.set(row.id, (totals.get(row.id) ?? 0) + row.k)
  return totals
}

/**
 * Bir kullanıcının rütbesi. Manuel mod seçiliyse admin'in sabitlediği rütbe
 * kullanılır, aksi halde rütbe anlık karma değerinden hesaplanır.
 */
export function userRankInfo(ctx: Ctx, user: UserRow): UserRank {
  const [karma] = [...karmaByUser(ctx, [user.id]).values()]
  const total = karma ?? 0
  const manual = user.rank_mode === 'manual' && isRankId(user.rank_override)
  const rank: RankId = manual ? (user.rank_override as RankId) : rankForKarma(total)
  const banned = user.suspended_indefinitely === 1 || (user.suspended_until !== null && user.suspended_until > ctx.now())
  return {
    rank,
    rankMode: user.rank_mode,
    karma: total,
    staffRole: staffRoleOf(user),
    banned,
    bannedPermanent: user.suspended_indefinitely === 1,
  }
}

/** Rütbe haritası: karma ve yetkileri toplu (N+1 sorgu yapmadan) çözer. */
export function rankInfoFor(ctx: Ctx, users: UserRow[]): Map<string, UserRank> {
  const ids = users.map((u) => u.id)
  const karma = karmaByUser(ctx, ids)
  const now = ctx.now()
  const out = new Map<string, UserRank>()
  for (const user of users) {
    const total = karma.get(user.id) ?? 0
    const manual = user.rank_mode === 'manual' && isRankId(user.rank_override)
    out.set(user.id, {
      rank: manual ? (user.rank_override as RankId) : rankForKarma(total),
      rankMode: user.rank_mode,
      karma: total,
      staffRole: staffRoleOf(user),
      banned: user.suspended_indefinitely === 1 || (user.suspended_until !== null && user.suspended_until > now),
      bannedPermanent: user.suspended_indefinitely === 1,
    })
  }
  return out
}

/** Görüntüde kullanılan etiket: kısıtlıysa "Yasaklı", değilse rütbe adı. */
export function rankBadgeLabel(info: UserRank): string {
  return info.banned ? t.rank.banned : rankLabel(info.rank)
}

/* -------------------------------------------------------------------------- */
/* Rütbe görselleri                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Kullanıcı adının yanında gösterilen tek rozet görselinin kaynağı.
 *
 * Görseller `public/assets/ranks/` altında durur ve `npm run rank:assets`
 * (scripts/generate-rank-assets.mjs) ile üretilir. Hepsi gerçek GIF'tir:
 * ikon + rütbe yazısı taşıyan yatay forum rank bannerı, üst rütbeler ve
 * yönetim yetkileri sonsuz döngüde ışık huzmesiyle canlanır. SVG veya CSS
 * animasyonu yoktur; dosyalar normal `<img>` olarak çalışır.
 */
export const RANK_ASSET_DIR = '/static/assets/ranks'

const RANK_ASSET_FILES: Record<RankId, string> = {
  new_user: 'new-user.gif',
  active_user: 'active-user.gif',
  super_user: 'super-user.gif',
  angel: 'angel.gif',
  legend: 'legend.gif',
  god: 'god.gif',
}

const STAFF_ROLE_ASSET_FILES: Record<StaffRole, string> = {
  moderator: 'moderator.gif',
  super_moderator: 'super-moderator.gif',
  co_admin: 'co-admin.gif',
  admin: 'admin.gif',
}

/** Kısıtlama rozeti: koyu gri statik banner. */
export const BANNED_ASSET = `${RANK_ASSET_DIR}/banned.gif`

export function rankAsset(id: RankId): string {
  return `${RANK_ASSET_DIR}/${RANK_ASSET_FILES[id]}`
}

export function staffRoleAsset(role: StaffRole): string {
  return `${RANK_ASSET_DIR}/${STAFF_ROLE_ASSET_FILES[role]}`
}

export type RankBadgeKind = 'banned' | 'staff' | 'karma'

export interface RankBadge {
  kind: RankBadgeKind
  /** CSS sınıfı için ayırt edici değer: rütbe kimliği veya yetki rolü. */
  variant: string
  /** Kullanıcı adının yanında gösterilen görselin yolu. */
  src: string
  /** `alt`/`title` metni ve görsel yoksa gösterilecek yedek metin. */
  label: string
}

/**
 * Kullanıcının tek rozet görselini çözer.
 *
 * Öncelik sırası: kısıtlama > yönetim yetkisi > karma rütbesi. Yönetim yetkisi
 * varsa karma rütbesi **görüntülenmez** (arka planda hesaplanmaya devam eder), bu
 * yüzden asla iki rozet yan yana gösterilmez. Karma rütbesi `info.rank` alanından
 * okunduğu için kısıtlama kalktığında rozet kendiliğinden geri döner.
 */
export function rankBadgeFor(info: UserRank): RankBadge {
  if (info.banned) return { kind: 'banned', variant: 'banned', src: BANNED_ASSET, label: t.rank.banned }
  if (info.staffRole) {
    return {
      kind: 'staff',
      variant: info.staffRole,
      src: staffRoleAsset(info.staffRole),
      label: STAFF_ROLE_LABELS[info.staffRole],
    }
  }
  return { kind: 'karma', variant: info.rank, src: rankAsset(info.rank), label: rankLabel(info.rank) }
}
