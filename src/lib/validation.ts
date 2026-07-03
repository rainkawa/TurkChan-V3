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
} as const

const USERNAME_RE = /^[A-Za-z0-9_]+$/
const COMMUNITY_NAME_RE = /^[a-z0-9_]+$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateUsername(username: string): string {
  const trimmed = username.trim()
  if (trimmed.length < LIMITS.usernameMin || trimmed.length > LIMITS.usernameMax) {
    throw new ValidationError('username', `Username must be ${LIMITS.usernameMin}-${LIMITS.usernameMax} characters.`)
  }
  if (!USERNAME_RE.test(trimmed)) {
    throw new ValidationError('username', 'Username may only contain letters, numbers, and underscores.')
  }
  return trimmed
}

export function validateEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  if (!EMAIL_RE.test(trimmed) || trimmed.length > 254) {
    throw new ValidationError('email', 'Enter a valid email address.')
  }
  return trimmed
}

export function validatePassword(password: string): string {
  if (password.length < LIMITS.passwordMin) {
    throw new ValidationError('password', `Password must be at least ${LIMITS.passwordMin} characters.`)
  }
  if (password.length > 200) throw new ValidationError('password', 'Password is too long.')
  return password
}

export function validateCommunityName(name: string): string {
  const trimmed = name.trim().toLowerCase()
  if (trimmed.length < LIMITS.communityNameMin || trimmed.length > LIMITS.communityNameMax) {
    throw new ValidationError('name', `Community name must be ${LIMITS.communityNameMin}-${LIMITS.communityNameMax} characters.`)
  }
  if (!COMMUNITY_NAME_RE.test(trimmed)) {
    throw new ValidationError('name', 'Community name may only contain lowercase letters, numbers, and underscores.')
  }
  return trimmed
}

export function validatePostTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length < 1 || trimmed.length > LIMITS.postTitleMax) {
    throw new ValidationError('title', `Title must be 1-${LIMITS.postTitleMax} characters.`)
  }
  return trimmed
}

export function validatePostBody(body: string): string {
  if (body.length > LIMITS.postBodyMax) {
    throw new ValidationError('body', `Body must be at most ${LIMITS.postBodyMax.toLocaleString()} characters.`)
  }
  return body
}

export function validateCommentBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed.length < 1 || trimmed.length > LIMITS.commentMax) {
    throw new ValidationError('body', `Comment must be 1-${LIMITS.commentMax.toLocaleString()} characters.`)
  }
  return trimmed
}

export function validateDisplayName(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > LIMITS.displayNameMax) {
    throw new ValidationError('displayName', `Display name must be at most ${LIMITS.displayNameMax} characters.`)
  }
  return trimmed
}

export function validateBio(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > LIMITS.bioMax) {
    throw new ValidationError('bio', `Bio must be at most ${LIMITS.bioMax} characters.`)
  }
  return trimmed
}
