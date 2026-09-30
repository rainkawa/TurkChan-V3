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
  created_at: number
}

export type Viewer = UserRow | null
