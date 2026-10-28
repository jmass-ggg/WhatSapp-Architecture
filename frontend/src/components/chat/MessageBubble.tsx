import { Check, CheckCheck, Clock3 } from "lucide-react";

import { AttachmentCard } from "./AttachmentCard";
import type { Conversation, MatrixSession, Message } from "../../types";

interface MessageBubbleProps {
  message: Message;
  conversation: Conversation;
  matrixSession: MatrixSession | null;
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
            <div className="reply-preview">
              <strong>{message.replyTo.sender}</strong>
              <span>{message.replyTo.text}</span>
            </div>
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
          </span>
        </div>
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
