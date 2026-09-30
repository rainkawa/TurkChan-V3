/** Yeniden dışa aktarma: zaman biçimlendirme tek kaynaktan (i18n/tr) gelir. */
export { relativeTime, formatDate } from '../i18n/tr'

/**
 * Markdown kaynağını kart önizlemesi için düz metne çevirir. Girdi zaten
 * kullanıcı içeriğidir ve JSX tarafında metin olarak basılır (HTML olarak
 * yorumlanmaz), bu yüzden HTML kaçışı render katmanında zaten var.
 */
export function previewText(markdown: string | null, max = 220): string {
  if (!markdown) return ''
  const text = markdown
    // Kod blokları ve görseller tamamen atılır.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  return `${text.slice(0, max).replace(/\s+\S*$/, '')}…`
}

/** 12900 -> "12,9 B" gibi kısa sayı biçimi (yerel ayraçlı). */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value)
  return new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

/** Hesap yaşını kısa biçimde döndürür: "2 y", "7 ay", "12 g". */export function accountAge(createdAt: number, now: number): string {
  const ms = Math.max(0, now - createdAt)
  const days = Math.floor(ms / 86_400_000)
  if (days >= 365) return `${Math.floor(days / 365)} y`
  if (days >= 30) return `${Math.floor(days / 30)} ay`
  return `${Math.max(1, days)} g`
}

const TR_MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
] as const

/** Kullanıcı profil yolu: /tc/kullaniciadi */
export function profilePath(username: string): string {
  return `/tc/${encodeURIComponent(username)}`
}

/** Kısa Türkçe uzun tarih: "1 Temmuz 2026". */
export function formatDateTr(ms: number): string {
  const d = new Date(ms)
  const month = TR_MONTHS[d.getUTCMonth()] ?? ''
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`
}

/** Topluluk adından sabit bir avatar rengi türetir (isimden deterministik). */
export function communityColor(name: string): string {
  const palette = ['#0f6b62', '#b45309', '#7c3aed', '#be123c', '#0369a1', '#4d7c0f', '#c2410c', '#0e7490']
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return palette[hash % palette.length] as string
}

/** Topluluk adının baş harfleri (avatar yazısı). */
export function communityInitials(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ ]/g, ' ').trim()
  if (!cleaned) return '?'
  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length === 1) return (words[0] as string).slice(0, 2).toLocaleUpperCase('tr-TR')
  return `${(words[0] as string)[0] ?? ''}${(words[1] as string)[0] ?? ''}`.toLocaleUpperCase('tr-TR')
}
