import { CheckCheck, Check, Clock3, Pin, Star, UsersRound } from "lucide-react";
import { memo } from "react";

import { UserAvatar } from "../UserAvatar";
import type { Conversation } from "../../types";

interface ConversationListItemProps {
  conversation: Conversation;
  selected: boolean;
  matrixToken?: string | null;
  isFavorite?: boolean;
  isPinned?: boolean;
  onSelect: (conversation: Conversation) => void;
}

export function formatActivity(date: Date, now: Date = new Date()): string {
  if (date.getTime() < 1) return "";
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

/** Memoised so an update in one room does not re-render every row in the sidebar. */
export const ConversationListItem = memo(function ConversationListItem({
  conversation,
  selected,
  matrixToken,
  isFavorite = false,
  isPinned = false,
  onSelect,
}: ConversationListItemProps) {
  const lastMessage = conversation.isTyping
    ? "typing…"
    : conversation.lastMessage;
  const isOwnPreview = lastMessage.startsWith("You:");
  const messageText = isOwnPreview ? lastMessage.slice(4).trim() : lastMessage;

  return (
    <button
      className={`conversation-row${selected ? " is-selected" : ""}`}
      type="button"
      onClick={() => onSelect(conversation)}
      aria-current={selected ? "page" : undefined}
    >
      <UserAvatar
        name={conversation.name}
        initials={conversation.initials}
        accent={conversation.accent}
        size="md"
        avatarUrl={conversation.avatarUrl}
        matrixToken={matrixToken}
        presence={conversation.presence}
      />
      <span className="conversation-row-body">
        <span className="conversation-row-top">
          <span className="conversation-title">
            {conversation.isGroup && (
              <span
                className="conversation-group-indicator"
                role="img"
                aria-label="Group conversation"
                title="Group"
              >
                <UsersRound size={13} aria-hidden="true" />
              </span>
            )}
            <span className="conversation-name">{conversation.name}</span>
            {conversation.isInvited && (
              <span className="conversation-invite-badge">Invited</span>
            )}
          </span>
          <span className="conversation-time">{formatActivity(conversation.updatedAt)}</span>
        </span>
        <span className="conversation-row-bottom">
          <span className={`conversation-preview${conversation.isTyping ? " typing" : ""}`}>
            {isOwnPreview &&
              (conversation.isGroup ? (
                conversation.lastMessageDelivery === "sent" ? (
                  <Check size={14} className="preview-check" aria-label="Sent" />
                ) : conversation.lastMessageDelivery === "sending" ? (
                  <Clock3 size={12} aria-label="Sending" />
                ) : null
              ) : (
                <CheckCheck size={14} className="preview-check" aria-label="Sent" />
              ))}
            {conversation.isTyping && <Clock3 size={12} aria-hidden="true" />}
            {messageText}
          </span>
          {conversation.unreadCount > 0 && (
            <span className="unread-badge" aria-label={`${conversation.unreadCount} unread messages`}>
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </span>
          )}
          {conversation.unreadCount === 0 && isPinned && (
            <Pin size={15} className="conversation-flag" aria-label="Pinned" />
          )}
          {conversation.unreadCount === 0 && !isPinned && isFavorite && (
            <Star size={15} className="conversation-flag is-favorite" fill="currentColor" aria-label="Favorite" />
          )}
          {conversation.unreadCount === 0 &&
            !isPinned && !isFavorite &&
            !conversation.isGroup &&
            conversation.lastMessage.startsWith("You:") && (
            <Check size={13} className="preview-check" aria-label="Sent" />
          )}
        </span>
      </span>
    </button>
  );
});
