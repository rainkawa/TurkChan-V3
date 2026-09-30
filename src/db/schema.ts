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
  anon_by_default INTEGER NOT NULL DEFAULT 0,  -- gönderileri anonim paylaş
  rank_mode TEXT NOT NULL DEFAULT 'auto' CHECK (rank_mode IN ('auto','manual')),
  rank_override TEXT,                 -- manual rank id; NULL = follow karma
  staff_role TEXT NOT NULL DEFAULT '' CHECK (staff_role IN ('','moderator','super_moderator','co_admin','admin')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  suspended_until INTEGER,          -- epoch ms; NULL = not suspended (unless indefinite)
  suspended_indefinitely INTEGER NOT NULL DEFAULT 0,
  suspension_reason TEXT,
  created_at INTEGER NOT NULL
);

-- Oturum tablosunda bilerek IP adresi / User-Agent / cihaz bilgisi SAKLANMAZ.
-- Hiçbir özellik bunları okumuyor; gizlilik ilkesi gereği toplanmamaları tercih
-- edilir. Token'ın kendisi de düz metin değil yalnızca SHA-256 karmasıdır.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0  -- idle zaman aşımı için son kullanım
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_lower TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

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

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  community_id TEXT NOT NULL REFERENCES communities(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator')),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  mod_since INTEGER,                -- set when role becomes moderator (oldest-standing rule)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, community_id)
);

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
  number INTEGER,                    -- topluluk içinde 1'den başlayan post no (>>12345)
  title TEXT NOT NULL,
  body TEXT,                        -- markdown source (text posts)
  url TEXT,                         -- link posts
  link_preview_title TEXT,
  link_preview_image TEXT,
  image_key TEXT,                   -- image posts
  media_kind TEXT NOT NULL DEFAULT 'none',  -- none | image | gif | video | embed
  spoiler INTEGER NOT NULL DEFAULT 0,       -- 1 = içerik "Göster"e kadar gizli
  flair_id TEXT REFERENCES board_flairs(id),
  score INTEGER NOT NULL DEFAULT 0,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,                -- NULL = not pinned
  removed INTEGER NOT NULL DEFAULT 0,      -- by moderator
  auto_hidden INTEGER NOT NULL DEFAULT 0,  -- hidden pending review (report threshold)
  deleted INTEGER NOT NULL DEFAULT 0,      -- by author
  edited_at INTEGER,
  created_at INTEGER NOT NULL,
  -- Anonim paylaşım: gerçek yazar yalnızca yöneticilere görünür.
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  anon_name TEXT,
  -- İstatistik
  view_count INTEGER NOT NULL DEFAULT 0
);

-- Gönderiye eklenen çoklu medya (görsel / GIF / video). Sıra pozisyonla korunur.
CREATE TABLE IF NOT EXISTS post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  position INTEGER NOT NULL,
  media_key TEXT NOT NULL,           -- uploads.key
  mime TEXT,
  kind TEXT NOT NULL,                -- image | gif | video
  created_at INTEGER NOT NULL
);

-- Görüntülenme sayacı: aynı ziyaretçi bir gönderiyi iki kez saymaz.
CREATE TABLE IF NOT EXISTS post_views (
  post_id TEXT NOT NULL REFERENCES posts(id),
  viewer_key TEXT NOT NULL,          -- kullanıcı id veya 'ip:<hash>'
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, viewer_key)
);



-- Board etiketleri (flair): her board kendi etiket kümesini yönetir.
CREATE TABLE IF NOT EXISTS board_flairs (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',     -- boşsa temaya uygun otomatik renk
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Kullanıcının bir boarda olan ilgisi (kişiselleştirilmiş ana sayfa feed'i).
-- Keşif yapan üye burada sayacı artırır; geri bildirim butonu azaltır.
CREATE TABLE IF NOT EXISTS community_affinity (
  user_id TEXT NOT NULL REFERENCES users(id),
  community_id TEXT NOT NULL REFERENCES communities(id),
  affinity REAL NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, community_id)
);

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
  created_at INTEGER NOT NULL,
  spoiler INTEGER NOT NULL DEFAULT 0,      -- 1 = "Göster"e kadar gizli
  is_anonymous INTEGER NOT NULL DEFAULT 0, -- anonim yorum
  anon_name TEXT
);

