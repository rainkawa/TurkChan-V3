/**
 * Çevrimiçi durumu ve "yazıyor" göstergesi.
 *
 * Tek süreçli dağıtım (README'de tek düğüm hedefi) olduğu için bellekte tutulur;
 * her istek bu haritayı günceller, "yazıyor" bilgisi ise kısa süreli bir TTL ile
 * kendiliğinden söner. Kalıcı veri tabanına yazılmaz — sohbet kapandığında
 * göstergenin kaybolması doğru davranıştır.
 */

/** Bu süre içinde görülen kullanıcı çevrimiçi sayılır. */
const ONLINE_WINDOW_MS = 45_000
/** "Yazıyor" göstergesi ne kadar sonra söner. */
const TYPING_TTL_MS = 6_000

const lastSeen = new Map<string, number>()
const typingUntil = new Map<string, number>()

const typingKey = (conversationId: string, userId: string) => `${conversationId}:${userId}`

/** Kullanıcıyı "görüldü" olarak işaretler (her DM isteğinde çağrılır). */
export function touch(userId: string, now: number): void {
  lastSeen.set(userId, now)
}

export function isOnline(userId: string, now: number): boolean {
  const seen = lastSeen.get(userId)
  return seen !== undefined && now - seen < ONLINE_WINDOW_MS
}

/** Verilen kullanıcılar arasından çevrimiçi olanların kümesi. */
export function onlineSet(userIds: string[], now: number): Set<string> {
  const out = new Set<string>()
  for (const id of userIds) if (isOnline(id, now)) out.add(id)
  return out
}

/** Yazıyor göstergesini aç/kapat. Kapatıldığında kayıt silinir. */
export function setTyping(conversationId: string, userId: string, on: boolean, now: number): void {
  const key = typingKey(conversationId, userId)
  if (on) {
    typingUntil.set(key, now + TYPING_TTL_MS)
    touch(userId, now)
  } else {
    typingUntil.delete(key)
  }
}

export function isTyping(conversationId: string, userId: string, now: number): boolean {
  const until = typingUntil.get(typingKey(conversationId, userId))
  if (until === undefined) return false
  if (until <= now) {
    typingUntil.delete(typingKey(conversationId, userId))
    return false
  }
  return true
}

/** Testlerde sıfırlama: modül durumu süreç genelinde olduğu için gerekir. */
export function resetPresence(): void {
  lastSeen.clear()
  typingUntil.clear()
}
