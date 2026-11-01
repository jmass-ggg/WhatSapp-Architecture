import { ArrowLeft, MessageSquare, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { SearchInput } from "../SearchInput";
import { UserAvatar } from "../UserAvatar";
import type { ConnectionUser, MatrixSession, UserConnection } from "../../types";

interface ContactsViewProps {
  connections: UserConnection[];
  incomingRequests: UserConnection[];
  outgoingRequests: UserConnection[];
  loading: boolean;
  error: string | null;
  matrixSession: MatrixSession | null;
  respondingRequestId: string | null;
  startingContactId: string | null;
  onMessage: (contact: ConnectionUser) => void;
  onAccept: (request: UserConnection) => void;
  onDecline: (request: UserConnection) => void;
  onAddContact: () => void;
}

const nameOf = (user: ConnectionUser) => user.profile?.display_name || user.username;
const initialsOf = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";

function matches(user: ConnectionUser, query: string): boolean {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  return [nameOf(user), user.username, user.profile?.job_title, user.profile?.department]
    .some((field) => field?.toLowerCase().includes(value));
}

/** Sidebar list plus detail pane for accepted contacts and connection requests. */
export function ContactsView({
  connections, incomingRequests, outgoingRequests, loading, error, matrixSession, respondingRequestId,
  startingContactId, onMessage, onAccept, onDecline, onAddContact,
}: ContactsViewProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const token = matrixSession?.access_token;

  const contacts = useMemo(
    () => connections.filter((c) => matches(c.other_user, query)).sort((a, b) => nameOf(a.other_user).localeCompare(nameOf(b.other_user))),
    [connections, query],
  );
  const selected = connections.find((c) => c.other_user.id === selectedId)?.other_user ?? null;
  const profile = selected?.profile;

  const avatar = (user: ConnectionUser, size: "sm" | "md" | "xl" = "md") => (
    <UserAvatar
      name={nameOf(user)}
      initials={initialsOf(nameOf(user))}
      accent={Math.abs(user.id.length * 13) % 6}
      size={size}
      avatarUrl={user.profile?.profile_picture_url}
      matrixToken={token}
    />
  );

  return (
    <>
      <aside className="conversation-sidebar" aria-label="Contacts">
        <header className="sidebar-header">
          <h1 className="sidebar-title">Contacts</h1>
          <button type="button" className="new-chat-button" onClick={onAddContact}>
            <Plus size={18} aria-hidden="true" />
            Add contact
          </button>
        </header>
        <div className="sidebar-search-wrap">
          <SearchInput value={query} onChange={setQuery} placeholder="Search contacts…" label="Search contacts" />
        </div>

        <div className="conversation-scroll">
          {loading && <p className="sidebar-empty" role="status">Loading contacts…</p>}
          {error && <p className="sidebar-empty is-error" role="alert">{error}</p>}

          {incomingRequests.length > 0 && (
            <section className="connection-requests" aria-label="Connection requests">
              <h2 className="sidebar-list-heading">Requests ({incomingRequests.length})</h2>
              {incomingRequests.map((request) => (
                <div className="connection-request-card" key={request.id}>
                  {avatar(request.other_user, "sm")}
                  <span className="connection-request-person">
                    <strong>{nameOf(request.other_user)}</strong>
                    <small>@{request.other_user.username}</small>
                  </span>
                  <div className="connection-request-actions">
                    <button type="button" onClick={() => onAccept(request)} disabled={respondingRequestId !== null}>
                      {respondingRequestId === request.id ? "Working…" : "Accept"}
                    </button>
                    <button type="button" className="is-secondary" onClick={() => onDecline(request)} disabled={respondingRequestId !== null}>
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {outgoingRequests.length > 0 && (
            <section className="connection-requests" aria-label="Sent requests">
              <h2 className="sidebar-list-heading">Sent requests ({outgoingRequests.length})</h2>
              {outgoingRequests.map((request) => (
                <div className="contact-row is-static" key={request.id}>
                  {avatar(request.other_user, "sm")}
                  <span className="contact-row-copy">
                    <strong>{nameOf(request.other_user)}</strong>
                    <small>@{request.other_user.username}</small>
                  </span>
                  <span className="contact-status">Pending</span>
                </div>
              ))}
            </section>
          )}

          <section aria-label="Accepted contacts">
            <h2 className="sidebar-list-heading">Contacts ({connections.length})</h2>
            {contacts.length === 0 && !loading ? (
              <p className="sidebar-empty">
                {query ? "No matches." : "No contacts yet. Use Add contact to send a connection request."}
              </p>
            ) : (
              contacts.map(({ other_user: user }) => (
                <button
                  key={user.id}
                  type="button"
                  className={`contact-row${selectedId === user.id ? " is-selected" : ""}`}
                  aria-current={selectedId === user.id ? "true" : undefined}
                  onClick={() => setSelectedId(user.id)}
                >
                  {avatar(user)}
                  <span className="contact-row-copy">
                    <strong>{nameOf(user)}</strong>
                    <small>{[user.profile?.job_title, user.profile?.department].filter(Boolean).join(" · ") || `@${user.username}`}</small>
                  </span>
                </button>
              ))
            )}
          </section>
        </div>
      </aside>

      <section className={`chat-main contact-detail${selected ? " is-open" : ""}`} aria-label="Contact details">
        {selected ? (
          <div className="contact-card">
            <button type="button" className="mobile-back-button" onClick={() => setSelectedId(null)} aria-label="Back to contacts">
              <ArrowLeft size={20} />
            </button>
            {avatar(selected, "xl")}
            <h2>{nameOf(selected)}</h2>
            <p className="contact-username">@{selected.username}</p>
            <dl className="contact-fields">
              {profile?.job_title && (<><dt>Job title</dt><dd>{profile.job_title}</dd></>)}
              {profile?.department && (<><dt>Department</dt><dd>{profile.department}</dd></>)}
              <dt>About</dt>
              <dd>{profile?.bio || "This contact has not added a bio."}</dd>
            </dl>
            <button
              type="button"
              className="new-chat-button"
              disabled={startingContactId === selected.id}
              onClick={() => onMessage(selected)}
            >
              <MessageSquare size={18} aria-hidden="true" />
              {startingContactId === selected.id ? "Opening…" : "Send message"}
            </button>
          </div>
        ) : (
          <div className="empty-chat">
            <span className="empty-chat-icon"><MessageSquare size={28} /></span>
            <h2>Select a contact</h2>
            <p>Choose a contact to view their profile or start a conversation.</p>
          </div>
        )}
      </section>
    </>
  );
}
