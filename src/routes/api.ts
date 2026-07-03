import { Hono } from 'hono'
import type { Ctx } from '../context'
import { castVote } from '../services/votes'
import { renderMarkdown } from '../lib/markdown'
import { requestUpload, receiveUpload, serveUpload } from '../services/uploads'
import { badRequest } from '../services/errors'
import type { AppEnv } from './helpers'

export function apiRoutes(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** US-022: vote endpoint. JSON in/out; optimistic UI reconciles with this. */
  app.post('/api/vote', async (c) => {
    const viewer = c.get('viewer')
    const body = (await c.req.json().catch(() => ({}))) as {
      targetType?: string
      targetId?: string
      value?: number
    }
    const targetType = body.targetType === 'comment' ? 'comment' : body.targetType === 'post' ? 'post' : null
    if (!targetType || typeof body.targetId !== 'string') {
      throw badRequest('input', 'targetType and targetId are required.')
    }
    const result = castVote(ctx, viewer, targetType, body.targetId, Number(body.value))
    return c.json(result)
  })

  app.post('/api/markdown-preview', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string }
    const text = typeof body.text === 'string' ? body.text.slice(0, 40000) : ''
    return c.json({ html: renderMarkdown(text) })
  })

  /** Pre-signed-style upload flow (US-015). */
  app.post('/api/uploads', (c) => {
    const viewer = c.get('viewer')
    const slot = requestUpload(ctx, viewer)
    return c.json({ key: slot.key, token: slot.token, uploadUrl: `/api/uploads/${slot.key}?token=${slot.token}` })
  })

  app.put('/api/uploads/:key', async (c) => {
    const token = c.req.query('token') ?? ''
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const upload = await receiveUpload(ctx, c.req.param('key'), token, bytes)
    return c.json({ key: upload.key, mime: upload.mime, size: upload.size })
  })

  /**
   * Image delivery. Production serves from object storage/CDN directly; this
   * route is the local-storage equivalent. Keys are unguessable UUIDs (US-044).
   */
  app.get('/media/:key', async (c) => {
    const result = await serveUpload(ctx, c.req.param('key'))
    if (!result) return c.notFound()
    return c.body(result.bytes.buffer as ArrayBuffer, 200, {
      'Content-Type': result.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  return app
}
