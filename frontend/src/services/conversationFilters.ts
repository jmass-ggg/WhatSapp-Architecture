import type { Conversation } from "../types";

export type ChatFilter = "all" | "unread" | "favorites" | "groups";

export interface ConversationGroups {
  pinned: Conversation[];
  recent: Conversation[];
}

export function matchesQuery(conversation: Conversation, query: string): boolean {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  return (
    conversation.name.toLowerCase().includes(value) ||
    Boolean(conversation.username?.toLowerCase().includes(value)) ||
    conversation.lastMessage.toLowerCase().includes(value)
  );
}

export function matchesFilter(
  conversation: Conversation,
  filter: ChatFilter,
  favoriteIds: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case "unread":
      return conversation.unreadCount > 0;
    case "favorites":
      return favoriteIds.has(conversation.id);
    case "groups":
      return Boolean(conversation.isGroup);
    default:
      return true;
  }
}

/** Number of conversations (not messages) that have unread notifications. */
export function countUnreadConversations(conversations: Conversation[]): number {
  return conversations.filter((conversation) => conversation.unreadCount > 0).length;
}

/** Applies filter + search, then splits into pinned/recent while preserving last-activity order. */
export function groupConversations(
  conversations: Conversation[],
  options: {
    filter: ChatFilter;
    query: string;
    favoriteIds: ReadonlySet<string>;
    pinnedIds: ReadonlySet<string>;
  },
): ConversationGroups {
  const visible = conversations.filter(
    (conversation) =>
      matchesFilter(conversation, options.filter, options.favoriteIds) &&
      matchesQuery(conversation, options.query),
  );
  return {
    pinned: visible.filter((conversation) => options.pinnedIds.has(conversation.id)),
    recent: visible.filter((conversation) => !options.pinnedIds.has(conversation.id)),
  };
}
