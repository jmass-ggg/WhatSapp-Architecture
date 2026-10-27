import { useCallback, useEffect, useMemo, useRef } from "react";
import { MessageCircleMore } from "lucide-react";

import { MessageBubble } from "./MessageBubble";
import type { Conversation, MatrixSession, Message } from "../../types";

interface MessageListProps {
  conversation: Conversation | null;
  matrixSession: MatrixSession | null;
  searchTerm: string;
  searchOpen: boolean;
  conversationRouteId?: string;
}

function dayLabel(date: Date): string {
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

export function MessageList({
  conversation,
  matrixSession,
  searchTerm,
  searchOpen,
  conversationRouteId,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const term = searchTerm.trim().toLowerCase();
  const scrollToLatest = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || searchOpen) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [searchOpen]);
  const messages = useMemo(
    () =>
      conversation?.messages.filter((message) => {
        if (!term) return true;
        return (
          message.text.toLowerCase().includes(term) ||
          message.attachment?.name.toLowerCase().includes(term) ||
          message.replyTo?.text.toLowerCase().includes(term)
        );
      }) ?? [],
    [conversation?.messages, term],
  );
  const groups = useMemo(() => groupByDay(messages), [messages]);

  useEffect(() => {
    scrollToLatest();
  }, [
    conversation?.id,
    conversation?.messages.length,
    conversationRouteId,
    scrollToLatest,
  ]);

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
      className={`messages-scroll${conversation.isDemo ? " messages-demo" : ""}`}
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
      {conversation.isDemo && (
        <div className="demo-message-note">
          Sample messages · sent messages stay in this preview
        </div>
      )}
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
              />
            ))}
          </section>
        ))
      )}
      {conversation.isTyping && !term && (
        <div className="typing-row">
          <span className="typing-dots"><i /><i /><i /></span>
          <span>{conversation.name} is typing</span>
        </div>
      )}
    </div>
  );
}
