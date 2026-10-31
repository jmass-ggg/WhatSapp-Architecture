import { LogOut, MessageSquarePlus, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";

import { Brand } from "../Brand";
import { SearchInput } from "../SearchInput";
import { UserAvatar } from "../UserAvatar";
import { ConversationListItem } from "./ConversationListItem";
import type { Conversation, MatrixSession, UserConnection, UserProfile } from "../../types";

interface ConversationSidebarProps {
  conversations: Conversation[];
  selectedId?: string;
  currentUser: UserProfile;
  matrixSession: MatrixSession | null;
  incomingRequests: UserConnection[];
  requestsLoading: boolean;
  requestError: string | null;
  respondingRequestId: string | null;
  loading?: boolean;
  onSelect: (conversation: Conversation) => void;
  onAcceptRequest: (request: UserConnection) => void;
  onDeclineRequest: (request: UserConnection) => void;
  onNewChat: () => void;
  onNewGroup: () => void;
  onSignOut: () => void;
}

function initialsFor(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function ConversationSidebar({
  conversations,
  selectedId,
  currentUser,
  matrixSession,
  incomingRequests,
  requestsLoading,
  requestError,
  respondingRequestId,
  loading = false,
  onSelect,
  onAcceptRequest,
  onDeclineRequest,
  onNewChat,
  onNewGroup,
  onSignOut,
}: ConversationSidebarProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return conversations;
    return conversations.filter(
      (conversation) =>
        conversation.name.toLowerCase().includes(value) ||
        conversation.username?.toLowerCase().includes(value) ||
        conversation.lastMessage.toLowerCase().includes(value),
    );
  }, [conversations, query]);
  const direct = filtered.filter((conversation) => !conversation.isGroup);
  const groups = filtered.filter((conversation) => conversation.isGroup);
  const displayName = currentUser.profile.display_name || currentUser.username;

  const renderList = (label: string, items: Conversation[]) => (
    <section className="conversation-section" aria-label={label}>
      <h2 className="sidebar-list-heading">{label}</h2>
      {items.length === 0 ? (
        <p className="sidebar-empty">{query ? "No matches." : `No ${label.toLowerCase()} yet.`}</p>
      ) : (
        <div className="conversation-list" role="list">
          {items.map((conversation) => (
            <div className="conversation-list-item" role="listitem" key={conversation.id}>
              <ConversationListItem
                conversation={conversation}
                selected={selectedId === conversation.id}
                matrixToken={matrixSession?.access_token}
                onSelect={() => onSelect(conversation)}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <aside className="conversation-sidebar" aria-label="Conversations">
      <header className="sidebar-header">
        <Brand />
        <div className="sidebar-actions">
          <button type="button" className="sidebar-icon-button" onClick={onNewChat} aria-label="New chat" title="New chat">
            <MessageSquarePlus size={18} />
          </button>
          <button type="button" className="sidebar-icon-button" onClick={onNewGroup} aria-label="Create group" title="Create group">
            <UsersRound size={18} />
          </button>
        </div>
      </header>

      <div className="sidebar-account">
        <UserAvatar
          name={displayName}
          initials={initialsFor(displayName)}
          size="sm"
          avatarUrl={currentUser.profile.profile_picture_url}
          matrixToken={matrixSession?.access_token}
        />
        <div className="sidebar-account-copy">
          <strong>{displayName}</strong>
          <span>@{currentUser.username}</span>
        </div>
        <button type="button" className="sidebar-icon-button" aria-label="Log out" title="Log out" onClick={onSignOut}>
          <LogOut size={17} />
        </button>
      </div>

      <div className="sidebar-search-wrap">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search conversations"
          label="Search conversations"
        />
      </div>

      {(requestsLoading || requestError || incomingRequests.length > 0) && (
        <section className="connection-requests" aria-label="Connection requests">
          <h2 className="sidebar-list-heading">Requests ({incomingRequests.length})</h2>
          {requestsLoading ? (
            <p className="sidebar-empty">Loading requests…</p>
          ) : requestError ? (
            <p className="sidebar-empty is-error" role="alert">{requestError}</p>
          ) : (
            incomingRequests.map((request) => {
              const contact = request.other_user;
              const name = contact.profile?.display_name || contact.username;
              const busy = respondingRequestId === request.id;
              return (
                <div className="connection-request-card" key={request.id}>
                  <UserAvatar
                    name={name}
                    initials={initialsFor(name)}
                    size="sm"
                    avatarUrl={contact.profile?.profile_picture_url}
                    matrixToken={matrixSession?.access_token}
                  />
                  <span className="connection-request-person">
                    <strong>{name}</strong>
                    <small>@{contact.username}</small>
                  </span>
                  <div className="connection-request-actions">
                    <button type="button" onClick={() => onAcceptRequest(request)} disabled={respondingRequestId !== null}>
                      {busy ? "Working…" : "Accept"}
                    </button>
                    <button type="button" className="is-secondary" onClick={() => onDeclineRequest(request)} disabled={respondingRequestId !== null}>
                      Decline
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </section>
      )}

      <div className="conversation-scroll">
        {loading ? (
          <p className="sidebar-empty" role="status">Loading conversations…</p>
        ) : (
          <>
            {renderList("Direct messages", direct)}
            {renderList("Groups", groups)}
          </>
        )}
      </div>
    </aside>
  );
}
