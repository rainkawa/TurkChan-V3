# Komuniti — Community Discussion Platform

A self-hosted, Reddit-style discussion platform for community organisations (NGO programmes, youth organisations, mosques, madrasahs). Built per the Community Platform PRD v0.1: accounts, communities, posts, nested comments, voting, ranked feeds, and a full moderation + admin layer.

## Stack

- **TypeScript + Hono** — one monolith, server-side-rendered JSX views (mobile-first), small vanilla-JS enhancement layer (optimistic voting, markdown preview, local-storage drafts).
- **SQLite via built-in `node:sqlite`** — zero native dependencies, FTS5 search. The schema is written portably (plain SQL types, epoch-ms timestamps) so production can move to PostgreSQL as the PRD recommends; SQLite is ideal for the single-VPS deployment target and for hermetic tests.
- **Argon2id** password hashing (`@node-rs/argon2`), HTTP-only SameSite=Lax session cookies.
- **Local object storage adapter** with a pre-signed-style upload flow (unguessable UUID keys, signature validation, pure-JS EXIF/GPS stripping for JPEG/PNG/WebP). Swappable for S3-compatible storage via the `ObjectStorage` interface.

## Run

```bash
npm install
npm run seed   # demo communities/users (admin / seed-admin-pass-1, ...)
npm run dev    # http://localhost:3000
```

The **first registered user becomes site admin**.

```bash
npm test           # 157 tests: unit + full HTTP integration incl. US-044 access matrix
npm run typecheck
```

## Feature map (PRD → code)

| PRD | Where |
|---|---|
| FR-1/2 Accounts, profiles, reset, deletion | `src/services/auth.ts`, `users.ts` |
| FR-3/4 Communities, membership, approvals | `src/services/communities.ts` |
| FR-5 Text/link/image posts, SSRF guard, EXIF strip | `src/services/posts.ts`, `linkpreview.ts`, `uploads.ts`, `src/lib/urlguard.ts`, `images.ts` |
| FR-6 Nested comments (materialized path, depth cap 8) | `src/services/comments.ts` |
| FR-7 Voting (unique constraint, idempotent, no self-vote) | `src/services/votes.ts` |
| FR-8 Karma (computed, removal-reversing) | `src/services/users.ts` |
| FR-9/10 Hot/New/Top feeds, Wilson comment sort, cursors | `src/services/feeds.ts`, `src/lib/ranking.ts`, `cursor.ts` |
| FR-11 Search (FTS5, visibility-aware) | `src/services/search.ts` |
| FR-12/13 Reports, moderation, mod log, bans, pins | `src/services/reports.ts`, `moderation.ts`, `modlog.ts` |
| FR-14 Admin (suspend, archive/delete, policies, invites, export) | `src/services/admin.ts`, `src/routes/admin.tsx` |
| FR-15 Notifications (replies, mod actions, withdrawal) | `src/services/notifications.ts` |
| FR-16 Rate limiting (configurable, per-account + per-IP) | `src/lib/ratelimit.ts`, `src/services/settings.ts` |
| FR-17 Account deletion, JSON export | `auth.ts#deleteAccount`, `admin.ts#exportCommunity` |
| US-044 access matrix | enforced in `src/services/access.ts`, tested in `test/integration/access.test.ts` |

## Configuration

Environment: `PORT`, `DB_PATH`, `UPLOAD_DIR`, `BASE_URL`. Runtime policies (registration mode open/invite/closed, community-creation policy, hot-decay constant, rate limits) are editable in the admin dashboard (`/admin?tab=settings`).

## Production notes

- Deploy behind Caddy (TLS, HSTS); set `NODE_ENV=production` for Secure cookies.
- Wire a real mailer (Resend/Postmark/SES) by implementing the `Mailer` interface in `src/lib/mailer.ts`.
- Point `ObjectStorage` at S3-compatible storage for images; serve via CDN.
- Nightly `sqlite3 data/app.db ".backup ..."` (or move to Postgres) + off-server encrypted copies; test restores quarterly per the PRD.
