import { ReceiptType, type MatrixEvent, type Room } from "matrix-js-sdk";

import type { Conversation, Message } from "../../types";
import { messageFromMatrixEvent } from "./events";

function memberAvatarUrl(member: ReturnType<Room["getMembers"]>[number]): string | null {
  if (member.user?.avatarUrl) return member.user.avatarUrl;
  const avatar = member.events.member?.getContent().avatar_url;
  return typeof avatar === "string" ? avatar : null;
}

function timelineMessages(room: Room, ownUserId: string, recipientId?: string): Message[] {
  const byEventId = new Map<string, Message>();
  const events = room.getLiveTimeline().getEvents();
  const receipt = recipientId
    ? room.getReadReceiptForUserId?.(recipientId, true, ReceiptType.Read)
    : null;
  const receiptIndex = receipt
    ? events.findIndex((event) => event.getId() === receipt.eventId)
    : -1;
  const readAt = receipt && Number.isFinite(receipt.data.ts) &&
    Math.abs(receipt.data.ts) <= 8.64e15
    ? new Date(receipt.data.ts)
    : undefined;
  for (const [index, event] of events.entries()) {
    const message = messageFromMatrixEvent(event, room.roomId, ownUserId);
    if (!message) continue;
    if (message.sender === "me" && message.delivery === "sent" &&
      receiptIndex >= index &&
      !event.getId()?.startsWith("~")) {
      message.delivery = "read";
      if (readAt) message.readAt = readAt;
    }
    byEventId.set(message.id, message);
  }
  return [...byEventId.values()]
    .sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime())
    .slice(-100);
}

function latestVisibleEvent(room: Room): MatrixEvent | undefined {
  return [...room.getLiveTimeline().getEvents()]
    .reverse()
    .find((event) =>
      ["m.room.message", "m.room.encrypted"].includes(event.getType()),
    );
}

export function conversationFromMatrixRoom(
  room: Room,
  ownUserId: string,
): Conversation {
  const members = room
    .getMembers()
    .filter(
      (member) =>
        member.userId !== ownUserId &&
        (member.membership === "join" || member.membership === "invite"),
    );
  const name =
    room.name?.trim() ||
    members[0]?.name ||
    room.guessDMUserId() ||
    "New conversation";
  const messages = timelineMessages(room, ownUserId,
    members.length === 1 && members[0].membership === "join"
      ? members[0].userId : undefined);
  const latest = messages.at(-1);
  const isEncrypted = room.hasEncryptionStateEvent();
  const typing = members.some((member) => member.typing);
  const lastEvent = latestVisibleEvent(room);
  const lastActivity = lastEvent?.getTs() ?? room.getLastActiveTimestamp();

  return {
    id: room.roomId,
    roomId: room.roomId,
    name,
    matrixUserId: members[0]?.userId,
    initials: name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "??",
    avatarUrl: members[0] ? memberAvatarUrl(members[0]) : null,
    accent: Math.abs(room.roomId.length * 13) % 6,
    isTyping: typing,
    lastMessage:
      latest?.text ||
      latest?.attachment?.name ||
      (isEncrypted && lastEvent ? "Encrypted message" : "Start a conversation"),
    updatedAt:
      latest?.sentAt ??
      new Date(Number.isFinite(lastActivity) && Math.abs(lastActivity) <= 8.64e15
        ? lastActivity
        : 0),
    unreadCount: room.getUnreadNotificationCount() ?? 0,
    messages,
    bio:
      members.length > 1
        ? `${members.length + 1} people in this conversation`
        : "Matrix conversation",
    isDemo: false,
    isGroup: members.length > 1,
    isEncrypted,
  };
}

export function conversationsFromMatrixClient(
  rooms: Room[],
  ownUserId: string,
): Conversation[] {
  return rooms
    .filter((room) => ["join", "invite"].includes(room.getMyMembership()))
    .map((room) => conversationFromMatrixRoom(room, ownUserId))
    .filter((conversation) => !conversation.isGroup)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}
