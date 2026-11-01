import { Hash, LogOut, MessageSquare, MessageCircle, Settings, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  { id: "groups", label: "Groups", icon: UsersRound, available: true },
  { id: "channels", label: "Channels", icon: Hash, available: true },
  { id: "contacts", label: "Contacts", icon: UserRound, available: true },
  { id: "settings", label: "Settings", icon: Settings, available: false },
];

interface NavigationRailProps {
  active: NavSection;
  currentUser: UserProfile;
  matrixSession: MatrixSession | null;
  presence?: PresenceState;
  onNavigate: (section: NavSection) => void;
  onSignOut: () => void;
}

function initialsFor(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function NavigationRail({ active, currentUser, matrixSession, presence, onNavigate, onSignOut }: NavigationRailProps) {
  const name = currentUser.profile.display_name || currentUser.username;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
      <div className="nav-rail-user" ref={menuRef}>
        <button
          type="button"
          className="nav-rail-avatar"
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <UserAvatar
            name={name}
            initials={initialsFor(name)}
            size="md"
            avatarUrl={currentUser.profile.profile_picture_url}
            matrixToken={matrixSession?.access_token}
            presence={presence}
          />
        </button>
        {menuOpen && (
          <div className="nav-rail-menu" role="menu">
            <div className="nav-rail-menu-profile">
              <strong>{name}</strong>
              <span>@{currentUser.username}</span>
            </div>
            <button type="button" role="menuitem" onClick={onSignOut}>
              <LogOut size={16} aria-hidden="true" />
              Log out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
