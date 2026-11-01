import {
  Copy, Download, ExternalLink, FileText, Link2, Loader2, Search, Star, UserRound, UsersRound, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { UserAvatar } from "../UserAvatar";
import { MAX_ATTACHMENT_BYTES } from "../../services/matrix/attachments";
import { fetchMatrixMedia } from "../../services/matrix/media";
import type { RoomMemberInfo } from "../../services/matrix/members";
import type { SharedAttachment, SharedContent } from "../../services/matrix/sharedContent";
import type { Attachment, Conversation, MatrixSession } from "../../types";
import { SharedMediaGallery } from "./SharedMediaGallery";

export interface StarredEntry {
  eventId: string;
  /** Present only when the message is part of the loaded history. */
  text?: string;
  senderName?: string;
  sentAt?: Date;
}

interface ConversationInfoPanelProps {
  conversation: Conversation;
  matrixSession: MatrixSession | null;
  shared: SharedContent;
  starred: StarredEntry[];
  members: RoomMemberInfo[];
  topic?: string;
  isFavorite: boolean;
  canTag: boolean;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onToggleFavorite: () => void;
  onSearch: () => void;
  onOpenMessage: (eventId: string) => void;
  onNotify: (message: string, kind: "success" | "error") => void;
  onClose: () => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes < 1) return "";
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function fileKind(attachment: Attachment): string {
  const subtype = attachment.mimeType?.split("/").at(-1);
  if (attachment.mimeType === "application/pdf") return "PDF";
  return subtype ? subtype.toUpperCase().slice(0, 12) : "File";
}

const initialsOf = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";

function FileRow({ item, token, onError }: { item: SharedAttachment; token?: string | null; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const { attachment } = item;

  const download = async () => {
    if (!token || !attachment.mediaUri) return;
    setBusy(true);
    try {
      const blob = await fetchMatrixMedia(token, attachment.mediaUri, MAX_ATTACHMENT_BYTES);
      const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      onError(`${attachment.name} could not be downloaded.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="info-file-row">
      <span className="info-file-icon"><FileText size={20} aria-hidden="true" /></span>
      <span className="info-file-copy">
        <strong title={attachment.name}>{attachment.name}</strong>
        <small>{[fileKind(attachment), formatBytes(attachment.size)].filter(Boolean).join(" · ")}</small>
      </span>
      {attachment.mediaUri && (
        <button
          type="button"
          className="header-icon-button"
          aria-label={`Download ${attachment.name}`}
          disabled={busy}
          onClick={() => void download()}
        >
          {busy ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
        </button>
      )}
    </li>
  );
}

export function ConversationInfoPanel({
  conversation, matrixSession, shared, starred, members, topic, isFavorite, canTag,
  canLoadOlder, loadingOlder, onLoadOlder, onToggleFavorite, onSearch, onOpenMessage, onNotify, onClose,
}: ConversationInfoPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const token = matrixSession?.access_token;
  const isGroup = Boolean(conversation.isGroup);
  const online = !isGroup && conversation.presence === "online";

  useEffect(() => closeRef.current?.focus(), [conversation.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(".image-viewer")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyUsername = async () => {
    if (!conversation.username) return;
    try {
      await navigator.clipboard.writeText(`@${conversation.username}`);
      onNotify("Username copied.", "success");
    } catch {
      onNotify("Copying is not available in this browser.", "error");
    }
  };

  const files = showAllFiles ? shared.files : shared.files.slice(0, 4);
  const links = showAllFiles ? shared.links : shared.links.slice(0, 4);
  const hasMoreFiles = shared.files.length > 4 || shared.links.length > 4;

  return (
    <aside className="info-panel" aria-label={isGroup ? "Group information" : "Contact information"}>
      <header className="info-panel-header">
        <h2>{isGroup ? "Group info" : "Contact info"}</h2>
        <button ref={closeRef} type="button" className="header-icon-button" aria-label="Close details" onClick={onClose}>
          <X size={20} />
        </button>
      </header>

      <div className="info-panel-scroll">
        <section className="info-profile">
          <UserAvatar
            name={conversation.name}
            initials={conversation.initials}
            accent={conversation.accent}
            avatarUrl={conversation.avatarUrl}
            matrixToken={token}
            size="xl"
            presence={isGroup ? undefined : conversation.presence}
          />
          <div className="info-profile-copy">
            <h3>{conversation.name}</h3>
            {!isGroup && conversation.jobTitle && <p>{conversation.jobTitle}</p>}
            {isGroup && <p>{members.length} {members.length === 1 ? "member" : "members"}</p>}
            {online && <span className="info-online-badge">Online</span>}
          </div>
        </section>

        {!isGroup && (conversation.username || conversation.department) && (
          <ul className="info-details">
            {conversation.username && (
              <li><UserRound size={16} aria-hidden="true" /> <span>@{conversation.username}</span></li>
            )}
            {conversation.department && (
              <li><UsersRound size={16} aria-hidden="true" /> <span>{conversation.department}</span></li>
            )}
          </ul>
        )}

        <div className="info-actions">
          <button type="button" className="info-action" onClick={onSearch}>
            <Search size={16} aria-hidden="true" /> Search
          </button>
          {canTag && (
            <button
              type="button"
              className={`info-action${isFavorite ? " is-active" : ""}`}
              aria-pressed={isFavorite}
              onClick={onToggleFavorite}
            >
              <Star size={16} aria-hidden="true" fill={isFavorite ? "currentColor" : "none"} /> Favorite
            </button>
          )}
          {!isGroup && conversation.username && (
            <button type="button" className="info-action" onClick={() => void copyUsername()}>
              <Copy size={16} aria-hidden="true" /> Copy
            </button>
          )}
        </div>

        <section className="info-section" aria-labelledby="info-about">
          <h3 id="info-about">About</h3>
          {isGroup ? (
            <p className={topic ? "info-text" : "info-empty"}>{topic ?? "No description has been set."}</p>
          ) : (
            <p className={conversation.about ? "info-text" : "info-empty"}>
              {conversation.about ?? "This contact has not added a bio."}
            </p>
          )}
        </section>

        {isGroup && (
          <section className="info-section" aria-labelledby="info-members">
            <h3 id="info-members">Members <span className="info-count">{members.length}</span></h3>
            <ul className="info-members">
              {members.map((member) => (
                <li key={member.userId}>
                  <UserAvatar
                    name={member.name}
                    initials={initialsOf(member.name)}
                    size="sm"
                    avatarUrl={member.avatarUrl}
                    matrixToken={token}
                  />
                  <span className="info-member-name">{member.name}</span>
                  {member.role !== "member" && <span className="info-role">{member.role === "admin" ? "Admin" : "Moderator"}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="info-section" aria-labelledby="info-media">
          <h3 id="info-media">Shared media <span className="info-count">{shared.images.length}</span></h3>
          <SharedMediaGallery items={shared.images} token={token} />
        </section>

        <section className="info-section" aria-labelledby="info-files">
          <h3 id="info-files">Files &amp; links <span className="info-count">{shared.files.length + shared.links.length}</span></h3>
          {shared.files.length === 0 && shared.links.length === 0 ? (
            <p className="info-empty">No files or links in loaded history.</p>
          ) : (
            <>
              <ul className="info-file-list">
                {files.map((item) => (
                  <FileRow key={item.eventId} item={item} token={token} onError={(message) => onNotify(message, "error")} />
                ))}
                {links.map((link) => (
                  <li className="info-file-row" key={link.url}>
                    <span className="info-file-icon"><Link2 size={20} aria-hidden="true" /></span>
                    <span className="info-file-copy">
                      <strong title={link.url}>{new URL(link.url).hostname}</strong>
                      <small>{link.url}</small>
                    </span>
                    <a
                      className="header-icon-button"
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${link.url}`}
                    >
                      <ExternalLink size={16} />
                    </a>
                  </li>
                ))}
              </ul>
              {hasMoreFiles && (
                <button type="button" className="info-link-button" aria-expanded={showAllFiles} onClick={() => setShowAllFiles((value) => !value)}>
                  {showAllFiles ? "Show fewer" : "Show all"}
                </button>
              )}
            </>
          )}
        </section>

        <section className="info-section" aria-labelledby="info-starred">
          <h3 id="info-starred">Starred messages <span className="info-count">{starred.length}</span></h3>
          {starred.length === 0 ? (
            <p className="info-empty">No starred messages in this conversation.</p>
          ) : (
            <ul className="info-starred">
              {starred.map((entry) => (
                <li key={entry.eventId}>
                  <button type="button" onClick={() => onOpenMessage(entry.eventId)}>
                    <Star size={14} aria-hidden="true" fill="currentColor" />
                    <span>
                      <strong>{entry.senderName ?? "Message"}</strong>
                      <small>{entry.text || (entry.text === undefined ? "Open to load this message" : "Attachment")}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="info-history-note">
          Media, files and links come from loaded message history.
          {canLoadOlder && (
            <button type="button" className="info-link-button" onClick={onLoadOlder} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Load older messages"}
            </button>
          )}
        </p>
      </div>
    </aside>
  );
}
