import { Hash, MessageSquare, MessageCircle, Settings, UserRound, UsersRound, type LucideIcon } from "lucide-react";

import { UserAvatar } from "./UserAvatar";
import type { MatrixSession, PresenceState, UserProfile } from "../types";

export type NavSection = "chats" | "groups" | "channels" | "contacts" | "settings";

interface NavItem {
  id: NavSection;
  label: string;
  icon: LucideIcon;
  /** Sections without a built view are shown but disabled instead of acting as dead buttons. */
  available: boolean;
}

const items: NavItem[] = [
  { id: "chats", label: "Chats", icon: MessageSquare, available: true },
  { id: "groups", label: "Groups", icon: UsersRound, available: false },
  { id: "channels", label: "Channels", icon: Hash, available: false },
  { id: "contacts", label: "Contacts", icon: UserRound, available: false },
  { id: "settings", label: "Settings", icon: Settings, available: false },
];

interface NavigationRailProps {
  active: NavSection;
  currentUser: UserProfile;
  matrixSession: MatrixSession | null;
  presence?: PresenceState;
  onNavigate: (section: NavSection) => void;
}

function initialsFor(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function NavigationRail({ active, currentUser, matrixSession, presence, onNavigate }: NavigationRailProps) {
  const name = currentUser.profile.display_name || currentUser.username;
  return (
    <nav className="nav-rail" aria-label="Primary">
      <span className="nav-rail-logo" aria-hidden="true">
        <MessageCircle size={22} strokeWidth={2.4} />
      </span>
      <ul className="nav-rail-items">
        {items.map(({ id, label, icon: Icon, available }) => (
          <li key={id}>
            <button
              type="button"
              className="nav-rail-item"
              aria-label={available ? label : `${label} (not available yet)`}
              aria-current={active === id ? "page" : undefined}
              disabled={!available}
              title={available ? label : `${label} is not available yet`}
              onClick={() => onNavigate(id)}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="nav-rail-user">
        <UserAvatar
          name={name}
          initials={initialsFor(name)}
          size="sm"
          avatarUrl={currentUser.profile.profile_picture_url}
          matrixToken={matrixSession?.access_token}
          presence={presence}
        />
      </div>
    </nav>
  );
}
