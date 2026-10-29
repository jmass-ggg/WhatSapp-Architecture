import { Check, CheckCheck, Clock3 } from "lucide-react";

import { AttachmentCard } from "./AttachmentCard";
import type { Conversation, MatrixSession, Message } from "../../types";

interface MessageBubbleProps {
  message: Message;
  conversation: Conversation;
  matrixSession: MatrixSession | null;
  onReply?: (message: Message) => void;
  onJump?: (eventId: string) => void;
}

function formatMessageTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function Receipt({ delivery }: { delivery: Message["delivery"] }) {
  if (delivery === "sending") return <Clock3 size={13} aria-label="Sending" />;
  if (delivery === "failed") return <span className="message-failed">Not sent</span>;
  if (delivery === "cancelled") return <span className="message-failed">Cancelled</span>;
  return delivery === "read" ? (
    <CheckCheck size={14} className="receipt-read" aria-label="Read" />
  ) : delivery === "delivered" ? (
    <CheckCheck size={14} aria-label="Delivered" />
  ) : (
    <Check size={14} aria-label="Sent" />
  );
}

export function MessageBubble({
  message,
  conversation,
  matrixSession,
  onReply,
  onJump,
}: MessageBubbleProps) {
  const outgoing = message.sender === "me";
  return (
    <article
      className={`message-row${outgoing ? " is-outgoing" : ""}`}
      data-event-id={message.matrix?.eventId || undefined}
      data-room-id={message.matrix?.roomId || undefined}
      data-event-type={message.matrix?.eventType || undefined}
      data-sender-id={message.matrix?.senderId || undefined}
    >
      <div className="message-content-wrap">
        {!outgoing && conversation.isGroup && message.senderName && (
          <span className="message-sender">{message.senderName}</span>
        )}
        <div className={`message-bubble${message.attachment ? " has-attachment" : ""}`}>
          {message.replyTo && (
            <button type="button" className="reply-preview" onClick={() => message.replyTo?.eventId && onJump?.(message.replyTo.eventId)}>
              <strong>{message.replyTo.sender}</strong>
              <span>{message.replyTo.text}</span>
            </button>
          )}
          {message.attachment && (
            <AttachmentCard
              attachment={message.attachment}
              matrixToken={matrixSession?.access_token}
            />
          )}
          {message.text && <p className="message-text">{message.text}</p>}
          <span className="message-meta">
            <time dateTime={message.sentAt.toISOString()}>
              {formatMessageTime(message.sentAt)}
            </time>
            {outgoing && <Receipt delivery={message.delivery} />}
            {outgoing && message.delivery === "read" && message.readAt && (
              <time dateTime={message.readAt.toISOString()} aria-label={`Seen at ${formatMessageTime(message.readAt)}`}>
                Seen at {formatMessageTime(message.readAt)}
              </time>
            )}
          </span>
        </div>
        {onReply && message.matrix?.eventId.startsWith("$") && message.delivery !== "sending" && <button type="button" className="message-reply-action" onClick={() => onReply(message)}>Reply</button>}
        {message.reaction && (
          <button
            type="button"
            className="message-reaction"
            aria-label={`${message.reaction.count} reactions: ${message.reaction.emoji}`}
          >
            <span>{message.reaction.emoji}</span>
            <span>{message.reaction.count}</span>
          </button>
        )}
      </div>
    </article>
  );
}
