import { ChevronLeft, ChevronRight, Pin, X } from "lucide-react";

import type { Message } from "../../types";

export interface PinnedMessageSummary {
  eventId: string;
  sender: string;
  preview: string;
  sentAt?: Date;
  unavailable?: boolean;
}

interface PinnedMessageBannerProps {
  messages: PinnedMessageSummary[];
  activeIndex: number;
  onSelectIndex: (index: number) => void;
  onJump: (eventId: string) => void;
  canUnpin: boolean;
  onUnpin: (eventId: string) => void;
}

export function pinnedSummaryFromMessage(
  eventId: string,
  message: Message | null,
): PinnedMessageSummary {
  if (!message) {
    return {
      eventId,
      sender: "Original message",
      preview: "This pinned message is unavailable.",
      unavailable: true,
    };
  }
  return {
    eventId,
    sender: message.senderName || (message.sender === "me" ? "You" : "A participant"),
    preview: message.text || message.attachment?.name || "Attachment",
    sentAt: message.sentAt,
  };
}

function formatTime(date?: Date): string {
  if (!date || !Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatFullTime(date?: Date): string | undefined {
  if (!date || !Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

export function PinnedMessageBanner({
  messages,
  activeIndex,
  onSelectIndex,
  onJump,
  canUnpin,
  onUnpin,
}: PinnedMessageBannerProps) {
  if (messages.length === 0) return null;
  const safeIndex = Math.min(Math.max(activeIndex, 0), messages.length - 1);
  const message = messages[safeIndex];
  const fullTime = formatFullTime(message.sentAt);

  return (
    <aside className="pinned-message-banner" aria-label="Pinned messages">
      <Pin className="pinned-message-icon" size={17} aria-hidden="true" />
      <button
        type="button"
        className="pinned-message-content"
        onClick={() => onJump(message.eventId)}
        aria-label={`Jump to pinned message from ${message.sender}`}
      >
        <span className="pinned-message-heading">
          <strong>{message.sender}</strong>
          <span aria-hidden="true">·</span>
          <time
            dateTime={message.sentAt && Number.isFinite(message.sentAt.getTime())
              ? message.sentAt.toISOString()
              : undefined}
            title={fullTime}
          >
            {formatTime(message.sentAt)}
          </time>
          {messages.length > 1 && (
            <span className="pinned-message-count">{safeIndex + 1}/{messages.length}</span>
          )}
        </span>
        <span className={message.unavailable ? "pinned-message-preview is-unavailable" : "pinned-message-preview"}>
          {message.preview}
        </span>
      </button>
      {messages.length > 1 && (
        <div className="pinned-message-navigation" aria-label="Pinned message navigation">
          <button
            type="button"
            className="pinned-message-nav-button"
            aria-label="Previous pinned message"
            onClick={() => onSelectIndex((safeIndex - 1 + messages.length) % messages.length)}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            type="button"
            className="pinned-message-nav-button"
            aria-label="Next pinned message"
            onClick={() => onSelectIndex((safeIndex + 1) % messages.length)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      )}
      {canUnpin && (
        <button
          type="button"
          className="pinned-message-unpin"
          aria-label={`Unpin message from ${message.sender}`}
          title="Unpin message"
          onClick={() => onUnpin(message.eventId)}
        >
          <X size={17} />
        </button>
      )}
    </aside>
  );
}