-- Yoruma eklenen medya (görsel / GIF / video). Sıra pozisyonla korunur.
CREATE TABLE IF NOT EXISTS comment_media (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id),
  position INTEGER NOT NULL,
  media_key TEXT NOT NULL,
  mime TEXT,
  kind TEXT NOT NULL,                -- image | gif | video
  created_at INTEGER NOT NULL
);

-- Imageboard tarzı gönderi referansları (>>12345).
-- Numaralar topluluk içinde 1'den başlar ve atlanmaz; backlink için saklanır.
CREATE TABLE IF NOT EXISTS post_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  target_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (source_post_id, target_post_id)
);

-- Yorumda geçen @kullanıcı bahsi (bildirim için).
CREATE TABLE IF NOT EXISTS comment_mentions (
  comment_id TEXT NOT NULL REFERENCES comments(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS votes (
  user_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment')),
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (1,-1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);

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

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  actor_id TEXT,                      -- bildirimi tetikleyen kullanıcı (rozet gösterimi için)
  type TEXT NOT NULL CHECK (type IN ('reply','mention','mod_removal','mod_ban','membership')),
  actor_hidden INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  source_comment_id TEXT,           -- for withdrawal when the reply is removed
  read INTEGER NOT NULL DEFAULT 0,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Özel mesajlar (DM) ------------------------------------------------------
-- Bir sohbet iki üyeden oluşur; mesajlar conversation_id üzerinden toplanır.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  last_read_at INTEGER NOT NULL DEFAULT 0,  -- epoch ms; okundu sayılma anı
  last_read_rowid INTEGER NOT NULL DEFAULT 0, -- o ana kadar okunmuş son mesajın rowid'i
  archived INTEGER NOT NULL DEFAULT 0,       -- arşivde
  hidden INTEGER NOT NULL DEFAULT 0,        -- "sohbeti benden sil" (kendi listemden gizler)
  accepted INTEGER NOT NULL DEFAULT 1,       -- 0 = karşı taraf henüz kabul etmedi (istek)
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  reply_to_id TEXT REFERENCES messages(id),
  created_at INTEGER NOT NULL,
  deleted_for_everyone INTEGER NOT NULL DEFAULT 0
);

-- "Sadece benden sil": mesajı silen kişi dışında herkes görmeye devam eder.
CREATE TABLE IF NOT EXISTS message_deletions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (message_id, user_id)
);

-- Çift dokunma ile beğeni (kalp).
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL DEFAULT '❤',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- Basılı tutarak mesaj şikayeti (site yönetimine gider).
CREATE TABLE IF NOT EXISTS message_reports (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  reporter_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (  key TEXT PRIMARY KEY,             -- unguessable UUID
  uploader_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,         -- pre-signed upload token
  mime TEXT,
  size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','attached')),
  thumb_key TEXT,                   -- sunucuda üretilen küçük resim anahtarı
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

/* -------------------------------------------------------------------------- */
/* Indexler                                                                   */
/* -------------------------------------------------------------------------- */
/*
 * Indexler ayrı tutulur: mevcut bir veritabanında CREATE TABLE IF NOT EXISTS
 * yeni kolonları eklemez. Indexler `posts.view_count` gibi yeni kolonlara
 * bağlandığı için, migrate() kolonları ekledikten SONRA oluşturulmalıdır;
 * aksi halde uygulama açılışta "no such column" hatasıyla çöker.
 */
export const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username_lower, created_at);
CREATE INDEX IF NOT EXISTS idx_rules_community ON community_rules(community_id, position);
CREATE INDEX IF NOT EXISTS idx_memberships_community ON memberships(community_id, status);
CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_url ON posts(community_id, url);
CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media(post_id, position);
CREATE INDEX IF NOT EXISTS idx_post_references_target ON post_references(target_post_id);
-- Yükleme sahipliği her gönderi/yorum oluşturulurken sorgulanır; indeks olmadan
-- uploads tablosunun tamamı taranır.
CREATE INDEX IF NOT EXISTS idx_uploads_uploader ON uploads(uploader_id, status);
-- Kısmi benzersiz index: numarası olan gönderiler topluluk içinde tekildir.
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_community_number
  ON posts(community_id, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flairs_community ON board_flairs(community_id, position);
CREATE INDEX IF NOT EXISTS idx_affinity_user ON community_affinity(user_id, affinity DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, path);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comment_media_comment ON comment_media(comment_id, position);
CREATE INDEX IF NOT EXISTS idx_comment_mentions_user ON comment_mentions(user_id);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_queue ON reports(community_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_mod_actions_community ON mod_actions(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_reports_message ON message_reports(message_id);
`
