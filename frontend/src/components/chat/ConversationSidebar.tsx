import { ChevronDown, Plus, Star, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";

import { SearchInput } from "../SearchInput";
import { UserAvatar } from "../UserAvatar";
import { ConversationListItem } from "./ConversationListItem";
import {
  countUnreadConversations,
  groupConversations,
  type ChatFilter,
} from "../../services/conversationFilters";
import type { Conversation, MatrixSession, UserConnection } from "../../types";

interface ConversationSidebarProps {
  conversations: Conversation[];
  selectedId?: string;
  matrixSession: MatrixSession | null;
  favoriteIds?: ReadonlySet<string>;
  pinnedIds?: ReadonlySet<string>;
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
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function initialsFor(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function ConversationSidebar({
  conversations,
  selectedId,
  matrixSession,
  favoriteIds = EMPTY_SET,
  pinnedIds = EMPTY_SET,
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
}: ConversationSidebarProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [collapsed, setCollapsed] = useState({ pinned: false, recent: false });
  const unreadConversations = useMemo(() => countUnreadConversations(conversations), [conversations]);
  const { pinned, recent } = useMemo(
    () => groupConversations(conversations, { filter, query, favoriteIds, pinnedIds }),
    [conversations, favoriteIds, filter, pinnedIds, query],
  );

  const renderList = (key: "pinned" | "recent", label: string, items: Conversation[]) => {
    const isCollapsed = collapsed[key];
    return (
      <section className="conversation-section" aria-label={label}>
        <button
          type="button"
          className="sidebar-section-toggle"
          aria-expanded={!isCollapsed}
          onClick={() => setCollapsed((value) => ({ ...value, [key]: !value[key] }))}
        >
          <ChevronDown size={16} aria-hidden="true" className={isCollapsed ? "is-collapsed" : undefined} />
          {label}
        </button>
        {!isCollapsed && items.map((conversation) => (
          <div className="conversation-list-item" key={conversation.id}>
            <ConversationListItem
              conversation={conversation}
              selected={selectedId === conversation.id}
              matrixToken={matrixSession?.access_token}
              isFavorite={favoriteIds.has(conversation.id)}
              isPinned={pinnedIds.has(conversation.id)}
              onSelect={() => onSelect(conversation)}
            />
          </div>
        ))}
      </section>
    );
  };

  const filters: { id: ChatFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "unread", label: "Unread" },
    { id: "favorites", label: "Favorites" },
    { id: "groups", label: "Groups" },
  ];
  const nothingVisible = pinned.length === 0 && recent.length === 0;
  const emptyText = query
    ? "No matches."
    : filter === "unread"
      ? "No unread conversations."
      : filter === "favorites"
        ? "No favorite conversations yet."
        : filter === "groups"
          ? "No groups yet."
          : "No conversations yet.";

  return (
    <aside className="conversation-sidebar" aria-label="Conversations">
      <header className="sidebar-header">
        <h1 className="sidebar-title">Chats</h1>
        <div className="sidebar-actions">
          <button type="button" className="sidebar-icon-button" onClick={onNewGroup} aria-label="Create group" title="Create group">
            <UsersRound size={18} />
          </button>
          <button type="button" className="new-chat-button" onClick={onNewChat} aria-label="New chat">
            <Plus size={18} aria-hidden="true" />
            New chat
          </button>
        </div>
      </header>

      <div className="sidebar-search-wrap">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search conversations…"
          label="Search conversations"
        />
      </div>

      <div className="filter-chips" role="group" aria-label="Filter conversations">
        {filters.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`filter-chip${filter === id ? " is-active" : ""}`}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {id === "favorites" && <Star size={14} aria-hidden="true" />}
            {id === "groups" && <UsersRound size={14} aria-hidden="true" />}
            {label}
            {id === "unread" && unreadConversations > 0 && (
              <span className="filter-chip-count" aria-label={`${unreadConversations} unread conversations`}>
                {unreadConversations}
              </span>
            )}
          </button>
        ))}
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
            {pinned.length > 0 && renderList("pinned", "Pinned", pinned)}
            {recent.length > 0 && renderList("recent", "Recent", recent)}
            {nothingVisible && <p className="sidebar-empty">{emptyText}</p>}
          </>
        )}
      </div>
    </aside>
  );
}
