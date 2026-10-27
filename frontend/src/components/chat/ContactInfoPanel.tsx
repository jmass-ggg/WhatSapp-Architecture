import {
  Bell,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Link2,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Wallpaper,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { UserAvatar } from "../UserAvatar";
import { AttachmentCard } from "./AttachmentCard";
import type { AuthMode, Conversation, MatrixSession } from "../../types";

type ContentTab = "Media" | "Links" | "Documents";

interface ContactInfoPanelProps {
  conversation: Conversation;
  mode: AuthMode;
  matrixSession: MatrixSession | null;
  open: boolean;
  muted: boolean;
  wallpaperOn: boolean;
  onClose: () => void;
  onToggleMute: () => void;
  onSearch: () => void;
  onToggleWallpaper: () => void;
  onClearChat: () => void;
  onStarred: () => void;
}

export function ContactInfoPanel({
  conversation,
  mode,
  matrixSession,
  open,
  muted,
  wallpaperOn,
  onClose,
  onToggleMute,
  onSearch,
  onToggleWallpaper,
  onClearChat,
  onStarred,
}: ContactInfoPanelProps) {
  const [tab, setTab] = useState<ContentTab>("Media");
  const attachments = useMemo(
    () => conversation.messages.flatMap((message) => message.attachment ? [message.attachment] : []),
    [conversation.messages],
  );
  const links = useMemo(
    () =>
      conversation.messages.flatMap((message) =>
        [...message.text.matchAll(/https?:\/\/[^\s)]+/g)].map((match) => match[0]),
      ),
    [conversation.messages],
  );
  const media = attachments.filter((attachment) => attachment.kind === "image");
  const documents = attachments.filter((attachment) => attachment.kind === "file");

  return (
    <>
      {open && <button type="button" className="drawer-scrim" aria-label="Close contact information" onClick={onClose} />}
      <aside className={`contact-info-panel${open ? " is-open" : ""}`} aria-label="Contact information">
        <header className="contact-panel-header">
          <h2>Contact Info</h2>
          <button type="button" className="icon-button" aria-label="Close contact information" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="contact-profile">
          <UserAvatar
            name={conversation.name}
            initials={conversation.initials}
            accent={conversation.accent}
            avatarUrl={conversation.avatarUrl}
            matrixToken={matrixSession?.access_token}
            size="xl"
            online={conversation.isOnline}
          />
          <h3>{conversation.name}</h3>
          {conversation.username && !conversation.isGroup && (
            <span className="contact-handle">@{conversation.username}</span>
          )}
          <p>{conversation.bio ?? (mode === "demo" ? "A friend on LumaChat." : "Matrix contact")}</p>
        </div>

        <section className="contact-section">
          <div className="contact-section-heading">
            <h3>Shared content</h3>
            <button
              type="button"
              className="subtle-action"
              onClick={() => setTab("Media")}
              aria-label="View all shared content"
            >
              View all <ChevronRight size={15} />
            </button>
          </div>
          <div className="content-tabs" role="tablist" aria-label="Shared content type">
            {(["Media", "Links", "Documents"] as const).map((item) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab === item}
                className={tab === item ? "selected" : ""}
                key={item}
                onClick={() => setTab(item)}
              >
                {item}
                <span>{item === "Media" ? media.length : item === "Links" ? links.length : documents.length}</span>
              </button>
            ))}
          </div>
          <div className={`shared-content shared-${tab.toLowerCase()}`}>
            {tab === "Media" && (
              media.length > 0 ? (
                <div className="shared-media-grid">
                  {media.slice(-4).map((attachment, index) => (
                    <div className="shared-media-item" key={`${attachment.name}-${index}`}>
                      <AttachmentCard
                        attachment={attachment}
                        matrixToken={matrixSession?.access_token}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="shared-empty"><ImageIcon size={17} /> No shared media yet</div>
              )
            )}
            {tab === "Links" && (
              links.length > 0 ? (
                <ul className="shared-link-list">
                  {links.slice(-4).map((link) => (
                    <li key={link}><Link2 size={15} /><a href={link} target="_blank" rel="noreferrer">{link}</a></li>
                  ))}
                </ul>
              ) : (
                <div className="shared-empty"><Link2 size={17} /> No shared links yet</div>
              )
            )}
            {tab === "Documents" && (
              documents.length > 0 ? (
                <div className="shared-document-list">
                  {documents.slice(-3).map((attachment, index) => (
                    <AttachmentCard
                      key={`${attachment.name}-${index}`}
                      attachment={attachment}
                      matrixToken={matrixSession?.access_token}
                    />
                  ))}
                </div>
              ) : (
                <div className="shared-empty"><FileText size={17} /> No shared documents yet</div>
              )
            )}
          </div>
        </section>

        <section className="contact-section contact-actions">
          <h3>Conversation</h3>
          <button type="button" className="contact-action-row" onClick={onSearch}>
            <Search size={17} /> <span>Search in conversation</span><ChevronRight size={15} />
          </button>
          <button type="button" className="contact-action-row" onClick={onToggleWallpaper}>
            <Wallpaper size={17} />
            <span>Chat wallpaper</span>
            <span className={`mini-toggle${wallpaperOn ? " is-on" : ""}`} aria-label={wallpaperOn ? "Enabled" : "Disabled"}><i /></span>
          </button>
          <button type="button" className="contact-action-row" onClick={onToggleMute}>
            <Bell size={17} />
            <span>{muted ? "Unmute notifications" : "Mute notifications"}</span>
            <span className={`mini-toggle${muted ? " is-on" : ""}`} aria-label={muted ? "Muted" : "Not muted"}><i /></span>
          </button>
          <button type="button" className="contact-action-row starred-row" onClick={onStarred}>
            <Star size={17} /> <span>Starred messages</span><ChevronRight size={15} />
          </button>
        </section>

        <section className="contact-section contact-danger">
          <button type="button" className="contact-action-row" onClick={onClearChat}>
            <Trash2 size={17} /> <span>Clear chat</span><ChevronRight size={15} />
          </button>
          <p><ShieldCheck size={13} /> {mode === "demo" ? "Preview only · no server history" : "Messages are stored by your Matrix homeserver"}</p>
        </section>
      </aside>
    </>
  );
}
