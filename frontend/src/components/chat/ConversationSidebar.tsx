import {
  Ellipsis,
  LogOut,
  MessageSquarePlus,
  Settings2,
  UsersRound,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Brand } from "../Brand";
import { MatrixConnectionStatus } from "../MatrixConnectionStatus";
import { SearchInput } from "../SearchInput";
import { UserAvatar } from "../UserAvatar";
import { ConversationListItem } from "./ConversationListItem";
import type {
  AuthMode,
  Conversation,
  MatrixSession,
  UserConnection,
  UserProfile,
} from "../../types";
import type { MatrixConnectionStatus as ConnectionStatus } from "../../services/matrix/session";
import type {
  MatrixCryptoOnboardingStatus,
  MatrixCryptoStatus,
} from "../../types/matrix";

interface ConversationSidebarProps {
  conversations: Conversation[];
  selectedId?: string;
  currentUser: UserProfile;
  mode: AuthMode;
  matrixSession: MatrixSession | null;
  matrixStatus: ConnectionStatus;
  initialSyncComplete: boolean;
  cryptoStatus: MatrixCryptoStatus;
  cryptoOnboardingStatus: MatrixCryptoOnboardingStatus;
  authenticationError: boolean;
  incomingRequests: UserConnection[];
  requestsLoading: boolean;
  requestError: string | null;
  respondingRequestId: string | null;
  onSelect: (conversation: Conversation) => void;
  onAcceptRequest: (request: UserConnection) => void;
  onDeclineRequest: (request: UserConnection) => void;
  onNewChat: () => void;
  onSignOut: () => void;
  onSettings: () => void;
}

export function ConversationSidebar({
  conversations,
  selectedId,
  currentUser,
  mode,
  matrixSession,
  matrixStatus,
  initialSyncComplete,
  cryptoStatus,
  cryptoOnboardingStatus,
  authenticationError,
  incomingRequests,
  requestsLoading,
  requestError,
  respondingRequestId,
  onSelect,
  onAcceptRequest,
  onDeclineRequest,
  onNewChat,
  onSignOut,
  onSettings,
}: ConversationSidebarProps) {
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return conversations;
    return conversations.filter(
      (conversation) =>
        conversation.name.toLowerCase().includes(value) ||
        conversation.lastMessage.toLowerCase().includes(value),
    );
  }, [conversations, query]);

  const displayName = currentUser.profile.display_name || currentUser.username;

  return (
    <aside className="conversation-sidebar" aria-label="Conversations">
      <header className="sidebar-header">
        <Brand />
        <div className="sidebar-actions">
          <button
            type="button"
            className="new-chat-button"
            onClick={onNewChat}
            aria-label="Start a new chat"
            title="Start a new chat"
          >
            <MessageSquarePlus size={18} />
          </button>
          <button
            type="button"
            className="sidebar-icon-button"
            onClick={onSettings}
            aria-label="Encryption and devices"
            title="Encryption and devices"
          >
            <Settings2 size={18} />
          </button>
          <div className="menu-anchor">
            <button
              type="button"
              className="sidebar-icon-button"
              aria-label="More options"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Ellipsis size={20} />
            </button>
            {menuOpen && (
              <div className="dropdown-menu sidebar-dropdown">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onNewChat();
                  }}
                >
                  <UsersRound size={16} /> New conversation
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onSignOut();
                  }}
                >
                  <LogOut size={16} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <button type="button" className="sidebar-new-chat" onClick={onNewChat}>
        <MessageSquarePlus size={17} />
        <span>New chat</span>
        <span className="new-chat-shortcut">⌘ K</span>
      </button>

      <div className="sidebar-search-wrap">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search or start a new chat"
          label="Search conversations"
        />
      </div>

      {mode === "live" && (
        <section className="connection-requests" aria-label="Connection Requests">
          <div className="sidebar-list-heading">
            <span>Connection Requests</span>
            <span>{incomingRequests.length}</span>
          </div>
          {requestsLoading ? (
            <div className="connection-request-state">Loading requests…</div>
          ) : requestError ? (
            <div className="connection-request-state is-error" role="alert">
              {requestError}
            </div>
          ) : incomingRequests.length === 0 ? (
            <div className="connection-request-state">No pending requests</div>
          ) : (
            <div className="connection-request-list">
              {incomingRequests.map((request) => {
                const contact = request.other_user;
                const name = contact.profile?.display_name || contact.username;
                const initials = name
                  .trim()
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join("")
                  .toUpperCase();
                const busy = respondingRequestId === request.id;
                return (
                  <div className="connection-request-card" key={request.id}>
                    <div className="connection-request-person">
                      <UserAvatar
                        name={name}
                        initials={initials}
                        size="sm"
                        avatarUrl={contact.profile?.profile_picture_url}
                        matrixToken={matrixSession?.access_token}
                      />
                      <span>
                        <strong>{name}</strong>
                        <small>@{contact.username}</small>
                      </span>
                    </div>
                    <div className="connection-request-actions">
                      <button
                        type="button"
                        onClick={() => onAcceptRequest(request)}
                        disabled={respondingRequestId !== null}
                      >
                        {busy ? "Working…" : "Accept"}
                      </button>
                      <button
                        type="button"
                        className="is-secondary"
                        onClick={() => onDeclineRequest(request)}
                        disabled={respondingRequestId !== null}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <div className="sidebar-list-heading">
        <span>Messages</span>
        <span>{filtered.length}</span>
      </div>

      <div className="conversation-list" role="list" aria-label="Your conversations">
        {filtered.map((conversation) => (
          <div className="conversation-list-item" role="listitem" key={conversation.id}>
            <ConversationListItem
              conversation={conversation}
              selected={selectedId === conversation.id}
              matrixToken={matrixSession?.access_token}
              onSelect={() => onSelect(conversation)}
            />
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="sidebar-empty">
            {conversations.length === 0
              ? "Start a conversation to see it here."
              : "No conversations match that search."}
          </div>
        )}
      </div>

      <footer className="sidebar-account">
        <UserAvatar
          name={displayName}
          initials={displayName
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0])
            .join("")
            .toUpperCase()}
          size="sm"
          avatarUrl={currentUser.profile.profile_picture_url}
          matrixToken={matrixSession?.access_token}
          online={true}
        />
        <div className="sidebar-account-copy">
          <strong>{displayName}</strong>
          {mode === "demo" ? (
            <span>Demo mode</span>
          ) : (
            <MatrixConnectionStatus
              status={matrixStatus}
              initialSyncComplete={initialSyncComplete}
              cryptoStatus={cryptoStatus}
              cryptoOnboardingStatus={cryptoOnboardingStatus}
              authenticationError={authenticationError}
              compact
            />
          )}
        </div>
        <button
          type="button"
          className="sidebar-account-menu"
          aria-label="Sign out"
          title="Sign out"
          onClick={onSignOut}
        >
          <LogOut size={17} />
        </button>
      </footer>
    </aside>
  );
}
