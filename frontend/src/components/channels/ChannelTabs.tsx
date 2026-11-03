import { FileText, Info, Link2, MessageCircle, UsersRound, type LucideIcon } from "lucide-react";

export type ChannelTab = "messages" | "files" | "links" | "members" | "about";

interface ChannelTabsProps {
  active: ChannelTab;
  memberCount: number;
  onChange: (tab: ChannelTab) => void;
}

const TABS: { id: ChannelTab; label: string; icon: LucideIcon }[] = [
  { id: "messages", label: "Messages", icon: MessageCircle },
  { id: "files", label: "Files", icon: FileText },
  { id: "links", label: "Links", icon: Link2 },
  { id: "members", label: "Members", icon: UsersRound },
  { id: "about", label: "About", icon: Info },
];

export function ChannelTabs({ active, memberCount, onChange }: ChannelTabsProps) {
  return (
    <div className="channel-tabs" role="tablist" aria-label="Channel sections">
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`channel-tab-${id}`}
          aria-selected={active === id}
          aria-controls={`channel-panel-${id}`}
          className={`channel-tab${active === id ? " is-active" : ""}`}
          onClick={() => onChange(id)}
        >
          <Icon size={18} aria-hidden="true" />
          <span>{id === "members" ? `Members (${memberCount})` : label}</span>
        </button>
      ))}
    </div>
  );
}
