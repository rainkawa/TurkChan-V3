import { describe, expect, test } from 'vitest'
import { rankForKarma, RANKS, rankLabel, isRankId, staffRoleOf, isAdminPower } from '../../src/services/ranks'

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
