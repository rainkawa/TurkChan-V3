import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  rankForKarma,
  RANKS,
  rankLabel,
  isRankId,
  staffRoleOf,
  isAdminPower,
  rankAsset,
  staffRoleAsset,
  BANNED_ASSET,
  RANK_ASSET_DIR,
  rankBadgeFor,
  STAFF_ROLES,
  type StaffRole,
  type UserRank,
} from '../../src/services/ranks'

describe('rank thresholds (karma → rütbe)', () => {
  // Kullanıcı tarafından belirtilen sınır değerleri: alt sınır yeni rütbeye geçer.
  const cases: Array<[number, string]> = [
    [0, 'new_user'],
    [50, 'new_user'],
    [51, 'active_user'],
    [125, 'active_user'],
    [126, 'super_user'],
    [200, 'super_user'],
    [201, 'angel'],
    [350, 'angel'],
    [351, 'legend'],
    [500, 'legend'],
    [501, 'god'],
  ]

  for (const [karma, expected] of cases) {
    test(`karma ${karma} → ${expected}`, () => {
      expect(rankForKarma(karma)).toBe(expected)
    })
  }

  test('negatif karma sıfır gibi değerlendirilir', () => {
    expect(rankForKarma(-25)).toBe('new_user')
  })

  test('eşikler artan sırada ve 0 ile başlıyor', () => {
    expect(RANKS[0]?.min).toBe(0)
    const mins = RANKS.map((r) => r.min)
    expect([...mins].sort((a, b) => a - b)).toEqual(mins)
  })

  test('rütbe etiketleri tanımlı', () => {
    expect(RANKS.map((r) => r.label)).toEqual([
      'New User',
      'Active User',
      'Super User',
      'Angel',
      'Legend',
      'God',
    ])
    expect(rankLabel('god')).toBe('God')
    expect(isRankId('legend')).toBe(true)
    expect(isRankId('wizard')).toBe(false)
  })
})

describe('rank rozet görselleri', () => {
  const base = (over: Partial<UserRank> = {}): UserRank => ({
    rank: 'new_user',
    rankMode: 'auto',
    karma: 0,
    staffRole: null,
    banned: false,
    bannedPermanent: false,
    ...over,
  })

  test('her rütbenin ve yetkinin bir görsel dosyası var', () => {
    expect(RANK_ASSET_DIR).toBe('/static/assets/ranks')
    expect(RANKS.map((r) => rankAsset(r.id))).toEqual([
      '/static/assets/ranks/new-user.png',
      '/static/assets/ranks/active-user.png',
      '/static/assets/ranks/super-user.png',
      '/static/assets/ranks/angel.gif',
      '/static/assets/ranks/legend.gif',
      '/static/assets/ranks/god.gif',
    ])
    expect(STAFF_ROLES.map((r) => staffRoleAsset(r))).toEqual([
      '/static/assets/ranks/moderator.gif',
      '/static/assets/ranks/super-moderator.gif',
      '/static/assets/ranks/co-admin.gif',
      '/static/assets/ranks/admin.gif',
    ])
    expect(BANNED_ASSET).toBe('/static/assets/ranks/banned.png')
  })

  test('ilk üç karma rütbesi statik PNG, üstleri ve tüm yetkiler GIF', () => {
    for (const rank of ['new_user', 'active_user', 'super_user'] as const) {
      expect(rankAsset(rank).endsWith('.png')).toBe(true)
    }
    for (const rank of ['angel', 'legend', 'god'] as const) {
      expect(rankAsset(rank).endsWith('.gif')).toBe(true)
    }
    for (const role of STAFF_ROLES) {
      expect(staffRoleAsset(role).endsWith('.gif')).toBe(true)
    }
    expect(BANNED_ASSET.endsWith('.png')).toBe(true)
  })

  test('görsel dosyalar depoda mevcut', () => {
    const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')
    const files = [
      ...RANKS.map((r) => rankAsset(r.id)),
      ...STAFF_ROLES.map((r) => staffRoleAsset(r)),
      BANNED_ASSET,
    ]
    for (const url of files) {
      expect(url.startsWith(`${RANK_ASSET_DIR}/`), url).toBe(true)
      expect(existsSync(join(publicDir, url.replace('/static/', ''))), url).toBe(true)
    }
  })

  test('yönetim yetkisi varsa yalnızca yetki rozeti seçilir', () => {
    for (const role of STAFF_ROLES) {
      const badge = rankBadgeFor(base({ rank: 'god', karma: 900, staffRole: role as StaffRole }))
      expect(badge.kind).toBe('staff')
      expect(badge.variant).toBe(role)
      expect(badge.src).toBe(staffRoleAsset(role as StaffRole))
    }
  })

  test('kısıtlama her şeyi gölgeler, kalkınca kendi durumuna döner', () => {
    const banned = rankBadgeFor(base({ rank: 'legend', karma: 400, banned: true }))
    expect(banned.kind).toBe('banned')
    expect(banned.src).toBe(BANNED_ASSET)

    // Kısıtlama kalktığında aynı kullanıcı yeniden Legend olur.
    const after = rankBadgeFor(base({ rank: 'legend', karma: 400 }))
    expect(after.kind).toBe('karma')
    expect(after.src).toBe('/static/assets/ranks/legend.gif')

    // Kısıtlı yönetici de Yasaklı görünür; yetki mantığı ayrı katmanda çalışır.
    const bannedStaff = rankBadgeFor(base({ rank: 'god', karma: 900, staffRole: 'admin', banned: true }))
    expect(bannedStaff.src).toBe(BANNED_ASSET)
  })

  test('etiketler görselle eşleşir', () => {
    expect(rankBadgeFor(base({ rank: 'angel', karma: 210 })).label).toBe('Angel')
    expect(rankBadgeFor(base({ rank: 'legend', karma: 400, staffRole: 'co_admin' })).label).toBe('Yardımcı Yönetici')
    expect(rankBadgeFor(base({ banned: true })).label).toBe('Yasaklı')
  })
})

describe('yönetim yetkileri', () => {
  test('yetki adları Türkçe ve bağımsız', () => {
    expect(staffRoleOf({ staff_role: 'moderator', is_admin: 0 })).toBe('moderator')
    expect(staffRoleOf({ staff_role: 'super_moderator', is_admin: 0 })).toBe('super_moderator')
    expect(staffRoleOf({ staff_role: 'co_admin', is_admin: 0 })).toBe('co_admin')
    expect(staffRoleOf({ staff_role: 'admin', is_admin: 0 })).toBe('admin')
    expect(staffRoleOf({ staff_role: '', is_admin: 0 })).toBeNull()
  })

  test('eski is_admin bayrağı yönetici yetkisi sayılır', () => {
    expect(staffRoleOf({ staff_role: '', is_admin: 1 })).toBe('admin')
    expect(isAdminPower({ staff_role: 'co_admin', is_admin: 0 })).toBe(true)
    expect(isAdminPower({ staff_role: 'moderator', is_admin: 0 })).toBe(false)
    expect(isAdminPower({ staff_role: '', is_admin: 0 })).toBe(false)
  })
})
