import { ChevronDown, Plus, Star } from "lucide-react";
import { useMemo, useState } from "react";

import { SearchInput } from "../SearchInput";
import { ChannelListItem } from "./ChannelListItem";
import type { ChannelEntry } from "../../hooks/useChannels";

export type ChannelFilter = "all" | "mine" | "unread" | "favorites";

interface ChannelSidebarProps {
  entries: ChannelEntry[];
  selectedId?: string;
  matrixToken?: string | null;
  favoriteRoomIds: ReadonlySet<string>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  joiningId: string | null;
  onSelect: (channelId: string) => void;
  onJoin: (channelId: string) => void;
  onCreate: () => void;
  onRetry: () => void;
}

export function matchesChannelQuery(entry: ChannelEntry, query: string): boolean {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  return (
    entry.channel.name.toLowerCase().includes(value) ||
    entry.channel.description.toLowerCase().includes(value) ||
    entry.channel.category.toLowerCase().includes(value) ||
    (entry.room?.latestPreview ?? "").toLowerCase().includes(value)
  );
}

export function sortByActivity(entries: ChannelEntry[]): ChannelEntry[] {
  return [...entries].sort(
    (left, right) =>
      (right.room?.lastActivity.getTime() ?? 0) - (left.room?.lastActivity.getTime() ?? 0) ||
      left.channel.name.localeCompare(right.channel.name),
  );
}

export function ChannelSidebar({
  entries,
  selectedId,
  matrixToken,
  favoriteRoomIds,
  loading,
  loaded,
  error,
  joiningId,
  onSelect,
  onJoin,
  onCreate,
  onRetry,
}: ChannelSidebarProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChannelFilter>("all");
  const [collapsed, setCollapsed] = useState({ mine: false, others: false });

  const mine = useMemo(() => sortByActivity(entries.filter((entry) => entry.member)), [entries]);
  const others = useMemo(
    () =>
      [...entries.filter((entry) => !entry.member)].sort(
        (a, b) => b.channel.member_count - a.channel.member_count || a.channel.name.localeCompare(b.channel.name),
      ),
    [entries],
  );
  const unreadCount = mine.filter((entry) => (entry.room?.unreadCount ?? 0) > 0).length;

  const visibleMine = mine.filter((entry) => {
    if (!matchesChannelQuery(entry, query)) return false;
    if (filter === "unread") return (entry.room?.unreadCount ?? 0) > 0;
    if (filter === "favorites") return Boolean(entry.channel.matrix_room_id && favoriteRoomIds.has(entry.channel.matrix_room_id));
    return true;
  });
  const visibleOthers = filter === "all" ? others.filter((entry) => matchesChannelQuery(entry, query)) : [];

  const filters: { id: ChannelFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "mine", label: "Mine" },
    { id: "unread", label: "Unread" },
    { id: "favorites", label: "Favourites" },
  ];

  const nothingVisible = visibleMine.length === 0 && visibleOthers.length === 0;
  const emptyText = query
    ? "No communities match your search."
    : filter === "unread"
      ? "No unread announcements."
      : filter === "favorites"
        ? "No favourite communities yet. Star a community to keep it here."
        : filter === "mine"
          ? "You have not joined any community yet. Browse All to find one, or create your own."
          : "No communities yet. Create the first one for your team.";

  const renderSection = (key: "mine" | "others", label: string, items: ChannelEntry[]) => (
    <section className="conversation-section" aria-label={label}>
      <button
        type="button"
        className="sidebar-section-toggle"
        aria-expanded={!collapsed[key]}
        onClick={() => setCollapsed((value) => ({ ...value, [key]: !value[key] }))}
      >
        <ChevronDown size={16} aria-hidden="true" className={collapsed[key] ? "is-collapsed" : undefined} />
        {label}
      </button>
      {!collapsed[key] &&
        items.map((entry) => (
          <ChannelListItem
            key={entry.channel.id}
            entry={entry}
            selected={selectedId === entry.channel.id}
            matrixToken={matrixToken}
            onSelect={onSelect}
            onJoin={onJoin}
            joining={joiningId === entry.channel.id}
          />
        ))}
    </section>
  );

  return (
    <aside className="conversation-sidebar channel-sidebar" aria-label="Communities">
      <header className="sidebar-header">
        <h1 className="sidebar-title">Communities</h1>
        <div className="sidebar-actions">
          <button type="button" className="new-chat-button" onClick={onCreate} aria-label="Create community">
            <Plus size={18} aria-hidden="true" />
            Create community
          </button>
        </div>
      </header>

      <div className="sidebar-search-wrap">
        <SearchInput value={query} onChange={setQuery} placeholder="Search communities..." label="Search communities" />
      </div>

      <div className="filter-chips" role="group" aria-label="Filter communities">
        {filters.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`filter-chip${filter === id ? " is-active" : ""}`}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {id === "favorites" && <Star size={14} aria-hidden="true" />}
            {label}
            {id === "unread" && unreadCount > 0 && (
              <span className="filter-chip-count" aria-label={`${unreadCount} communities with unread announcements`}>
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="conversation-scroll">
        {!loaded && loading ? (
          <p className="sidebar-empty" role="status">Loading communities…</p>
        ) : !loaded && error ? (
          <div className="sidebar-empty is-error" role="alert">
            {error}{" "}
            <button type="button" className="link-button" onClick={onRetry}>Retry</button>
          </div>
        ) : (
          <>
            {visibleMine.length > 0 && renderSection("mine", filter === "all" ? "My communities" : "Communities", visibleMine)}
            {visibleOthers.length > 0 && renderSection("others", visibleMine.length > 0 ? "More communities" : "All communities", visibleOthers)}
            {nothingVisible && <p className="sidebar-empty">{emptyText}</p>}
          </>
        )}
      </div>
    </aside>
  );
}
