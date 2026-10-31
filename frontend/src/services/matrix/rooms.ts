import { ReceiptType, type MatrixEvent, type Room } from "matrix-js-sdk";

import type { Conversation, Message } from "../../types";
import {
  isLegacyEncryptedRoom,
  MATRIX_CONVERSATION_MARKER_VERSION,
  MATRIX_DIRECT_MARKER_TYPE,
  MATRIX_GROUP_MARKER_TYPE,
} from "./messaging";
import { messageFromMatrixEvent } from "./events";

function memberAvatarUrl(member: ReturnType<Room["getMembers"]>[number]): string | null {
  if (member.user?.avatarUrl) return member.user.avatarUrl;
  const avatar = member.events.member?.getContent().avatar_url;
  return typeof avatar === "string" ? avatar : null;
}

function hasConversationMarker(room: Room, eventType: string): boolean {
  const content = room.currentState?.getStateEvents(eventType, "")?.getContent();
  return (
    typeof content?.version === "number" &&
    Number.isInteger(content.version) &&
    content.version >= MATRIX_CONVERSATION_MARKER_VERSION
  );
}

function memberDisplayName(
  member: ReturnType<Room["getMembers"]>[number] | null | undefined,
): string {
  if (!member) return "Group member";
  const content = member.events.member?.getContent();
  const candidates = [
    content?.displayname,
    member.rawDisplayName,
    member.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const name = candidate.trim();
    if (
      name &&
      name !== member.userId &&
      !name.includes(member.userId)
    ) {
      return name;
    }
  }
  if (!member.userId.startsWith("@")) return "Group member";
  const localpart = member.userId.slice(1).split(":", 1)[0];
  return localpart || "Group member";
}

function timelineMessages(
  room: Room,
  ownUserId: string,
  isGroup: boolean,
  recipientId?: string,
): Message[] {
  const byEventId = new Map<string, Message>();
  const events = room.getLiveTimeline().getEvents();
  const members = room.getMembers();
  const otherMembers = members.filter(
    (candidate) => candidate.userId !== ownUserId &&
      (candidate.membership === "join" || candidate.membership === "invite"),
  );
  const membersById = new Map(members.map((member) => [member.userId, member]));
  const receipt = !isGroup && recipientId
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
    if (isGroup && message.sender === "them") {
      const senderId = message.matrix?.senderId ?? event.getSender() ?? "";
      message.senderName = memberDisplayName(
        room.getMember?.(senderId) ?? membersById.get(senderId),
      );
    } else if (!isGroup) {
      const senderId = event.getSender();
      const member = senderId ? membersById.get(senderId) : undefined;
      const friendlyName = member?.name && !member.name.startsWith("@")
        ? member.name
        : undefined;
      message.senderName = message.sender === "me"
        ? "You"
        : friendlyName || (otherMembers.length === 1 ? "Contact" : "A participant");
    }
    if (!isGroup && message.sender === "me" && message.delivery === "sent" &&
      receiptIndex >= index &&
      !event.getId()?.startsWith("~")) {
      message.delivery = "read";
      if (readAt) message.readAt = readAt;
    }
    byEventId.set(message.id, message);
  }
  for (const message of byEventId.values()) {
    if (!message.replyTo?.eventId) continue;
    const original = byEventId.get(message.replyTo.eventId);
    message.replyTo = original
      ? { eventId: message.replyTo.eventId, sender: original.sender === "me" ? "You" : original.senderName || "Unknown", text: original.text || original.attachment?.name || "Message unavailable" }
      : { eventId: message.replyTo.eventId, sender: "Original message", text: "Original message unavailable" };
  }
  return [...byEventId.values()]
    .sort((left, right) => (left.sentAt?.getTime() ?? 0) - (right.sentAt?.getTime() ?? 0))
    .slice(-100);
}

