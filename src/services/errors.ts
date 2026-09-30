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

export const notFound = (message = 'Bulunamadı.') => new AppError(404, 'not_found', message)
export const forbidden = (message = 'Bunu yapmaya yetkiniz yok.') => new AppError(403, 'forbidden', message)
export const unauthorized = (message = 'Önce giriş yapmalısınız.') => new AppError(401, 'unauthorized', message)
export const conflict = (code: string, message: string) => new AppError(409, code, message)
export const badRequest = (code: string, message: string) => new AppError(400, code, message)
export const rateLimited = (retryAfterMs: number) =>
  new AppError(
    429,
    'rate_limited',
    `Yavaşlayın — ${Math.max(1, Math.ceil(retryAfterMs / 1000))} saniye sonra tekrar deneyin.`,
    retryAfterMs,
  )
