import { ArrowLeft, MoreVertical, Pin, Search, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  isFavorite?: boolean;
  isPinned?: boolean;
  /** Favorites and pins are stored on Matrix rooms, so contacts without a room cannot use them. */
  canTag?: boolean;
  searchOpen?: boolean;
  infoOpen?: boolean;
  onToggleFavorite?: () => void;
  onTogglePinned?: () => void;
  onToggleSearch?: () => void;
  onOpenInfo?: () => void;
  onBack: () => void;
}

export function ChatHeader({
  conversation,
  matrixSession,
  isFavorite = false,
  isPinned = false,
  canTag = false,
  searchOpen = false,
  infoOpen = false,
  onToggleFavorite,
  onTogglePinned,
  onToggleSearch,
  onOpenInfo,
  onBack,
}: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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

  const identity = (
    <>
      <UserAvatar
        name={conversation.name}
        initials={conversation.initials}
        accent={conversation.accent}
        avatarUrl={conversation.avatarUrl}
        matrixToken={matrixSession?.access_token}
        size="md"
        presence={conversation.isGroup ? undefined : conversation.presence}
      />
      <span className="chat-header-person">
        <h1>{conversation.name}</h1>
        {status && <span className={conversation.isTyping ? "typing-text" : online ? "online-text" : ""}>{status}</span>}
      </span>
    </>
  );

  return (
    <header className="chat-header">
      <button type="button" className="mobile-back-button" onClick={onBack} aria-label="Back to conversations">
        <ArrowLeft size={20} />
      </button>
      {onOpenInfo ? (
        <button
          type="button"
          className="chat-header-identity"
          onClick={onOpenInfo}
          aria-label={`Open details for ${conversation.name}`}
          aria-expanded={infoOpen}
        >
          {identity}
        </button>
      ) : (
        <div className="chat-header-identity">{identity}</div>
      )}
      <div className="chat-header-actions">
        {onToggleSearch && (
          <button
            type="button"
            className={`header-icon-button${searchOpen ? " is-active" : ""}`}
            aria-label="Search in conversation"
            aria-pressed={searchOpen}
            title="Search in conversation"
            onClick={onToggleSearch}
          >
            <Search size={20} />
          </button>
        )}
        {canTag && onToggleFavorite && (
          <button
            type="button"
            className={`header-icon-button${isFavorite ? " is-favorite" : ""}`}
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={isFavorite}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            onClick={onToggleFavorite}
          >
            <Star size={20} fill={isFavorite ? "currentColor" : "none"} />
          </button>
        )}
        {canTag && onTogglePinned && (
          <div className="header-menu" ref={menuRef}>
            <button
              type="button"
              className="header-icon-button"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreVertical size={20} />
            </button>
            {menuOpen && (
              <div className="header-menu-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onTogglePinned();
                  }}
                >
                  <Pin size={16} aria-hidden="true" />
                  {isPinned ? "Unpin conversation" : "Pin conversation"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
