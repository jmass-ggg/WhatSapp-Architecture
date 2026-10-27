import {
  ArrowLeft,
  Ellipsis,
  Info,
  Search,
  UserRound,
} from "lucide-react";
import { useState } from "react";

import { UserAvatar } from "../UserAvatar";
import type { AuthMode, Conversation, MatrixSession } from "../../types";

interface ChatHeaderProps {
  conversation: Conversation | null;
  mode: AuthMode;
  matrixSession: MatrixSession | null;
  searchOpen: boolean;
  onBack: () => void;
  onSearch: () => void;
  onContactInfo: () => void;
}

export function ChatHeader({
  conversation,
  mode,
  matrixSession,
  searchOpen,
  onBack,
  onSearch,
  onContactInfo,
}: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (!conversation) {
    return (
      <header className="chat-header chat-header-empty">
        <div className="chat-header-empty-copy">
          <strong>Select a conversation</strong>
          <span>Your messages will appear here.</span>
        </div>
      </header>
    );
  }

  const status = conversation.isEncrypted
    ? "Encrypted · decryption unavailable"
    : conversation.isTyping
      ? "typing…"
      : conversation.isOnline
        ? "Online now"
        : mode === "demo"
          ? "Usually replies quickly"
          : conversation.isOnline === false
            ? "Offline"
            : "Matrix conversation";

  return (
    <header className="chat-header">
      <button
        type="button"
        className="mobile-back-button"
        onClick={onBack}
        aria-label="Back to conversations"
      >
        <ArrowLeft size={20} />
      </button>
      <UserAvatar
        name={conversation.name}
        initials={conversation.initials}
        accent={conversation.accent}
        avatarUrl={conversation.avatarUrl}
        matrixToken={matrixSession?.access_token}
        size="md"
        online={conversation.isOnline}
      />
      <div className="chat-header-person">
        <div className="chat-header-name-row">
          <h1>{conversation.name}</h1>
          {conversation.isGroup && <span className="group-pill">Group</span>}
        </div>
        <span className={conversation.isTyping ? "typing-text" : ""}>
          {conversation.isOnline && <i className="status-dot" aria-hidden="true" />}
          {status}
        </span>
      </div>
      <div className="chat-header-actions">
        <button
          type="button"
          className={`chat-action-button${searchOpen ? " active" : ""}`}
          onClick={onSearch}
          aria-label={searchOpen ? "Close message search" : "Search messages"}
          title="Search in conversation"
        >
          <Search size={18} />
        </button>
        <button
          type="button"
          className="chat-action-button contact-toggle"
          onClick={onContactInfo}
          aria-label="Show contact information"
          title="Contact information"
        >
          <Info size={18} />
        </button>
        <div className="menu-anchor">
          <button
            type="button"
            className="chat-action-button"
            aria-label="More conversation options"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Ellipsis size={20} />
          </button>
          {menuOpen && (
            <div className="dropdown-menu header-dropdown">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onSearch();
                }}
              >
                <Search size={16} /> Search messages
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onContactInfo();
                }}
              >
                <UserRound size={16} /> Contact info
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
