import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { MessageCircleMore } from "lucide-react";

import { MessageBubble } from "./MessageBubble";
import type { Conversation, MatrixSession, Message } from "../../types";

interface MessageListProps {
  conversation: Conversation | null;
  matrixSession: MatrixSession | null;
  searchTerm: string;
  searchOpen: boolean;
  conversationRouteId?: string;
  onReply?: (message: Message) => void;
  pinnedEventIds?: ReadonlySet<string>;
  canManagePins?: boolean;
  onTogglePin?: (eventId: string) => void;
  onLoadMessage?: (eventId: string) => Promise<Message>;
  onJumpError?: (message: string) => void;
}

export interface MessageListHandle {
  jumpTo(eventId: string): Promise<void>;
}

const EMPTY_PINNED_IDS = new Set<string>();

function dayLabel(date?: Date): string {
  if (!date || !Number.isFinite(date.getTime())) return "Date unavailable";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function groupByDay(messages: Message[]) {
  const groups: { label: string; messages: Message[] }[] = [];
  for (const message of messages) {
    const label = dayLabel(message.sentAt);
    const group = groups.at(-1);
    if (group?.label === label) group.messages.push(message);
    else groups.push({ label, messages: [message] });
  }
  return groups;
}

function groupTypingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length > 2) {
    const additional = names.length - 2;
    return `${names[0]}, ${names[1]} and ${additional} ${
      additional === 1 ? "other" : "others"
    } are typing…`;
  }
  return "Someone is typing…";
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList({
  conversation,
  matrixSession,
  searchTerm,
  searchOpen,
  conversationRouteId,
  onReply,
  pinnedEventIds = EMPTY_PINNED_IDS,
  canManagePins = false,
  onTogglePin,
  onLoadMessage,
  onJumpError,
}: MessageListProps, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousLastMessageId = useRef<string | undefined>(undefined);
  const [contextMessages, setContextMessages] = useState<Message[]>([]);
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);
  const term = searchTerm.trim().toLowerCase();
  const scrollToLatest = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || searchOpen) return;
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [searchOpen]);
  const messages = useMemo(() => {
    const combined = new Map<string, Message>();
    const currentContextMessages = contextMessages.filter(
      (message) => message.matrix?.roomId === conversation?.id,
    );
    for (const message of [...(conversation?.messages ?? []), ...currentContextMessages]) {
      combined.set(message.matrix?.eventId || message.id, message);
    }
    return [...combined.values()]
      .filter((message) => {
        if (message.matrix?.eventId === focusedEventId) return true;
        if (!term) return true;
        return (
          message.text.toLowerCase().includes(term) ||
          message.attachment?.name.toLowerCase().includes(term) ||
          message.replyTo?.text.toLowerCase().includes(term)
        );
      })
      .sort((left, right) => (left.sentAt?.getTime() ?? 0) - (right.sentAt?.getTime() ?? 0));
  }, [contextMessages, conversation?.messages, focusedEventId, term]);
  const groups = useMemo(() => groupByDay(messages), [messages]);

  useEffect(() => {
    previousLastMessageId.current = undefined;
    setContextMessages([]);
    setPendingJumpId(null);
    setFocusedEventId(null);
    scrollToLatest();
  }, [conversation?.id, conversationRouteId]);

  useEffect(() => {
    const lastMessageId = conversation?.messages.at(-1)?.id;
    if (lastMessageId && previousLastMessageId.current &&
      lastMessageId !== previousLastMessageId.current) {
      scrollToLatest();
    }
    previousLastMessageId.current = lastMessageId;
  }, [conversation?.messages, scrollToLatest]);

  const scrollToEvent = useCallback((eventId: string) => {
    const scroller = scrollRef.current;
    const target = [...(scroller?.querySelectorAll<HTMLElement>("[data-event-id]") ?? [])]
      .find((element) => element.dataset.eventId === eventId);
    if (!target) return false;
    target.scrollIntoView?.({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    target.classList.remove("message-jump-highlight");
    void target.offsetWidth;
    target.classList.add("message-jump-highlight");
    window.setTimeout(() => target.classList.remove("message-jump-highlight"), 1800);
    return true;
  }, []);

  const jumpTo = useCallback(async (eventId: string) => {
    setFocusedEventId(eventId);
    if (scrollToEvent(eventId)) return;
    if (!onLoadMessage) {
      onJumpError?.("That message is not available in the loaded conversation.");
      return;
    }
    try {
      const message = await onLoadMessage(eventId);
      if (message.matrix?.eventId !== eventId) {
        throw new Error("Matrix could not find that exact message.");
      }
      setContextMessages((current) => [
        ...current.filter((item) => item.matrix?.eventId !== eventId),
        message,
      ]);
      setPendingJumpId(eventId);
    } catch (error) {
      onJumpError?.(error instanceof Error
        ? error.message
        : "That message could not be loaded.");
    }
  }, [onJumpError, onLoadMessage, scrollToEvent]);

  useImperativeHandle(
    ref,
    () => ({ jumpTo }),
    [jumpTo],
  );

  useEffect(() => {
    if (!pendingJumpId || !scrollToEvent(pendingJumpId)) return;
    setPendingJumpId(null);
  }, [messages, pendingJumpId, scrollToEvent]);

  if (!conversation) {
    return (
      <div className="empty-chat">
        <span className="empty-chat-icon"><MessageCircleMore size={28} /></span>
        <h2>Your conversations live here</h2>
        <p>Choose a conversation or start a new one to say hello.</p>
      </div>
    );
  }

  return (
    <div
      className="messages-scroll"
      aria-label={`Messages with ${conversation.name}`}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      key={conversation.id}
      ref={scrollRef}
      onLoadCapture={(event) => {
        if (event.target instanceof HTMLImageElement) scrollToLatest();
      }}
    >
      {searchOpen && term && (
        <div className="search-result-note" role="status">
          {messages.length} {messages.length === 1 ? "message" : "messages"} found in loaded history
        </div>
      )}
      {messages.length === 0 ? (
        <div className="messages-empty">
          {term ? "No loaded messages match your search." : "No messages yet. Send a hello."}
        </div>
      ) : (
        groups.map((group) => (
          <section className="message-day" key={group.label} aria-label={group.label}>
            <div className="date-separator"><span>{group.label}</span></div>
            {group.messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                conversation={conversation}
                matrixSession={matrixSession}
                onReply={onReply}
                isPinned={Boolean(message.matrix?.eventId && pinnedEventIds.has(message.matrix.eventId))}
                canManagePins={canManagePins}
                canPinNewMessage={pinnedEventIds.size < 3}
                onTogglePin={onTogglePin}
                onJump={(eventId) => void jumpTo(eventId)}
              />
            ))}
          </section>
        ))
      )}
      {conversation.isTyping && !term && (
        <div className="typing-row">
          <span className="typing-dots"><i /><i /><i /></span>
          <span>
            {conversation.isGroup
              ? groupTypingLabel(conversation.typingNames ?? [])
              : `${conversation.name} is typing…`}
          </span>
        </div>
      )}
    </div>
  );
});
