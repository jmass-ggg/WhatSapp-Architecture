import { ArrowUpRight, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useState } from "react";

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
}: NewConversationDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [sentRequestIds, setSentRequestIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || mode !== "live" || query.trim().length < 2) {
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
  }, [api, currentUserId, mode, open, query]);

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
            <h2 id="new-chat-title">Start a conversation</h2>
            <p>
              {mode === "demo"
                ? "Choose a sample conversation. Nothing is sent to a server."
                : "Search by username and send a connection request. You can chat after they accept."}
            </p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
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
        {error && <p className="dialog-error" role="alert">{error}</p>}

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
      </section>
    </div>
  );
}
