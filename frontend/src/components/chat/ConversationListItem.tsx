import { CheckCheck, Check, Clock3 } from "lucide-react";

import { UserAvatar } from "../UserAvatar";
import type { Conversation } from "../../types";

interface ConversationListItemProps {
  conversation: Conversation;
  selected: boolean;
  matrixToken?: string | null;
  onSelect: () => void;
}

function formatActivity(date: Date): string {
  if (date.getTime() < 1) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  if (hours < 48) return "yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function ConversationListItem({
  conversation,
  selected,
  matrixToken,
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
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
    >
      <UserAvatar
        name={conversation.name}
        initials={conversation.initials}
        accent={conversation.accent}
        size="md"
        avatarUrl={conversation.avatarUrl}
        matrixToken={matrixToken}
        online={conversation.isOnline}
      />
      <span className="conversation-row-body">
        <span className="conversation-row-top">
          <span className="conversation-name">{conversation.name}</span>
          <span className="conversation-time">{formatActivity(conversation.updatedAt)}</span>
        </span>
        <span className="conversation-row-bottom">
          <span className={`conversation-preview${conversation.isTyping ? " typing" : ""}`}>
            {isOwnPreview && <CheckCheck size={14} className="preview-check" aria-label="Sent" />}
            {conversation.isTyping && <Clock3 size={12} aria-hidden="true" />}
            {messageText}
          </span>
          {conversation.unreadCount > 0 && (
            <span className="unread-badge" aria-label={`${conversation.unreadCount} unread messages`}>
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </span>
          )}
          {conversation.unreadCount === 0 && conversation.lastMessage.startsWith("You:") && (
            <Check size={13} className="preview-check" aria-label="Sent" />
          )}
        </span>
      </span>
    </button>
  );
}
