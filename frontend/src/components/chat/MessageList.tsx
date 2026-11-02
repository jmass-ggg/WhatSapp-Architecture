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

import { MessageBubble, type BubbleConversation } from "./MessageBubble";
import type { Conversation, MatrixSession, Message } from "../../types";

interface MessageListProps {
  conversation: Conversation | null;
  matrixSession: MatrixSession | null;
  searchTerm: string;
  ownAvatar?: { name: string; avatarUrl?: string | null };
  starredEventIds?: ReadonlySet<string>;
  onToggleStar?: (eventId: string) => void;
  searchOpen: boolean;
  conversationRouteId?: string;
  onReply?: (message: Message) => void;
  onRetry?: (message: Message) => void;
  onMentionClick?: (userId: string) => void;
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
  ownAvatar,
  starredEventIds,
  onToggleStar,
  searchOpen,
  conversationRouteId,
  onReply,
  onRetry,
  onMentionClick,
  pinnedEventIds = EMPTY_PINNED_IDS,
  canManagePins = false,
  onTogglePin,
  onLoadMessage,
  onJumpError,
}: MessageListProps, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousLastMessageId = useRef<string | undefined>(undefined);
  const previousMessageCount = useRef(0);
  const [contextMessages, setContextMessages] = useState<Message[]>([]);
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);
  const term = searchTerm.trim().toLowerCase();
  const stickToBottom = useRef(true);
  const scrollFrame = useRef<number | null>(null);
  const lastBurstAt = useRef(0);
  const [unreadBelow, setUnreadBelow] = useState(0);
  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  /** At most one scroll per animation frame; instant during bursts or reduced motion. */
  const scrollToLatest = useCallback((force = false) => {
    if (searchOpen) return;
    if (!force && !stickToBottom.current) return;
    if (scrollFrame.current !== null) return;
    const run = () => {
      scrollFrame.current = null;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const burst = performance.now() - lastBurstAt.current < 400;
      if (typeof scroller.scrollTo === "function") {
        // "instant", not "auto": the list's stylesheet sets scroll-behavior: smooth, which "auto"
        // would defer to, animating every message of a burst instead of landing on it at once.
        scroller.scrollTo({
          top: scroller.scrollHeight,
          behavior: burst || reducedMotion() ? "instant" : "smooth",
        });
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
      stickToBottom.current = true;
      setUnreadBelow(0);
    };
    if (typeof requestAnimationFrame === "function") scrollFrame.current = requestAnimationFrame(run);
    else run();
  }, [searchOpen]);
  useEffect(() => () => {
    if (scrollFrame.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(scrollFrame.current);
    }
    // The cancelled frame never runs, so it must not keep the one-frame guard closed: React's
    // StrictMode unmounts and remounts effects in development, and a stale id here would make
    // every later scrollToLatest return early, leaving the list stuck at the top.
    scrollFrame.current = null;
  }, []);
  const handleScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    stickToBottom.current = near;
    if (near) setUnreadBelow(0);
  }, []);
  const messages = useMemo(() => {
    // Conversation messages stay in Matrix timeline order (never re-sorted by timestamp, which
    // would reorder acknowledged echoes); jumped-to context messages are merged in by time.
    const timeline = conversation?.messages ?? [];
    const known = new Set(timeline.map((message) => message.matrix?.eventId || message.id));
    const extra = contextMessages.filter(
      (message) => message.matrix?.roomId === conversation?.id && !known.has(message.matrix?.eventId || message.id),
    );
    const positioned = timeline.map((message, index) => ({ message, position: index }));
    for (const message of extra) {
      const time = message.sentAt?.getTime() ?? 0;
      const next = timeline.findIndex((candidate) => (candidate.sentAt?.getTime() ?? 0) > time);
      positioned.push({ message, position: (next === -1 ? timeline.length : next) - 0.5 });
    }
    return positioned
      .sort((left, right) => left.position - right.position)
      .map(({ message }) => message)
      .filter((message) => {
        if (message.matrix?.eventId === focusedEventId) return true;
        if (!term) return true;
        return (
          message.text.toLowerCase().includes(term) ||
          message.attachment?.name.toLowerCase().includes(term) ||
          message.replyTo?.text.toLowerCase().includes(term)
        );
      });
  }, [contextMessages, conversation?.messages, focusedEventId, term]);
  const groups = useMemo(() => groupByDay(messages), [messages]);
  // Bubbles only read these fields; a fresh Conversation object per sync must not re-render them.
  const bubbleConversation = useMemo<BubbleConversation | null>(
    () => conversation
      ? { isGroup: conversation.isGroup, name: conversation.name, initials: conversation.initials, accent: conversation.accent, avatarUrl: conversation.avatarUrl }
      : null,
    [conversation?.isGroup, conversation?.name, conversation?.initials, conversation?.accent, conversation?.avatarUrl],
  );

  useEffect(() => {
    previousLastMessageId.current = undefined;
    previousMessageCount.current = 0;
    setContextMessages((current) => (current.length ? [] : current));
    setPendingJumpId(null);
    setFocusedEventId(null);
    setUnreadBelow(0);
    stickToBottom.current = true;
    scrollToLatest(true);
  }, [conversation?.id, conversationRouteId]);

  useEffect(() => {
    const messages = conversation?.messages ?? [];
    const lastMessage = messages.at(-1);
    const lastMessageId = lastMessage?.id;
    const previousId = previousLastMessageId.current;
    if (lastMessageId && previousId && lastMessageId !== previousId) {
      lastBurstAt.current = performance.now();
      // Own sends always follow; others only when the reader is at the bottom.
      if (lastMessage?.sender === "me") scrollToLatest(true);
      else if (stickToBottom.current) scrollToLatest();
      else setUnreadBelow((count) => count + 1);
    } else if (lastMessageId && previousId && messages.length > previousMessageCount.current) {
      // Grew without a new last message: a confirmed incoming message landed above own echoes
      // that are still sending. Acknowledgments alone change neither the last id nor the count.
      lastBurstAt.current = performance.now();
      if (stickToBottom.current) scrollToLatest();
      else setUnreadBelow((count) => count + 1);
    }
    previousLastMessageId.current = lastMessageId;
    previousMessageCount.current = messages.length;
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

  // Read through refs so jumpTo (and the onJump handed to every memoised bubble) keeps one
  // identity even when the parent passes a fresh loader or error handler on a re-render.
  const jumpHandlersRef = useRef({ onLoadMessage, onJumpError });
  jumpHandlersRef.current = { onLoadMessage, onJumpError };
  const jumpTo = useCallback(async (eventId: string) => {
    const { onLoadMessage, onJumpError } = jumpHandlersRef.current;
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
  }, [scrollToEvent]);

  useImperativeHandle(
    ref,
    () => ({ jumpTo }),
    [jumpTo],
  );
  const handleJump = useCallback((eventId: string) => { void jumpTo(eventId); }, [jumpTo]);

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
      onScroll={handleScroll}
      onLoadCapture={(event) => {
        if (event.target instanceof HTMLImageElement || event.target instanceof HTMLMediaElement) scrollToLatest();
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
                conversation={bubbleConversation ?? conversation}
                matrixSession={matrixSession}
                ownAvatar={ownAvatar}
                isStarred={Boolean(message.matrix?.eventId && starredEventIds?.has(message.matrix.eventId))}
                onToggleStar={onToggleStar}
                onReply={onReply}
                onRetry={onRetry}
                onMentionClick={onMentionClick}
                isPinned={Boolean(message.matrix?.eventId && pinnedEventIds.has(message.matrix.eventId))}
                canManagePins={canManagePins}
                canPinNewMessage={pinnedEventIds.size < 3}
                onTogglePin={onTogglePin}
                onJump={handleJump}
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
      {unreadBelow > 0 && (
        <button type="button" className="new-messages-pill" onClick={() => scrollToLatest(true)}>
          {unreadBelow === 1 ? "New message" : `${unreadBelow} new messages`} ↓
        </button>
      )}
    </div>
  );
});
