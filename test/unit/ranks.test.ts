import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GifReader } from 'omggif'
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
  STAFF_ROLE_LABELS,
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

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')
/** `/static/assets/ranks/x.gif` → depodaki gerçek dosya yolu. */
const assetPath = (url: string) => join(PUBLIC_DIR, url.replace('/static/', ''))
const allAssetUrls = () => [
  ...RANKS.map((r) => rankAsset(r.id)),
  ...STAFF_ROLES.map((r) => staffRoleAsset(r)),
  BANNED_ASSET,
]

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

  test('her rütbenin ve yetkinin bir GIF dosyası var', () => {
    expect(RANK_ASSET_DIR).toBe('/static/assets/ranks')
    expect(RANKS.map((r) => rankAsset(r.id))).toEqual([
      '/static/assets/ranks/new-user.gif',
      '/static/assets/ranks/active-user.gif',
      '/static/assets/ranks/super-user.gif',
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
    expect(BANNED_ASSET).toBe('/static/assets/ranks/banned.gif')
  })

  test('görsel dosyalar depoda mevcut', () => {
    for (const url of allAssetUrls()) {
      expect(url.startsWith(`${RANK_ASSET_DIR}/`), url).toBe(true)
      expect(existsSync(assetPath(url)), url).toBe(true)
    }
  })

  test('klasörde yalnızca 11 GIF var, SVG/PNG artığı yok', () => {
    const files = readdirSync(dirname(assetPath(`${RANK_ASSET_DIR}/x`))).sort()
    expect(files).toHaveLength(11)
    expect(files.every((f) => f.endsWith('.gif'))).toBe(true)
    expect(files.some((f) => f.endsWith('.svg') || f.endsWith('.png'))).toBe(false)
  })

  test('hepsi gerçek, sonsuz döngülü animasyonlu GIF bannerı', () => {
    for (const url of allAssetUrls()) {
      const buf = readFileSync(assetPath(url))
      // SVG değil: dosya GIF imzasıyla başlamalı
      expect(buf.toString('ascii', 0, 3), url).toBe('GIF')
      expect(buf.toString('ascii', 0, 6), url).toMatch(/^GIF8[79]a$/)

      const reader = new GifReader(new Uint8Array(buf))
      expect(reader.height, url).toBe(60) // 30 mantıksal px, 2x
      expect(reader.width, url).toBeGreaterThanOrEqual(200) // ~100 mantıksal px
      expect(reader.width, url).toBeLessThanOrEqual(360) // ~180 mantıksal px
      expect(reader.numFrames(), url).toBeGreaterThanOrEqual(5)
      expect(reader.loopCount(), url).toBe(0) // sonsuz döngü
      // kare süresi 50–200 ms aralığında (GIF birimi: saniyenin 1/100'ü)
      const delay = reader.frameInfo(0).delay
      expect(delay, url).toBeGreaterThanOrEqual(5)
      expect(delay, url).toBeLessThanOrEqual(20)

      // kareler birbirinden farklı olmalı (yani gerçekten animasyon var)
      const pixels = new Uint8Array(reader.width * reader.height * 4)
      const hashes = new Set<number>()
      for (let f = 0; f < reader.numFrames(); f++) {
        reader.decodeAndBlitFrameRGBA(f, pixels)
        let hash = 0
        for (let i = 0; i < pixels.length; i += 4) hash = (Math.imul(hash, 31) + pixels[i]!) | 0
        hashes.add(hash)
      }
      expect(hashes.size, url).toBe(reader.numFrames())
    }
  })

  test('üst rütbeler ve yönetim yetkileri daha belirgin animasyonlu', () => {
    const framesOf = (url: string) => new GifReader(new Uint8Array(readFileSync(assetPath(url)))).numFrames()
    const calm = ['new-user', 'active-user', 'super-user', 'banned'].map((n) => framesOf(`${RANK_ASSET_DIR}/${n}.gif`))
    const animated = [
      ...['angel', 'legend', 'god'].map((n) => `${RANK_ASSET_DIR}/${n}.gif`),
      ...STAFF_ROLES.map((r) => staffRoleAsset(r)),
    ].map(framesOf)
    expect(new Set(calm).size, 'sakin rütbeler aynı kare sayısında olmalı').toBe(1)
    expect(new Set(animated).size, 'animasyonlu rütbeler aynı kare sayısında olmalı').toBe(1)
    expect(animated[0]!).toBeGreaterThan(calm[0]!)
  })

  test('rozet yazıları görselde görünen adlarla aynı', () => {
    expect(RANKS.map((r) => rankLabel(r.id))).toEqual([
      'New User',
      'Active User',
      'Super User',
      'Angel',
      'Legend',
      'God',
    ])
    expect(STAFF_ROLES.map((r) => STAFF_ROLE_LABELS[r])).toEqual([
      'Moderator',
      'Super Moderator',
      'Co-Admin',
      'Admin',
    ])
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
    expect(rankBadgeFor(base({ rank: 'legend', karma: 400, staffRole: 'co_admin' })).label).toBe('Co-Admin')
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
