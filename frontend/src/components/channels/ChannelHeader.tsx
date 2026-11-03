import { ArrowLeft, BadgeCheck, Check, Crown, EllipsisVertical, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ChannelAvatar } from "./ChannelAvatar";
import { categoryMeta, memberLabel } from "./channelMeta";
import type { Channel } from "../../types";

interface ChannelHeaderProps {
  channel: Channel;
  matrixToken?: string | null;
  /** Backend membership exists (joined or being joined). */
  member: boolean;
  /** Membership confirmed on the backend and in the Matrix room. */
  joined: boolean;
  joining: boolean;
  isFavorite: boolean;
  canFavorite: boolean;
  onToggleFavorite: () => void;
  onLeave: () => void;
  onJoin: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onBack: () => void;
}

export function ChannelHeader({
  channel,
  matrixToken,
  member,
  joined,
  joining,
  isFavorite,
  canFavorite,
  onToggleFavorite,
  onLeave,
  onJoin,
  onEdit,
  onArchive,
  onBack,
}: ChannelHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const category = categoryMeta(channel.category);
  const isOwner = channel.membership?.role === "owner" && member;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const act = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  return (
    <header className="chat-header channel-header">
      <button type="button" className="mobile-back-button" onClick={onBack} aria-label="Back to communities">
        <ArrowLeft size={20} />
      </button>
      <div className="chat-header-identity channel-header-identity">
        <ChannelAvatar name={channel.name} category={channel.category} avatarUrl={channel.avatar_url} matrixToken={matrixToken} size="lg" />
        <div className="chat-header-person channel-header-text">
          <h1>
            <span className="channel-header-name">{channel.name}</span>
            {channel.is_verified && (
              <BadgeCheck size={22} className="channel-verified" aria-label="Verified community" role="img" />
            )}
          </h1>
          <span className="channel-header-subtitle" title={channel.description || undefined}>
            {memberLabel(channel.member_count)} · {category.label}
            {channel.description ? ` · ${channel.description}` : ""}
          </span>
        </div>
      </div>
      <div className="chat-header-actions">
        {isOwner ? (
          <span className="community-owner-badge" title="You own this community">
            <Crown size={15} aria-hidden="true" /> Owner
          </span>
        ) : joined ? (
          <button type="button" className="community-joined-button" onClick={onLeave} title="Leave community" aria-label="Joined. Leave community">
            <Check size={16} aria-hidden="true" /><span>Joined</span>
          </button>
        ) : (
          <button type="button" className="primary-button community-header-join" disabled={joining || member} onClick={onJoin}>
            {joining || member ? "Joining…" : "Join"}
          </button>
        )}
        <button
          type="button"
          className={`icon-button channel-star${isFavorite ? " is-active" : ""}`}
          aria-label={isFavorite ? "Remove from favourites" : "Add to favourites"}
          aria-pressed={isFavorite}
          title={canFavorite ? (isFavorite ? "Remove from favourites" : "Add to favourites") : "Join to favourite this community"}
          disabled={!canFavorite}
          onClick={onToggleFavorite}
        >
          <Star size={22} fill={isFavorite ? "currentColor" : "none"} />
        </button>
        <div className="channel-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="icon-button"
            aria-label="More options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <EllipsisVertical size={22} />
          </button>
          {menuOpen && (
            <div className="channel-menu" role="menu">
              {joined && !isOwner && <button type="button" role="menuitem" onClick={act(onLeave)}>Leave community</button>}
              {!member && <button type="button" role="menuitem" onClick={act(onJoin)}>Join community</button>}
              {channel.can_edit && <button type="button" role="menuitem" onClick={act(onEdit)}>Edit community</button>}
              {channel.can_edit && (
                <button type="button" role="menuitem" className="is-danger" onClick={act(onArchive)}>Archive community</button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