function latestVisibleEvent(room: Room): MatrixEvent | undefined {
  return [...room.getLiveTimeline().getEvents()]
    .reverse()
    .find((event) =>
      event.getType() === "m.room.message",
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
  const hasGroupMarker = hasConversationMarker(room, MATRIX_GROUP_MARKER_TYPE);
  const hasDirectMarker = hasConversationMarker(room, MATRIX_DIRECT_MARKER_TYPE);
  const isGroup = hasGroupMarker || (!hasDirectMarker && members.length > 1);
  const name =
    room.name?.trim() ||
    (isGroup ? "Unnamed group" : members[0]?.name) ||
    room.guessDMUserId() ||
    "New conversation";
  const messages = timelineMessages(
    room,
    ownUserId,
    isGroup,
    !isGroup && members.length === 1 && members[0].membership === "join"
      ? members[0].userId
      : undefined,
  );
  const latest = messages.at(-1);
  const typingNames = members
    .filter((member) => member.membership === "join" && member.typing)
    .map(memberDisplayName);
  const typing = typingNames.length > 0;
  const lastEvent = latestVisibleEvent(room);
  const lastActivity = lastEvent?.getTs() ?? room.getLastActiveTimestamp();
  const latestText = latest?.text || latest?.attachment?.name;
  const lastMessage = latestText
    ? isGroup
      ? `${latest?.sender === "me" ? "You" : latest?.senderName || "Group member"}: ${latestText}`
      : latestText
    : isGroup
        ? "No messages yet"
        : "Start a conversation";

  return {
    id: room.roomId,
    roomId: room.roomId,
    name,
    matrixUserId: isGroup ? undefined : members[0]?.userId,
    initials: name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "??",
    avatarUrl: isGroup
      ? room.getMxcAvatarUrl?.() ?? null
      : members[0]
        ? memberAvatarUrl(members[0])
        : null,
    accent: Math.abs(room.roomId.length * 13) % 6,
    isTyping: typing,
    typingNames,
    lastMessage,
    lastMessageDelivery: latest?.sender === "me" ? latest.delivery : undefined,
    updatedAt:
      latest?.sentAt ??
      new Date(Number.isFinite(lastActivity) && Math.abs(lastActivity) <= 8.64e15
        ? lastActivity
        : 0),
    unreadCount: room.getUnreadNotificationCount() ?? 0,
    messages,
    bio: isGroup
      ? `${members.length + 1} members in this group`
      : "Matrix conversation",
    isGroup,
    isInvited: room.getMyMembership?.() === "invite",
  };
}

/** Room IDs of retired (encrypted) rooms the user is still a member of. IDs only. */
export function legacyEncryptedRoomIds(rooms: Room[]): string[] {
  return rooms
    .filter((room) => ["join", "invite"].includes(room.getMyMembership()))
    .filter(isLegacyEncryptedRoom)
    .map((room) => room.roomId);
}

/** Deterministic primary: joined over invited, then has history, newest activity, lowest room ID. */
function comparePrimaryDirect(left: Conversation, right: Conversation): number {
  return (
    Number(left.isInvited) - Number(right.isInvited) ||
    Number(right.messages.length > 0) - Number(left.messages.length > 0) ||
    right.updatedAt.getTime() - left.updatedAt.getTime() ||
    (left.roomId ?? left.id).localeCompare(right.roomId ?? right.id)
  );
}

/**
 * Keeps one direct conversation per Matrix peer (identified by Matrix user ID, never by
 * display name). Extra rooms are only hidden from the list; nothing is left, forgotten or
 * deleted, so their history stays on the server. Groups are never touched.
 */
export function collapseDuplicateDirects(conversations: Conversation[]): Conversation[] {
  const primary = new Map<string, Conversation>();
  for (const conversation of conversations) {
    if (conversation.isGroup || !conversation.matrixUserId) continue;
    const current = primary.get(conversation.matrixUserId);
    if (!current || comparePrimaryDirect(conversation, current) < 0) {
      primary.set(conversation.matrixUserId, conversation);
    }
  }
  return conversations.filter(
    (conversation) =>
      conversation.isGroup ||
      !conversation.matrixUserId ||
      primary.get(conversation.matrixUserId) === conversation,
  );
}

export function conversationsFromMatrixClient(
  rooms: Room[],
  ownUserId: string,
): Conversation[] {
  const conversations = rooms
    .filter((room) => ["join", "invite"].includes(room.getMyMembership()))
    .filter((room) => !isLegacyEncryptedRoom(room))
    .map((room) => conversationFromMatrixRoom(room, ownUserId))
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  return collapseDuplicateDirects(conversations);
}

/** Existing joined or invited plaintext direct room with this peer, if any. */
export function findDirectRoomId(
  rooms: Room[],
  ownUserId: string,
  peerMatrixUserId: string,
): string | undefined {
  return conversationsFromMatrixClient(rooms, ownUserId).find(
    (conversation) => !conversation.isGroup && conversation.matrixUserId === peerMatrixUserId,
  )?.roomId;
}
