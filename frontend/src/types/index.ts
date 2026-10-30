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
  kind: "image" | "file";
  url?: string;
  mediaUri?: string;
  demoOnly?: boolean;
}

export interface Message {
  id: string;
  sender: "me" | "them";
  senderName?: string;
  text: string;
  sentAt?: Date;
  delivery: "sending" | "sent" | "delivered" | "read" | "failed" | "cancelled";
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
    encryptionStatus?: "decrypted" | "pending" | "failed";
  };
}

export interface Conversation {
  id: string;
  name: string;
  username?: string;
  matrixUserId?: string;
  initials: string;
  avatarUrl?: string | null;
  accent: number;
  isOnline?: boolean;
  isTyping?: boolean;
  typingNames?: string[];
  lastMessage: string;
  lastMessageDelivery?: Message["delivery"];
  updatedAt: Date;
  unreadCount: number;
  messages: Message[];
  bio?: string;
  isDemo?: boolean;
  isGroup?: boolean;
  isInvited?: boolean;
  isEncrypted?: boolean;
  roomId?: string;
  contactUserId?: string;
  connectionUserId?: string;
  connectionAllowed?: boolean;
}

export type AuthMode = "live" | "demo";
