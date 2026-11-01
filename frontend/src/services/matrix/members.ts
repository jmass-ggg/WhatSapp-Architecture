import type { Room } from "matrix-js-sdk";

export type MemberRole = "admin" | "moderator" | "member";

export interface RoomMemberInfo {
  userId: string;
  name: string;
  role: MemberRole;
  avatarUrl?: string | null;
}

export const roleForPowerLevel = (powerLevel: number): MemberRole =>
  powerLevel >= 100 ? "admin" : powerLevel >= 50 ? "moderator" : "member";

const roleOrder: Record<MemberRole, number> = { admin: 0, moderator: 1, member: 2 };

/** Joined members with roles from room power levels; admins first, then by name. */
export function roomMembers(room: Pick<Room, "getJoinedMembers">): RoomMemberInfo[] {
  return room
    .getJoinedMembers()
    .map((member) => ({
      userId: member.userId,
      name: member.name || member.userId,
      role: roleForPowerLevel(member.powerLevel ?? 0),
      avatarUrl: member.getMxcAvatarUrl?.() ?? null,
    }))
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.name.localeCompare(b.name));
}

export function roomTopic(room: Pick<Room, "currentState">): string | undefined {
  const topic = room.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic;
  return typeof topic === "string" && topic.trim() ? topic.trim() : undefined;
}
