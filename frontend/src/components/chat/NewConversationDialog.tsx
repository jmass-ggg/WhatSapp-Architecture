import { ArrowUpRight, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { UserAvatar } from "../UserAvatar";
import type { ApiClient } from "../../services/api/client";
import type {
  AuthMode,
  Conversation,
  DirectoryPage,
  DirectoryUser,
  UserConnection,
} from "../../types";
import { ApiError } from "../../services/api/client";

interface NewConversationDialogProps {
  open: boolean;
  mode: AuthMode;
  api: ApiClient;
  currentUserId: string;
  conversations: Conversation[];
  connections: UserConnection[];
  incomingRequests: UserConnection[];
  outgoingRequests: UserConnection[];
  onClose: () => void;
  onSelectDemo: (conversation: Conversation) => void;
  onSendRequest: (user: DirectoryUser) => Promise<void>;
  onCreateGroup: (name: string, contactUserIds: string[]) => Promise<void>;
}

export function NewConversationDialog({
  open,
  mode,
  api,
  currentUserId,
  conversations,
  connections,
  incomingRequests,
  outgoingRequests,
  onClose,
  onSelectDemo,
  onSendRequest,
  onCreateGroup,
}: NewConversationDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [sentRequestIds, setSentRequestIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const [groupMode, setGroupMode] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [selectedGroupMemberIds, setSelectedGroupMemberIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [creatingGroup, setCreatingGroup] = useState(false);
  const creatingGroupRef = useRef(false);

  const selectableContacts = [
    ...new Map(
      connections
        .filter(
          (connection) =>
            connection.status === "accepted" &&
            connection.other_user.id !== currentUserId,
        )
        .map((connection) => [connection.other_user.id, connection]),
    ).values(),
  ];

  useEffect(() => {
    if (!open) return;
    setGroupMode(false);
    setGroupName("");
    setSelectedGroupMemberIds(new Set());
    setError("");
    creatingGroupRef.current = false;
    setCreatingGroup(false);
  }, [open]);

  useEffect(() => {
    if (!open || groupMode || mode !== "live" || query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      setError("");
      return;
    }

    let active = true;
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      void api
        .request<DirectoryPage>(
          `/users/search?q=${encodeURIComponent(query.trim())}&limit=20`,
        )
        .then((page) => {
          if (active) {
            setResults(page.items.filter((user) => user.id !== currentUserId));
          }
        })
        .catch((cause) => {
          if (!active) return;
          setError(
            cause instanceof ApiError
              ? cause.message
              : "Directory search is unavailable right now.",
          );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, currentUserId, groupMode, mode, open, query]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    const pendingIds = new Set(
      outgoingRequests.map((request) => request.other_user.id),
    );
    setSentRequestIds((current) => {
      const remaining = new Set(
        [...current].filter((userId) => pendingIds.has(userId)),
      );
      return remaining.size === current.size ? current : remaining;
    });
  }, [outgoingRequests]);

  if (!open) return null;

  async function sendConnectionRequest(user: DirectoryUser) {
    setBusyUserId(user.id);
    setError("");
    try {
      await onSendRequest(user);
      setSentRequestIds((current) => new Set(current).add(user.id));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We couldn't send that connection request.",
      );
    } finally {
      setBusyUserId(null);
    }
  }

  async function createGroup() {
    if (creatingGroupRef.current) return;
    const name = groupName.trim();
    if (!name) {
      setError("Enter a name for the group.");
      return;
    }
    if (name.length > 80) {
      setError("Group names must be 80 characters or fewer.");
      return;
    }

    const contactUserIds = [...selectedGroupMemberIds];
    const allowedUserIds = new Set(
      selectableContacts.map((connection) => connection.other_user.id),
    );
    if (
      contactUserIds.length < 2 ||
      new Set(contactUserIds).size !== contactUserIds.length
    ) {
      setError("Select at least two different accepted contacts.");
      return;
    }
    if (
      contactUserIds.some(
        (userId) => userId === currentUserId || !allowedUserIds.has(userId),
      )
    ) {
      setError("Groups can only include your accepted contacts.");
      return;
    }

    creatingGroupRef.current = true;
    setCreatingGroup(true);
    setError("");
    try {
      await onCreateGroup(name, contactUserIds);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The encrypted group could not be created.",
      );
    } finally {
      creatingGroupRef.current = false;
      setCreatingGroup(false);
    }
  }

  const demoResults = conversations.filter((conversation) => {
    const term = query.trim().toLowerCase();
    return (
      !term ||
      conversation.name.toLowerCase().includes(term) ||
      conversation.username?.toLowerCase().includes(term)
    );
  });

  return (
    <div
      className="modal-backdrop new-chat-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="new-chat-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-title"
      >
        <header className="new-chat-dialog-header">
          <div>
            <span className="eyebrow">{mode === "demo" ? "DEMO PREVIEW" : "RECRUITABLE CHAT DIRECTORY"}</span>
            <h2 id="new-chat-title">
              {groupMode ? "Create a group" : "Start a conversation"}
            </h2>
            <p>
              {groupMode
                ? "Create an encrypted group with at least two of your accepted contacts."
                : mode === "demo"
                ? "Choose a sample conversation. Nothing is sent to a server."
                : "Search by username and send a connection request. You can chat after they accept."}
            </p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {mode === "live" && (
          <div className="conversation-creation-options" aria-label="Conversation type">
            <button
              type="button"
              aria-pressed={!groupMode}
              className={!groupMode ? "is-active" : ""}
              onClick={() => {
                setGroupMode(false);
                setError("");
              }}
            >
              New conversation
            </button>
            <button
              type="button"
              aria-pressed={groupMode}
              className={groupMode ? "is-active" : ""}
              onClick={() => {
                setGroupMode(true);
                setError("");
              }}
            >
              New Group
            </button>
          </div>
        )}
        {groupMode ? (
          <label className="group-name-field">
            <span>Group name</span>
            <input
              aria-label="Group name"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              maxLength={80}
              autoComplete="off"
              placeholder="e.g. Development Team"
            />
          </label>
        ) : (
          <label className="new-chat-search">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">Search people</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={mode === "demo" ? "Find a sample contact" : "Search username"}
              autoFocus
              autoComplete="off"
            />
          </label>
        )}
        {error && <p className="dialog-error" role="alert">{error}</p>}

        {groupMode ? (
          <div className="new-chat-results group-contact-results">
            {selectableContacts.length === 0 ? (
              <div className="directory-state">
                Accept connection requests before creating a group.
              </div>
            ) : (
              selectableContacts.map((connection) => {
                const contact = connection.other_user;
                const name = contact.profile?.display_name || contact.username;
                const selected = selectedGroupMemberIds.has(contact.id);
                return (
                  <label
                    className={`directory-result group-contact-option${selected ? " is-selected" : ""}`}
                    key={contact.id}
                  >
                    <input
                      type="checkbox"
                      aria-label={name}
                      checked={selected}
                      onChange={(event) => {
                        setSelectedGroupMemberIds((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(contact.id);
                          else next.delete(contact.id);
                          return next;
                        });
                      }}
                    />
                    <UserAvatar
                      name={name}
                      initials={name.trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}
                      size="md"
                      avatarUrl={contact.profile?.profile_picture_url}
                    />
                    <span className="directory-result-copy">
                      <strong>{name}</strong>
                      <small>@{contact.username}</small>
                    </span>
                  </label>
                );
              })
            )}
          </div>
        ) : (
          <div className="new-chat-results">
          {mode === "demo" ? (
            demoResults.map((conversation) => (
              <button
                type="button"
                className="directory-result"
                key={conversation.id}
                onClick={() => onSelectDemo(conversation)}
              >
                <UserAvatar
                  name={conversation.name}
                  initials={conversation.initials}
                  accent={conversation.accent}
                  size="md"
                  online={conversation.isOnline}
                />
                <span className="directory-result-copy">
                  <strong>{conversation.name}</strong>
                  <small>{conversation.username ?? "Recruitable Chat demo contact"}</small>
                </span>
                <ArrowUpRight size={17} />
              </button>
            ))
          ) : loading ? (
            <div className="directory-state"><LoaderCircle className="spin" size={20} /> Searching users…</div>
          ) : query.trim().length < 2 ? (
              <div className="directory-state">Type at least 2 characters to search usernames.</div>
          ) : results.length === 0 && !error ? (
            <div className="directory-state">No people found. Try another name or username.</div>
          ) : (
            results.map((user) => {
              const name = user.profile?.display_name || user.username;
              const initials = name
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join("")
                .toUpperCase();
              const isConnected = connections.some(
                (connection) => connection.other_user.id === user.id,
              );
              const hasIncomingRequest = incomingRequests.some(
                (request) => request.other_user.id === user.id,
              );
              const hasOutgoingRequest =
                sentRequestIds.has(user.id) ||
                outgoingRequests.some((request) => request.other_user.id === user.id);
              const actionLabel = isConnected
                ? "Connected"
                : hasOutgoingRequest
                  ? "Request Sent"
                  : hasIncomingRequest
                    ? "Respond to Request"
                    : "Add Contact";
              return (
                <div className="directory-result" key={user.id}>
                  <UserAvatar
                    name={name}
                    initials={initials}
                    size="md"
                    avatarUrl={user.profile?.profile_picture_url}
                  />
                  <span className="directory-result-copy">
                    <strong>{name}</strong>
                    <small>@{user.username}</small>
                  </span>
                  <button
                    type="button"
                    className="add-contact-button"
                    onClick={() => void sendConnectionRequest(user)}
                    disabled={
                      busyUserId !== null ||
                      isConnected ||
                      hasOutgoingRequest ||
                      hasIncomingRequest
                    }
                  >
                    {busyUserId === user.id ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : actionLabel}
                  </button>
                </div>
              );
            })
          )}
          </div>
        )}
        {groupMode && (
          <footer className="group-create-footer">
            <span>
              {selectedGroupMemberIds.size} selected · Choose at least 2
            </span>
            <button
              type="button"
              className="primary-button"
              disabled={creatingGroup}
              onClick={() => void createGroup()}
            >
              {creatingGroup ? (
                <>
                  <LoaderCircle className="spin" size={15} />
                  Creating…
                </>
              ) : (
                "Create Group"
              )}
            </button>
          </footer>
        )}
        {creatingGroup && (
          <div className="group-create-progress" role="status">
            <LoaderCircle className="spin" size={15} />
            Creating encrypted group and sending invitations…
          </div>
        )}
      </section>
    </div>
  );
}
