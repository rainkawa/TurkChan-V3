/**
 * Ranking math per PRD technical considerations.
 *
 * Hot: Reddit's open-sourced formula — log10(max(|score|,1)) * sign(score) + age/decay.
 * The decay constant is configurable (site setting); small communities want
 * slower decay (90k-180k seconds) so the front page doesn't empty out.
 *
 * Best: Wilson score lower bound of the upvote ratio at 85% confidence —
 * "confidence a comment is good" with few votes.
 */

export function hotRank(score: number, createdAtMs: number, decaySeconds: number): number {
  const order = Math.log10(Math.max(Math.abs(score), 1))
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0
  const seconds = createdAtMs / 1000
  return sign * order + seconds / decaySeconds
}

const Z = 1.44 // 85% two-sided confidence, Reddit's choice for comment sort

export function wilsonLowerBound(upvotes: number, downvotes: number): number {
  const n = upvotes + downvotes
  if (n === 0) return 0
  const phat = upvotes / n
  const z2 = Z * Z
  const numerator = phat + z2 / (2 * n) - Z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)
  return numerator / (1 + z2 / n)
}
