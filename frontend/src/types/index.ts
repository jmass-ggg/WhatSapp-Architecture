export interface UserProfile {
  id: string;
  email: string;
  username: string;
  is_active: boolean;
  is_email_verified: boolean;
  role: string;
  created_at: string;
  updated_at: string;
  profile: {
    user_id: string;
    display_name: string;
    profile_picture_url: string | null;
    bio: string | null;
    job_title: string | null;
    department: string | null;
  };
}

export interface MatrixSession {
  access_token: string;
  user_id: string;
  device_id: string;
  home_server: string | null;
  expires_in_ms: number | null;
}

export interface LoginResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  matrix: MatrixSession;
}

export interface AccessTokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
}

export interface DirectoryUser {
  id: string;
  username: string;
  profile: UserProfile["profile"] | null;
}

export interface DirectoryPage {
  items: DirectoryUser[];
  limit: number;
  offset: number;
  total: number;
}

export interface ConnectionUser {
  id: string;
  username: string;
  profile: UserProfile["profile"] | null;
}

export type ConnectionStatus = "pending" | "accepted" | "declined" | "blocked";

export interface UserConnection {
  id: string;
  requester_id: string;
  recipient_id: string;
  status: ConnectionStatus;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  other_user: ConnectionUser;
}

export interface Attachment {
  name: string;
  size?: number;
  mimeType?: string;
  kind: "image" | "file" | "audio";
  /** Audio duration in milliseconds, when the sender provided it. */
  durationMs?: number;
  url?: string;
  mediaUri?: string;
}

export interface Message {
  id: string;
  sender: "me" | "them";
  senderName?: string;
  text: string;
  /** Mention-aware rendering of `text`; present only when the event carries confirmed mentions. */
  segments?: { text: string; userId?: string }[];
  /** True when the event's m.mentions lists the current user. */
  mentionsMe?: boolean;
  sentAt?: Date;
  delivery: "sending" | "sent" | "read" | "failed" | "cancelled";
  readAt?: Date;
  attachment?: Attachment;
  replyTo?: {
    eventId?: string;
    sender: string;
    text: string;
  };
  reaction?: {
    emoji: string;
    count: number;
  };
  matrix?: {
    eventId: string;
    roomId: string;
    eventType: string;
    senderId: string;
  };
}

export type PresenceState = "online" | "unavailable" | "offline" | "unknown";

export interface Conversation {
  id: string;
  name: string;
  username?: string;
  matrixUserId?: string;
  initials: string;
  avatarUrl?: string | null;
  accent: number;
  /** Matrix presence of the other person; undefined for groups. */
  presence?: PresenceState;
  isTyping?: boolean;
  typingNames?: string[];
  lastMessage: string;
  lastMessageDelivery?: Message["delivery"];
  updatedAt: Date;
  unreadCount: number;
  messages: Message[];
  bio?: string;
  /** Profile fields of a direct-message contact (from the connections API). */
  jobTitle?: string;
  department?: string;
  about?: string;
  isGroup?: boolean;
  isInvited?: boolean;
  roomId?: string;
  contactUserId?: string;
  connectionUserId?: string;
  connectionAllowed?: boolean;
}

export type AuthMode = "live";

export type ChannelCategory =
  | "general"
  | "announcements"
  | "engineering"
  | "technology"
  | "finance"
  | "gaming"
  | "education"
  | "hr"
  | "product";

/** owner = creator (full control), admin = publishes and moderates, member = reads and reacts. */
export type ChannelMemberRole = "owner" | "admin" | "member";
export type ChannelMemberStatus = "invited" | "joined" | "left" | "removed";

export interface ChannelMembership {
  role: ChannelMemberRole;
  status: ChannelMemberStatus;
  joined_at: string | null;
}

/** A community (broadcast channel) as registered by the backend, the only source of trusted rooms. */
export interface Channel {
  id: string;
  matrix_room_id: string | null;
  name: string;
  description: string;
  avatar_url: string | null;
  category: ChannelCategory;
  creator_id: string | null;
  is_verified: boolean;
  status: "provisioning" | "active" | "archived";
  created_at: string;
  updated_at: string;
  /** Members whose Matrix membership is joined, from the backend's reconciled records. */
  member_count: number;
  membership: ChannelMembership | null;
  /** Moderation rights (owner, admin or application admin). */
  can_manage: boolean;
  /** Owner-level rights: edit, assign admins, archive. */
  can_edit: boolean;
  can_publish: boolean;
}

export interface ChannelMember {
  user: { id: string; username: string; profile: UserProfile["profile"] | null };
  matrix_user_id: string;
  role: ChannelMemberRole;
  status: ChannelMemberStatus;
  joined_at: string | null;
}

export interface ChannelCreateInput {
  name: string;
  description: string;
  category: ChannelCategory;
  avatar_url?: string | null;
  /** Idempotency key: a retry with the same key returns the same community. */
  request_id?: string;
}

export interface ChannelUpdateInput {
  name?: string;
  description?: string;
  category?: ChannelCategory;
  avatar_url?: string | null;
}

export interface AnnouncementReaction {
  key: string;
  count: number;
  /** The current user reacted with this key; `myEventId` is their reaction event. */
  mine: boolean;
  myEventId?: string;
}

/** One channel announcement: a message with an optional title and aggregated reactions. */
export interface Announcement extends Message {
  title?: string;
  reactions: AnnouncementReaction[];
}
