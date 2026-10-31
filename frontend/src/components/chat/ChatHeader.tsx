import { ArrowLeft } from "lucide-react";

import { UserAvatar } from "../UserAvatar";
import type { Conversation, MatrixSession } from "../../types";

function groupTypingStatus(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length > 2) {
    const additional = names.length - 2;
    return `${names[0]}, ${names[1]} and ${additional} ${additional === 1 ? "other" : "others"} are typing…`;
  }
  return "typing…";
}

interface ChatHeaderProps {
  conversation: Conversation | null;
  matrixSession: MatrixSession | null;
  onBack: () => void;
}

export function ChatHeader({ conversation, matrixSession, onBack }: ChatHeaderProps) {
  if (!conversation) {
    return (
      <header className="chat-header chat-header-empty">
        <strong>Select a conversation</strong>
      </header>
    );
  }

  // Only a definite "online" from Synapse presence is shown; anything else shows no dot.
  const online = !conversation.isGroup && conversation.presence === "online";
  const status = conversation.isTyping
    ? conversation.isGroup
      ? groupTypingStatus(conversation.typingNames ?? [])
      : "typing…"
    : conversation.isGroup
      ? conversation.bio ?? "Group"
      : online
        ? "Online"
        : conversation.username
        ? `@${conversation.username}`
        : "";

  return (
    <header className="chat-header">
      <button type="button" className="mobile-back-button" onClick={onBack} aria-label="Back to conversations">
        <ArrowLeft size={20} />
      </button>
      <UserAvatar
        name={conversation.name}
        initials={conversation.initials}
        accent={conversation.accent}
        avatarUrl={conversation.avatarUrl}
        matrixToken={matrixSession?.access_token}
        size="md"
        presence={conversation.isGroup ? undefined : conversation.presence}
      />
      <div className="chat-header-person">
        <h1>{conversation.name}</h1>
        {status && <span className={conversation.isTyping ? "typing-text" : online ? "online-text" : ""}>{status}</span>}
      </div>
    </header>
  );
}
