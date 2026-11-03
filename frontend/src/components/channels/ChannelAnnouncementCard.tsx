import { Clock3, Image as ImageIcon, LoaderCircle, RotateCcw, SmilePlus } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { AttachmentCard } from "../chat/AttachmentCard";
import { MAX_ATTACHMENT_BYTES } from "../../services/matrix/attachments";
import { fetchMatrixMedia } from "../../services/matrix/media";
import { ChannelAvatar } from "./ChannelAvatar";
import { renderAnnouncementBody } from "./announcementFormat";
import { formatClock } from "./channelMeta";
import { QUICK_REACTIONS } from "../../services/matrix/channels";
import type { Announcement, Attachment, ChannelCategory } from "../../types";

/** Full-width announcement image, fetched through the authenticated media endpoint. */
function AnnouncementImage({ attachment, matrixToken }: { attachment: Attachment; matrixToken?: string | null }) {
  const [source, setSource] = useState<string | null>(attachment.url ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!attachment.mediaUri || !matrixToken) {
      setSource(attachment.url ?? null);
      return undefined;
    }
    let active = true;
    let objectUrl: string | null = null;
    void fetchMatrixMedia(matrixToken, attachment.mediaUri, MAX_ATTACHMENT_BYTES)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([blob], { type: attachment.mimeType || "image/png" }));
        setSource(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.mediaUri, attachment.mimeType, attachment.url, matrixToken]);
  if (source && !failed) {
    return <img className="announcement-image" src={source} alt={attachment.name} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  }
  return (
    <div className="announcement-image-placeholder" role="img" aria-label={attachment.name}>
      {failed ? <ImageIcon size={20} /> : <LoaderCircle size={20} className="spin" />}
      <span>{failed ? "Image unavailable" : "Loading image…"}</span>
    </div>
  );
}

export interface AnnouncementChannelInfo {
  name: string;
  category: ChannelCategory;
  avatarUrl: string | null;
}

interface ChannelAnnouncementCardProps {
  announcement: Announcement;
  channel: AnnouncementChannelInfo;
  matrixToken?: string | null;
  canReact: boolean;
  onToggleReaction?: (announcement: Announcement, key: string) => void;
  onRetry?: (announcement: Announcement) => void;
}

/** Memoised: a reaction or new announcement elsewhere never re-renders this card. */
export const ChannelAnnouncementCard = memo(function ChannelAnnouncementCard({
  announcement,
  channel,
  matrixToken,
  canReact,
  onToggleReaction,
  onRetry,
}: ChannelAnnouncementCardProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const confirmed = Boolean(announcement.matrix?.eventId && !announcement.matrix.eventId.startsWith("~"));
  const failed = announcement.delivery === "failed";
  const sending = announcement.delivery === "sending";

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [pickerOpen]);

  const react = (key: string) => {
    setPickerOpen(false);
    onToggleReaction?.(announcement, key);
  };

  return (
    <article
      className={`announcement${failed ? " is-failed" : ""}`}
      data-event-id={announcement.matrix?.eventId}
      aria-label={announcement.title || "Announcement"}
    >
      <ChannelAvatar name={channel.name} category={channel.category} avatarUrl={channel.avatarUrl} matrixToken={matrixToken} size="md" />
      <div className="announcement-column">
        <div className="announcement-card">
          <div className="announcement-author">
            <span className="announcement-channel-name">{channel.name}</span>
            {announcement.senderName && announcement.sender === "them" && (
              <span className="announcement-sender">· {announcement.senderName}</span>
            )}
            {announcement.sender === "me" && <span className="announcement-sender">· You</span>}
          </div>
          {announcement.title && <h3 className="announcement-title">{announcement.title}</h3>}
          {announcement.text && <div className="announcement-body">{renderAnnouncementBody(announcement.text)}</div>}
          {announcement.attachment && (
            <div className="announcement-attachment">
              {announcement.attachment.kind === "image" ? (
                <AnnouncementImage attachment={announcement.attachment} matrixToken={matrixToken} />
              ) : (
                <AttachmentCard attachment={announcement.attachment} matrixToken={matrixToken} />
              )}
            </div>
          )}
          <div className="announcement-footer">
            {failed ? (
              <span className="announcement-status is-failed">
                Not published
                {onRetry && (
                  <button type="button" className="link-button" onClick={() => onRetry(announcement)}>
                    <RotateCcw size={13} aria-hidden="true" /> Retry
                  </button>
                )}
              </span>
            ) : sending ? (
              <span className="announcement-status"><Clock3 size={13} aria-hidden="true" /> Publishing…</span>
            ) : null}
            <time className="announcement-time" dateTime={announcement.sentAt?.toISOString()}>
              {formatClock(announcement.sentAt)}
            </time>
          </div>
        </div>
        {(announcement.reactions.length > 0 || (canReact && confirmed)) && (
          <div className="announcement-reactions" aria-label="Reactions">
            {announcement.reactions.map((reaction) => (
              <button
                key={reaction.key}
                type="button"
                className={`reaction-pill${reaction.mine ? " is-mine" : ""}`}
                aria-pressed={reaction.mine}
                aria-label={`${reaction.key} ${reaction.count}${reaction.mine ? ", you reacted" : ""}`}
                disabled={!canReact}
                onClick={() => react(reaction.key)}
              >
                <span className="reaction-emoji">{reaction.key}</span>
                <span className="reaction-count">{reaction.count}</span>
              </button>
            ))}
            {canReact && confirmed && (
              <div className="reaction-add-wrap" ref={pickerRef}>
                <button
                  type="button"
                  className="reaction-pill reaction-add"
                  aria-label="Add reaction"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen((open) => !open)}
                >
                  <SmilePlus size={16} aria-hidden="true" />
                </button>
                {pickerOpen && (
                  <div className="reaction-picker" role="menu" aria-label="Quick reactions">
                    {QUICK_REACTIONS.map((emoji) => (
                      <button key={emoji} type="button" role="menuitem" onClick={() => react(emoji)} aria-label={`React with ${emoji}`}>
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
});
