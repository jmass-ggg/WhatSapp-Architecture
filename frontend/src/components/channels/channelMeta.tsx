import { Code2, Coins, Cpu, Gamepad2, GraduationCap, Hash, Megaphone, Rocket, UsersRound, type LucideIcon } from "lucide-react";

import type { ChannelCategory } from "../../types";

export const CHANNEL_CATEGORIES: { id: ChannelCategory; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Hash },
  { id: "announcements", label: "Announcements", icon: Megaphone },
  { id: "engineering", label: "Engineering", icon: Code2 },
  { id: "technology", label: "Technology", icon: Cpu },
  { id: "finance", label: "Finance", icon: Coins },
  { id: "gaming", label: "Gaming", icon: Gamepad2 },
  { id: "education", label: "Education", icon: GraduationCap },
  { id: "hr", label: "HR", icon: UsersRound },
  { id: "product", label: "Product", icon: Rocket },
];

export function categoryMeta(category: ChannelCategory) {
  return CHANNEL_CATEGORIES.find((item) => item.id === category) ?? CHANNEL_CATEGORIES[0];
}

export function memberLabel(count: number): string {
  return `${count} ${count === 1 ? "member" : "members"}`;
}

export function roleLabel(role: "owner" | "admin" | "member"): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
}

export function channelInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase() || "#";
}

export function formatClock(date?: Date): string {
  if (!date || !Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}
