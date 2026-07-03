/** Domain errors carrying an HTTP status; routes translate uniformly. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message)
export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(403, 'forbidden', message)
export const unauthorized = (message = 'You need to log in first.') =>
  new AppError(401, 'unauthorized', message)
export const conflict = (code: string, message: string) => new AppError(409, code, message)
export const badRequest = (code: string, message: string) => new AppError(400, code, message)
export const rateLimited = (retryAfterMs: number) =>
  new AppError(
    429,
    'rate_limited',
    `Slow down — try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`,
    retryAfterMs,
  )
