/**
 * SQLite schema. Written to stay portable to Postgres: plain-SQL types, no
 * SQLite-only column affinities in domain tables. FTS5 mirrors Postgres FTS.
 * Timestamps are epoch milliseconds (integer) throughout.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  email_lower TEXT UNIQUE,
  password_hash TEXT NOT NULL DEFAULT '',
  display_name TEXT,
  bio TEXT,
  avatar_key TEXT,                    -- profile picture (uploads key)
  cover_key TEXT,                     -- profile cover image (uploads key)
  is_admin INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  suspended_until INTEGER,          -- epoch ms; NULL = not suspended (unless indefinite)
  suspended_indefinitely INTEGER NOT NULL DEFAULT 0,
  suspension_reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_lower TEXT NOT NULL,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username_lower, created_at);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,        -- immutable slug, lowercase
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public','restricted','private')),
  archived INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,               -- soft delete; purged after 30 days
  auto_hide_reports INTEGER NOT NULL DEFAULT 0,  -- 0 = off
  hide_comment_scores_minutes INTEGER NOT NULL DEFAULT 0,
  creator_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS community_rules (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_rules_community ON community_rules(community_id, position);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  community_id TEXT NOT NULL REFERENCES communities(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator')),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  mod_since INTEGER,                -- set when role becomes moderator (oldest-standing rule)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, community_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_community ON memberships(community_id, status);

CREATE TABLE IF NOT EXISTS bans (
  community_id TEXT NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER,               -- NULL = permanent
  reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('text','link','image')),
  title TEXT NOT NULL,
  body TEXT,                        -- markdown source (text posts)
  url TEXT,                         -- link posts
  link_preview_title TEXT,
  link_preview_image TEXT,
  image_key TEXT,                   -- image posts
  score INTEGER NOT NULL DEFAULT 0,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,                -- NULL = not pinned
  removed INTEGER NOT NULL DEFAULT 0,      -- by moderator
  auto_hidden INTEGER NOT NULL DEFAULT 0,  -- hidden pending review (report threshold)
  deleted INTEGER NOT NULL DEFAULT 0,      -- by author
  edited_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_url ON posts(community_id, url);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  parent_id TEXT REFERENCES comments(id),
  path TEXT NOT NULL,               -- materialized path of ancestor ids, '/'-joined
  depth INTEGER NOT NULL,           -- 0-based, capped at 8 visual levels (0..7 nesting + flatten)
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  auto_hidden INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  edited_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, path);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS votes (
  user_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment')),
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (1,-1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment')),
  target_id TEXT NOT NULL,
  community_id TEXT NOT NULL REFERENCES communities(id),
  reporter_id TEXT NOT NULL REFERENCES users(id),
  reason_type TEXT NOT NULL CHECK (reason_type IN ('rule','spam','harassment','other')),
  rule_id TEXT REFERENCES community_rules(id),
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by TEXT REFERENCES users(id),
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_reports_queue ON reports(community_id, status, created_at);

CREATE TABLE IF NOT EXISTS mod_actions (
  id TEXT PRIMARY KEY,
  community_id TEXT REFERENCES communities(id),  -- NULL = site-level admin action
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  reason TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mod_actions_community ON mod_actions(community_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('reply','mod_removal','mod_ban','membership')),
  actor_hidden INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  source_comment_id TEXT,           -- for withdrawal when the reply is removed
  read INTEGER NOT NULL DEFAULT 0,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);

CREATE TABLE IF NOT EXISTS uploads (
  key TEXT PRIMARY KEY,             -- unguessable UUID
  uploader_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,         -- pre-signed upload token
  mime TEXT,
  size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','attached')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exports (
  token TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  file_path TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title, body, post_id UNINDEXED
);
CREATE VIRTUAL TABLE IF NOT EXISTS communities_fts USING fts5(
  name, title, description, community_id UNINDEXED
);
`
