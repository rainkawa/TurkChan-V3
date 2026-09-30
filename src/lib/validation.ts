/** Boundary validation helpers (fail fast with field-level messages). */

export class ValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export const LIMITS = {
  usernameMin: 3,
  usernameMax: 20,
  passwordMin: 10,
  displayNameMax: 40,
  bioMax: 200,
  communityNameMin: 3,
  communityNameMax: 24,
  communityTitleMax: 100,
  communityDescriptionMax: 1000,
  ruleMax: 15,
  ruleTitleMax: 100,
  ruleDetailMax: 500,
  postTitleMax: 300,
  postBodyMax: 40000,
  commentMax: 10000,
  reportDetailMax: 1000,
  /** Özel mesaj (DM) sınırları. */
  dmMessageMax: 2000,
  dmMessagesPerHour: 120,
} as const

const USERNAME_RE = /^[A-Za-z0-9_]+$/
const COMMUNITY_NAME_RE = /^[a-z0-9_]+$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateUsername(username: string): string {
  const trimmed = username.trim()
  if (trimmed.length < LIMITS.usernameMin || trimmed.length > LIMITS.usernameMax) {
    throw new ValidationError('username', `Kullanıcı adı ${LIMITS.usernameMin}-${LIMITS.usernameMax} karakter olmalıdır.`)
  }
  if (!USERNAME_RE.test(trimmed)) {
    throw new ValidationError('username', 'Kullanıcı adı yalnızca harf, rakam ve alt çizgi içerebilir.')
  }
  return trimmed
}

export function validateEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  if (!EMAIL_RE.test(trimmed) || trimmed.length > 254) {
    throw new ValidationError('email', 'Geçerli bir e-posta adresi girin.')
  }
  return trimmed
}

export function validatePassword(password: string): string {
  if (password.length < LIMITS.passwordMin) {
    throw new ValidationError('password', `Parola en az ${LIMITS.passwordMin} karakter olmalıdır.`)
  }
  if (password.length > 200) throw new ValidationError('password', 'Parola çok uzun.')
  return password
}

export function validateCommunityName(name: string): string {
  const trimmed = name.trim().toLowerCase()
  if (trimmed.length < LIMITS.communityNameMin || trimmed.length > LIMITS.communityNameMax) {
    throw new ValidationError('name', `Topluluk adı ${LIMITS.communityNameMin}-${LIMITS.communityNameMax} karakter olmalıdır.`)
  }
  if (!COMMUNITY_NAME_RE.test(trimmed)) {
    throw new ValidationError('name', 'Topluluk adı yalnızca küçük harf, rakam ve alt çizgi içerebilir.')
  }
  return trimmed
}

export function validatePostTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length < 1 || trimmed.length > LIMITS.postTitleMax) {
    throw new ValidationError('title', `Başlık 1-${LIMITS.postTitleMax} karakter olmalıdır.`)
  }
  return trimmed
}

export function validatePostBody(body: string): string {
  if (body.length > LIMITS.postBodyMax) {
    throw new ValidationError('body', `İçerik en fazla ${LIMITS.postBodyMax.toLocaleString('tr-TR')} karakter olabilir.`)
  }
  return body
}

export function validateCommentBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed.length < 1 || trimmed.length > LIMITS.commentMax) {
    throw new ValidationError('body', `Yorum 1-${LIMITS.commentMax.toLocaleString('tr-TR')} karakter olmalıdır.`)
  }
  return trimmed
}

export function validateDisplayName(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > LIMITS.displayNameMax) {
    throw new ValidationError('displayName', `Görünen ad en fazla ${LIMITS.displayNameMax} karakter olabilir.`)
  }
  return trimmed
}

export function validateBio(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > LIMITS.bioMax) {
    throw new ValidationError('bio', `Tanıtım en fazla ${LIMITS.bioMax} karakter olabilir.`)
  }
  return trimmed
}
