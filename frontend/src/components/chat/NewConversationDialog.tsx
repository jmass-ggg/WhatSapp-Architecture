import { ArrowUpRight, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import { UserAvatar } from "../UserAvatar";
import type { ApiClient } from "../../services/api/client";
import type {
  AuthMode,
  Conversation,
  DirectoryPage,
  DirectoryUser,
} from "../../types";
import { ApiError } from "../../services/api/client";
import { mappedMatrixUserId } from "../../services/matrix/client";

interface NewConversationDialogProps {
  open: boolean;
  mode: AuthMode;
  api: ApiClient;
  currentUserId: string;
  conversations: Conversation[];
  onClose: () => void;
  onSelectDemo: (conversation: Conversation) => void;
  onCreateDirect: (
    user: DirectoryUser,
    matrixUserId: string,
  ) => Promise<void>;
}

export function NewConversationDialog({
  open,
  mode,
  api,
  currentUserId,
  conversations,
  onClose,
  onSelectDemo,
  onCreateDirect,
}: NewConversationDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
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

  if (!open) return null;

  async function startConversation(user: DirectoryUser) {
    setBusyUserId(user.id);
    setError("");
    try {
      await onCreateDirect(user, mappedMatrixUserId(user));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We couldn't start that conversation.",
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
            <span className="eyebrow">{mode === "demo" ? "DEMO PREVIEW" : "LUMACHAT DIRECTORY"}</span>
            <h2 id="new-chat-title">Start a conversation</h2>
            <p>
              {mode === "demo"
                ? "Choose a sample conversation. Nothing is sent to a server."
                : "Find a LumaChat user and invite them to a Matrix direct room."}
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
            placeholder={mode === "demo" ? "Find a sample contact" : "Search name or username"}
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
                  <small>{conversation.username ?? "LumaChat demo contact"}</small>
                </span>
                <ArrowUpRight size={17} />
              </button>
            ))
          ) : loading ? (
            <div className="directory-state"><LoaderCircle className="spin" size={20} /> Searching users…</div>
          ) : query.trim().length < 2 ? (
            <div className="directory-state">Type at least 2 characters to search the app directory.</div>
          ) : results.length === 0 && !error ? (
            <div className="directory-state">No people found. Try another name or username.</div>
          ) : (
            results.map((user) => {
              const name = user.profile.display_name || user.username;
              const initials = name
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join("")
                .toUpperCase();
              return (
                <button
                  type="button"
                  className="directory-result"
                  key={user.id}
                  onClick={() => void startConversation(user)}
                  disabled={busyUserId !== null}
                >
                  <UserAvatar
                    name={name}
                    initials={initials}
                    size="md"
                    avatarUrl={user.profile.profile_picture_url}
                  />
                  <span className="directory-result-copy">
                    <strong>{name}</strong>
                    <small>@{user.username}</small>
                  </span>
                  {busyUserId === user.id ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <ArrowUpRight size={17} />
                  )}
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
