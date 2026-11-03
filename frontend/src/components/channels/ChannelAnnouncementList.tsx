import { Megaphone } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ChannelAnnouncementCard, type AnnouncementChannelInfo } from "./ChannelAnnouncementCard";
import type { Announcement } from "../../types";

interface ChannelAnnouncementListProps {
  channelId: string;
  channel: AnnouncementChannelInfo;
  announcements: Announcement[];
  matrixToken?: string | null;
  canReact: boolean;
  canPublish: boolean;
  joined: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onToggleReaction: (announcement: Announcement, key: string) => void;
  onRetry: (announcement: Announcement) => void;
}

function dayLabel(date?: Date): string {
  if (!date || !Number.isFinite(date.getTime())) return "Date unavailable";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date);
}

function groupByDay(items: Announcement[]) {
  const groups: { label: string; items: Announcement[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.sentAt);
    const group = groups.at(-1);
    if (group?.label === label) group.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export function ChannelAnnouncementList({
  channelId,
  channel,
  announcements,
  matrixToken,
  canReact,
  canPublish,
  joined,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onToggleReaction,
  onRetry,
}: ChannelAnnouncementListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previousLastId = useRef<string | undefined>(undefined);
  const previousFirstId = useRef<string | undefined>(undefined);
  const previousHeight = useRef(0);
  const [unreadBelow, setUnreadBelow] = useState(0);
  const groups = useMemo(() => groupByDay(announcements), [announcements]);

  const scrollToLatest = useCallback((smooth = true) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !reduced ? "smooth" : "instant" });
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    stickToBottom.current = true;
    setUnreadBelow(0);
  }, []);

  const handleScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    stickToBottom.current = near;
    if (near) setUnreadBelow(0);
  }, []);

  // New channel: start at the newest announcement.
  useLayoutEffect(() => {
    previousLastId.current = undefined;
    previousFirstId.current = undefined;
    stickToBottom.current = true;
    setUnreadBelow(0);
    scrollToLatest(false);
  }, [channelId, scrollToLatest]);

  // Keep the viewport anchored when older history is prepended; follow new announcements.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const first = announcements[0]?.id;
    const last = announcements.at(-1);
    const prepended = Boolean(previousFirstId.current && first && first !== previousFirstId.current && last?.id === previousLastId.current);
    if (scroller && prepended) {
      scroller.scrollTop += scroller.scrollHeight - previousHeight.current;
    } else if (last && previousLastId.current && last.id !== previousLastId.current) {
      if (last.sender === "me" || stickToBottom.current) scrollToLatest();
      else setUnreadBelow((count) => count + 1);
    }
    previousFirstId.current = first;
    previousLastId.current = last?.id;
    previousHeight.current = scroller?.scrollHeight ?? 0;
  }, [announcements, scrollToLatest]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    previousHeight.current = scroller.scrollHeight;
  }, [loadingOlder]);

  if (!joined) {
    return (
      <div className="announcement-scroll" id="channel-panel-messages" role="tabpanel" aria-labelledby="channel-tab-messages">
        <div className="empty-chat channel-empty">
          <span className="empty-chat-icon"><Megaphone size={28} /></span>
          <h2>Join to read announcements</h2>
          <p>Announcements are delivered to members only. Join {channel.name} to follow it.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="announcement-scroll"
      id="channel-panel-messages"
      role="tabpanel"
      aria-labelledby="channel-tab-messages"
      ref={scrollRef}
      onScroll={handleScroll}
      onLoadCapture={(event) => {
        if (event.target instanceof HTMLImageElement && stickToBottom.current) scrollToLatest(false);
      }}
    >
      {hasOlder && (
        <div className="announcement-load-older">
          <button type="button" className="secondary-button" onClick={onLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? "Loading…" : "Load older announcements"}
          </button>
        </div>
      )}
      {announcements.length === 0 ? (
        <div className="empty-chat channel-empty">
          <span className="empty-chat-icon"><Megaphone size={28} /></span>
          <h2>No announcements yet</h2>
          <p>{canPublish ? "Publish the first announcement to your members." : "Announcements from the community admins will appear here."}</p>
        </div>
      ) : (
        groups.map((group) => (
          <section className="announcement-day" key={group.label} aria-label={group.label}>
            <div className="date-separator"><span>{group.label}</span></div>
            {group.items.map((announcement) => (
              <ChannelAnnouncementCard
                key={announcement.id}
                announcement={announcement}
                channel={channel}
                matrixToken={matrixToken}
                canReact={canReact}
                onToggleReaction={onToggleReaction}
                onRetry={onRetry}
              />
            ))}
          </section>
        ))
      )}
      {unreadBelow > 0 && (
        <button type="button" className="new-messages-pill" onClick={() => scrollToLatest()}>
          {unreadBelow === 1 ? "New announcement" : `${unreadBelow} new announcements`} ↓
        </button>
      )}
    </div>
  );
}
