export interface UserRow {
  id: string
  username: string
  username_lower: string
  email_lower: string | null
  password_hash: string
  display_name: string | null
  bio: string | null
  avatar_key: string | null
  cover_key: string | null
  /** Kullanıcı gönderilerini anonim paylaşmak istiyor. */
  anon_by_default: number
  rank_mode: 'auto' | 'manual'
  rank_override: string | null
  staff_role: string
  is_admin: number
  /** AI/NPC karakteri mi? 0 = gerçek kullanıcı. */
  is_ai: number
  deleted: number
  suspended_until: number | null
  suspended_indefinitely: number
  suspension_reason: string | null
  created_at: number
}

export interface CommunityRow {
  id: string
  name: string
  title: string
  description: string
  visibility: 'public' | 'restricted' | 'private'
  archived: number
  deleted_at: number | null
  auto_hide_reports: number
  hide_comment_scores_minutes: number
  creator_id: string
  created_at: number
}

export interface CommunityRuleRow {
  id: string
  community_id: string
  position: number
  title: string
  detail: string | null
}

export interface MembershipRow {
  user_id: string
  community_id: string
  role: 'member' | 'moderator'
  status: 'pending' | 'approved' | 'rejected'
  mod_since: number | null
  created_at: number
}

export interface BanRow {
  community_id: string
  user_id: string
  expires_at: number | null
  reason: string | null
  created_by: string
  created_at: number
}

/** Gönderi önizlemesinin nasıl gösterileceği. */
export type MediaKind = 'none' | 'image' | 'gif' | 'video' | 'embed'

/** Bir gönderiye eklenebilen dosya türü. */
export type UploadKind = 'image' | 'gif' | 'video'

export interface PostMediaRow {
  id: string
  post_id: string
  position: number
  media_key: string
  mime: string | null
  kind: UploadKind
  created_at: number
}

export interface FlairRow {
  id: string
  community_id: string
  name: string
  color: string
  position: number
  created_at: number
}

export interface PostRow {
  id: string
  community_id: string
  author_id: string
  type: 'text' | 'link' | 'image'
  /** Topluluk içinde 1'den başlayan post numarası (>>12345 referansları için). */
  number: number | null
  title: string
  body: string | null
  url: string | null
  link_preview_title: string | null
  link_preview_image: string | null
  image_key: string | null
  media_kind: MediaKind
  spoiler: number
  flair_id: string | null
  score: number
  upvotes: number
  downvotes: number
  comment_count: number
  pinned_at: number | null
  removed: number
  auto_hidden: number
  deleted: number
  edited_at: number | null
  created_at: number
  // Anonim paylaşım
  is_anonymous: number
  anon_name: string | null
  // İstatistik
  view_count: number
}

export interface CommentRow {
  id: string
  post_id: string
  parent_id: string | null
  path: string
  depth: number
  author_id: string
  body: string
  score: number
  upvotes: number
  downvotes: number
  removed: number
  auto_hidden: number
  deleted: number
  edited_at: number | null
  created_at: number
  /** 1 = yorum "Göster"e kadar gizli. */
  spoiler: number
  /** Anonim yorum paylaşımı. */
  is_anonymous: number
  anon_name: string | null
}

export interface ReportRow {
  id: string
  target_type: 'post' | 'comment'
  target_id: string
  community_id: string
  reporter_id: string
  reason_type: 'rule' | 'spam' | 'harassment' | 'other'
  rule_id: string | null
  detail: string | null
  status: 'open' | 'resolved'
  resolved_by: string | null
  resolved_at: number | null
  created_at: number
}

export interface ModActionRow {
  id: string
  community_id: string | null
  actor_id: string
  action: string
  target_type: string | null
  target_id: string | null
  reason: string | null
  detail: string | null
  created_at: number
}

export interface NotificationRow {
  id: string
  user_id: string
  actor_id: string | null
  type: 'reply' | 'mention' | 'mod_removal' | 'mod_ban' | 'membership'
  actor_hidden: number
  title: string
  link: string
  source_comment_id: string | null
  read: number
  withdrawn: number
  created_at: number
}

