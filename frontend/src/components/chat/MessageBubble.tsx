import { Check, CheckCheck, Clock3, MoreHorizontal, Pin, PinOff, Reply } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { AttachmentCard } from "./AttachmentCard";
import type { Conversation, MatrixSession, Message } from "../../types";

interface MessageBubbleProps {
  message: Message;
  conversation: Conversation;
  matrixSession: MatrixSession | null;
  onReply?: (message: Message) => void;
  onJump?: (eventId: string) => void;
  isPinned?: boolean;
  canManagePins?: boolean;
  canPinNewMessage?: boolean;
  onTogglePin?: (eventId: string) => void;
}

function formatMessageTime(date?: Date): string {
  if (!date || !Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatFullMessageTime(date?: Date): string | undefined {
  if (!date || !Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

function Receipt({ delivery }: { delivery: Message["delivery"] }) {
  if (delivery === "sending") return <Clock3 size={13} aria-label="Sending" />;
  if (delivery === "failed") return <span className="message-failed">Not sent</span>;
  if (delivery === "cancelled") return <span className="message-failed">Cancelled</span>;
  return delivery === "read" ? (
    <CheckCheck size={14} className="receipt-read" aria-label="Read" />
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
  isPinned = false,
  canManagePins = false,
  canPinNewMessage = true,
  onTogglePin,
}: MessageBubbleProps) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const outgoing = message.sender === "me";
  const eventId = message.matrix?.eventId;
  const hasPersistedEventId = Boolean(eventId && !eventId.startsWith("~"));
  const canChangePins = Boolean(canManagePins && onTogglePin && hasPersistedEventId);
  const fullTimestamp = formatFullMessageTime(message.sentAt);
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setActionsOpen(false);
      actionTriggerRef.current?.focus();
      return;
    }
    const items = [...(actionMenuRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ) ?? [])];
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1].focus();
      return;
    }
    const offset = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!offset) return;
    event.preventDefault();
    items[(currentIndex + offset + items.length) % items.length].focus();
  };

  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    const onScroll = () => setActionsOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [actionsOpen]);

  useLayoutEffect(() => {
    if (!actionsOpen) {
      setMenuPosition(null);
      return;
    }
    const trigger = actionTriggerRef.current;
    const menu = actionMenuRef.current;
    if (!trigger || !menu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const desiredTop = triggerRect.bottom + gap + menuRect.height <= window.innerHeight - margin
      ? triggerRect.bottom + gap
      : triggerRect.top - menuRect.height - gap;
    setMenuPosition({
      left: Math.min(
        Math.max(margin, triggerRect.right - menuRect.width),
        Math.max(margin, window.innerWidth - menuRect.width - margin),
      ),
      top: Math.min(
        Math.max(margin, desiredTop),
        Math.max(margin, window.innerHeight - menuRect.height - margin),
      ),
    });
  }, [actionsOpen]);

  const delivery =
    conversation.isGroup &&
    message.delivery === "read"
      ? "sent"
      : message.delivery;

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
            <button
              type="button"
              className="reply-preview"
              onClick={() => message.replyTo?.eventId && onJump?.(message.replyTo.eventId)}
              disabled={!message.replyTo.eventId}
              title={message.replyTo.eventId ? "Jump to original message" : undefined}
            >
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
            {isPinned && (
              <span className="message-pin-indicator" title="Pinned message">
                <Pin size={12} aria-label="Pinned message" />
              </span>
            )}
            <time
              dateTime={message.sentAt && Number.isFinite(message.sentAt.getTime())
                ? message.sentAt.toISOString()
                : undefined}
              title={fullTimestamp}
            >
              {formatMessageTime(message.sentAt)}
            </time>
            {outgoing && <Receipt delivery={delivery} />}
            {outgoing && !conversation.isGroup && message.delivery === "read" && message.readAt && (
              <time dateTime={message.readAt.toISOString()} aria-label={`Seen at ${formatMessageTime(message.readAt)}`}>
                Seen at {formatMessageTime(message.readAt)}
              </time>
            )}
          </span>
        </div>
        {hasPersistedEventId && message.delivery !== "sending" &&
          (onReply || canChangePins) && (
            <div className="message-actions" ref={actionsRef}>
              <button
                ref={actionTriggerRef}
                type="button"
                className="message-actions-trigger"
                aria-label="Message actions"
                aria-haspopup="menu"
                aria-expanded={actionsOpen}
                title="Message actions"
                onClick={() => {
                  setMenuPosition(null);
                  setActionsOpen((open) => !open);
                }}
              >
                <MoreHorizontal size={17} />
              </button>
              {actionsOpen && (
                <div
                  ref={actionMenuRef}
                  className="message-actions-menu"
                  role="menu"
                  aria-label="Message actions"
                  onKeyDown={handleMenuKeyDown}
                  style={{
                    left: menuPosition?.left ?? 0,
                    top: menuPosition?.top ?? 0,
                    visibility: menuPosition ? "visible" : "hidden",
                  }}
                >
                  {onReply && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setActionsOpen(false);
                        actionTriggerRef.current?.focus();
                        onReply(message);
                      }}
                    >
                      <Reply size={15} />
                      <span>Reply</span>
                    </button>
                  )}
                  {canChangePins && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!isPinned && !canPinNewMessage}
                      title={!isPinned && !canPinNewMessage
                        ? "A conversation can have up to three pinned messages"
                        : undefined}
                      onClick={() => {
                        setActionsOpen(false);
                        actionTriggerRef.current?.focus();
                        if (eventId) onTogglePin?.(eventId);
                      }}
                    >
                      {isPinned ? <PinOff size={15} /> : <Pin size={15} />}
                      <span>{isPinned ? "Unpin message" : "Pin message"}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
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
