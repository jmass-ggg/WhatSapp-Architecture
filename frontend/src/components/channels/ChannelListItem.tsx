import { Check } from "lucide-react";
import { memo } from "react";

import { formatActivity } from "../chat/ConversationListItem";
import { ChannelAvatar } from "./ChannelAvatar";
import { categoryMeta, memberLabel } from "./channelMeta";
import type { ChannelEntry } from "../../hooks/useChannels";

interface ChannelListItemProps {
  entry: ChannelEntry;
  selected: boolean;
  matrixToken?: string | null;
  onSelect: (channelId: string) => void;
  onJoin: (channelId: string) => void;
  joining?: boolean;
}

/** Memoised so a new announcement in one community does not re-render every row. */
export const ChannelListItem = memo(function ChannelListItem({
  entry,
  selected,
  matrixToken,
  onSelect,
  onJoin,
  joining = false,
}: ChannelListItemProps) {
  const { channel, room, member, joined } = entry;
  const pending = member && !joined;
  const preview = member
    ? pending
      ? "Joining community…"
      : room?.latestPreview || "No announcements yet"
    : channel.description || `${categoryMeta(channel.category).label} community`;
  const unread = room?.unreadCount ?? 0;
  const timestamp = joined && room?.lastActivity && room.lastActivity.getTime() > 0 ? formatActivity(room.lastActivity) : "";

  return (
    <div className="conversation-list-item">
      <div className={`community-row${selected ? " is-selected" : ""}`}>
        <button
          className="community-row-main"
          type="button"
          onClick={() => onSelect(channel.id)}
          aria-current={selected ? "page" : undefined}
          aria-label={channel.name}
        >
          <ChannelAvatar name={channel.name} category={channel.category} avatarUrl={channel.avatar_url} matrixToken={matrixToken} />
          <span className="community-row-body">
            <span className="community-row-name">{channel.name}</span>
            <span className="community-row-preview">{preview}</span>
            {!member && <span className="community-row-meta">{memberLabel(channel.member_count)}</span>}
          </span>
        </button>
        <span className="community-row-side">
          {timestamp && <span className="conversation-time">{timestamp}</span>}
          {unread > 0 && (
            <span className="unread-badge" aria-label={`${unread} unread announcements`}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
          {!member && (
            <button
              type="button"
              className="community-join-button"
              disabled={joining}
              onClick={() => onJoin(channel.id)}
              aria-label={`Join ${channel.name}`}
            >
              {joining ? "Joining…" : "Join"}
            </button>
          )}
          {pending && !joining && <span className="community-row-pending">Joining…</span>}
          {joined && unread === 0 && !timestamp && (
            <span className="community-row-joined" aria-label="Joined"><Check size={14} aria-hidden="true" /></span>
          )}
        </span>
      </div>
    </div>
  );
});