/** Özel mesajlaşma (DM) satırları. */
export interface ConversationRow {
  id: string
  created_at: number
}

export interface ConversationMemberRow {
  conversation_id: string
  user_id: string
  last_read_at: number
  archived: number
  hidden: number
  accepted: number
}

export interface MessageRow {
  id: string
  conversation_id: string
  sender_id: string
  body: string
  reply_to_id: string | null
  created_at: number
  deleted_for_everyone: number
}

export interface UploadRow {
  key: string
  uploader_id: string
  token_hash: string
  mime: string | null
  size: number | null
  status: 'pending' | 'uploaded' | 'attached'
  /** Sunucuda üretilen küçük resmin anahtarı (yoksa null). */
  thumb_key: string | null
  created_at: number
}

export type Viewer = UserRow | null

// ===========================================================================
// AI karakterler (NPC)
// ===========================================================================

/** `ai_agents` tablosunun satır tipi. Ölçekler 0.0–1.0 REAL olarak tutulur. */
export interface AiAgentRow {
  user_id: string
  archetype: string
  bio: string
  verbosity: number
  humor: number
  assertiveness: number
  politeness: number
  activity: number
  profanity: number
  emoji_rate: number
  upvote_bias: number
  downvote_bias: number
  comment_rate: number
  post_rate: number
  // NPC v2.2 kişilik eksenleri (hepsi 0..1)
  curiosity: number
  seriousness: number
  talkativeness: number
  patience: number
  empathy: number
  skepticism: number
  confidence: number
  slang_rate: number
  vote_rate: number
  interests: string
  likes: string
  dislikes: string
  board_prefs: string
  peers: string
  enabled: number
  posts_created: number
  comments_created: number
  votes_cast: number
  reputation: number
  last_active_at: number | null
  created_at: number
  updated_at: number
}

/** Karakter + kullanıcı satırı birlikte (yönetim listesi için). */
export interface AiAgentWithUser extends AiAgentRow {
  username: string
  display_name: string | null
  avatar_key: string | null
  suspended_indefinitely: number
  deleted: number
}

/** `ai_relationships` satırı. affinity: -1 (düşman) .. +1 (dost). */
export interface AiRelationshipRow {
  agent_id: string
  peer_id: string
  affinity: number
  interactions: number
  last_interaction_at: number | null
}

/** `npc_relationships` satırı — beş eksenli ilişki. */
export interface NpcRelationshipRow {
  agent_id: string
  peer_id: string
  friendship: number
  respect: number
  trust: number
  dislike: number
  rivalry: number
  affinity: number
  interactions: number
  last_interaction_at: number | null
}

/** `npc_memory` satırı — özet hafıza. */
export interface NpcMemoryRow {
  id: string
  agent_id: string
  kind: 'concept' | 'person' | 'board' | 'phrase' | 'fact'
  key: string
  weight: number
  hits: number
  positive: number
  negative: number
  last_seen_at: number
  created_at: number
}

/** `npc_behavior` satırı — öğrenilmiş davranış politikası. */
export interface NpcBehaviorRow {
  agent_id: string
  topic: string
  humor_w: number
  length_w: number
  engage_w: number
  post_w: number
  trials: number
  reward: number
  updated_at: number
}

/** `npc_episodes` satırı — önemli konuşma özeti. */
export interface NpcEpisodeRow {
  id: string
  agent_id: string
  concept_id: string
  post_id: string | null
  comment_id: string | null
  peer_id: string | null
  summary: string
  sentiment: string
  score: number
  reward: number
  created_at: number
}

/** `ai_activity_log` satırı (append-only denetim izi). */
export interface AiActivityRow {
  id: string
  agent_id: string
  action: string
  target_type: string | null
  target_id: string | null
  community_id: string | null
  detail: string | null
  created_at: number
}
