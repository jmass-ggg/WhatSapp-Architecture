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

/**
 * Synapse's invite stripped state only carries create/name/avatar/join_rules/etc., so our custom
 * group marker and the other members are absent. The invite's own member event is present, though:
 * the app always sets `is_direct: true` on direct invites. A named invite that is not flagged
 * direct is therefore a group (groups require a name; app-created directs never have one).
 */
function isUnmarkedGroupInvite(room: Room, ownUserId: string): boolean {
  if (room.getMyMembership?.() !== "invite") return false;
  if (!room.name?.trim()) return false;
  const content = room.currentState?.getStateEvents("m.room.member", ownUserId)?.getContent();
  return content?.membership === "invite" && content.is_direct !== true;
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

/** Only the newest messages are rendered, so older timeline events are never converted. */
export const MAX_VISIBLE_MESSAGES = 100;

/**
 * Per-room identity cache: a message whose visible fields did not change keeps the exact same
 * object across refreshes, so memoised bubbles skip re-rendering on typing, receipt and
 * unrelated-message updates. Entries for messages that left the window are pruned each refresh.
 */
const messageIdentityCache = new WeakMap<object, Map<string, Message>>();

function sameTime(left?: Date, right?: Date): boolean {
  return (left?.getTime() ?? Number.NaN) === (right?.getTime() ?? Number.NaN) || (!left && !right);
}

/** True when every field a bubble renders is equal, so the previous object can be reused. */
function sameVisibleMessage(previous: Message, next: Message): boolean {
  if (
    previous.id !== next.id ||
    previous.matrix?.eventId !== next.matrix?.eventId ||
    previous.sender !== next.sender ||
    previous.senderName !== next.senderName ||
    previous.text !== next.text ||
    previous.delivery !== next.delivery ||
    previous.mentionsMe !== next.mentionsMe ||
    !sameTime(previous.sentAt, next.sentAt) ||
    !sameTime(previous.readAt, next.readAt)
  ) return false;
  const pr = previous.replyTo, nr = next.replyTo;
  if (Boolean(pr) !== Boolean(nr) || (pr && nr && (pr.eventId !== nr.eventId || pr.sender !== nr.sender || pr.text !== nr.text))) return false;
  const pa = previous.attachment, na = next.attachment;
  if (Boolean(pa) !== Boolean(na) || (pa && na && (
    pa.name !== na.name || pa.size !== na.size || pa.mimeType !== na.mimeType || pa.kind !== na.kind ||
    pa.mediaUri !== na.mediaUri || pa.url !== na.url || pa.durationMs !== na.durationMs
  ))) return false;
  const px = previous.reaction, nx = next.reaction;
  if (Boolean(px) !== Boolean(nx) || (px && nx && (px.emoji !== nx.emoji || px.count !== nx.count))) return false;
  const ps = previous.segments, ns = next.segments;
  if (Boolean(ps) !== Boolean(ns)) return false;
  if (ps && ns) {
    if (ps.length !== ns.length) return false;
    for (let i = 0; i < ps.length; i++) if (ps[i].text !== ns[i].text || ps[i].userId !== ns[i].userId) return false;
  }
  return true;
}

function stabilizeIdentities(room: Room, messages: Message[]): Message[] {
  let cache = messageIdentityCache.get(room);
  if (!cache) {
    cache = new Map();
    messageIdentityCache.set(room, cache);
  }
  const keep = new Set<string>();
  const result = messages.map((message) => {
    keep.add(message.id);
    const cached = cache.get(message.id);
    if (cached && sameVisibleMessage(cached, message)) return cached;
    cache.set(message.id, message);
    return message;
  });
  for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
  return result;
}

function timelineMessages(
  room: Room,
  ownUserId: string,
  isGroup: boolean,
  recipientId?: string,
): Message[] {
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
  const readAt = receipt && Number.isFinite(receipt.data.ts) &&
    Math.abs(receipt.data.ts) <= 8.64e15
    ? new Date(receipt.data.ts)
    : undefined;
  const decorate = (message: Message, event: MatrixEvent) => {
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
  };

  const byId = new Map<string, Message>();
  const byEventId = new Map<string, Message>();
  // Ids of own messages still in any sending phase (queued, sending, acknowledged but not yet
  // echoed back by sync, failed): their timestamps are local, not the server's.
  const localIds = new Set<string>();
  // The peer's receipt marks that event and everything older as read.
  let readFromHere = false;
  // Newest first; stop once the visible window is full so a long timeline costs nothing extra.
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (receipt && !readFromHere && event.getId() === receipt.eventId) readFromHere = true;
    const message = messageFromMatrixEvent(event, room.roomId, ownUserId);
    if (!message) continue;
    const duplicate = byId.get(message.id);
    if (duplicate) {
      // Same id again, older in the timeline: keep the newest data at the oldest position.
      byId.delete(message.id);
      byId.set(message.id, duplicate);
      continue;
    }
    decorate(message, event);
    if (event.status) localIds.add(message.id);
    if (!isGroup && message.sender === "me" && message.delivery === "sent" &&
      readFromHere && !event.getId()?.startsWith("~")) {
      message.delivery = "read";
      if (readAt) message.readAt = readAt;
    }
    byId.set(message.id, message);
    if (message.matrix?.eventId) byEventId.set(message.matrix.eventId, message);
    if (byId.size >= MAX_VISIBLE_MESSAGES) break;
  }

  const resolveOriginal = (eventId: string): Message | undefined => {
    const inWindow = byEventId.get(eventId);
    if (inWindow) return inWindow;
    // Older than the window: look the event up directly instead of converting the whole timeline.
    const event = room.findEventById?.(eventId);
    const original = event ? messageFromMatrixEvent(event, room.roomId, ownUserId) : null;
    if (original && event) decorate(original, event);
    return original ?? undefined;
  };
  for (const message of byId.values()) {
    if (!message.replyTo?.eventId) continue;
    const original = resolveOriginal(message.replyTo.eventId);
    message.replyTo = original
      ? { eventId: message.replyTo.eventId, sender: original.sender === "me" ? "You" : original.senderName || "Unknown", text: original.text || original.attachment?.name || "Message unavailable" }
      : { eventId: message.replyTo.eventId, sender: "Original message", text: "Original message unavailable" };
  }
  // Collected newest-first: restore timeline order, then order messages that carry a server
  // timestamp by it with a stable sort (the order both participants see, also after a reload).
  // Own messages still in a sending phase keep their timeline order *after* every such message:
  // they only have local timestamps (the SDK keeps the local one even after the send response,
  // until the sync echo arrives), so sorting them in with the rest would make a just-echoed
  // message, whose server timestamp is later than the local ones of the echoes sent after it,
  // jump below them on every acknowledgment.
  const ordered = [...byId.values()].reverse();
  const confirmed: Message[] = [];
  const pending: Message[] = [];
  for (const message of ordered) (localIds.has(message.id) ? pending : confirmed).push(message);
  confirmed.sort((left, right) => (left.sentAt?.getTime() ?? 0) - (right.sentAt?.getTime() ?? 0));
  return stabilizeIdentities(room, pending.length ? confirmed.concat(pending) : confirmed);
}

function latestVisibleEvent(room: Room): MatrixEvent | undefined {
  const events = room.getLiveTimeline().getEvents();
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].getType() === "m.room.message") return events[index];
  }
  return undefined;
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
  const isGroup =
    hasGroupMarker ||
    (!hasDirectMarker && (members.length > 1 || isUnmarkedGroupInvite(room, ownUserId)));
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
      ? `${members.filter((m) => m.membership === "join").length + (room.getMyMembership?.() === "join" ? 1 : 0)} members in this group${members.some((m) => m.membership === "invite") ? ` · ${members.filter((m) => m.membership === "invite").length} invited` : ""}`
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

/** Per-room conversation cache so unchanged rooms keep a stable object identity. */
export class ConversationCache {
  readonly byRoom = new Map<string, Conversation>();
  private dirty = new Set<string>();
  private all = true;
  markRoom(roomId: string | null | undefined): void {
    if (roomId) this.dirty.add(roomId);
    else this.all = true;
  }
  markAll(): void {
    this.all = true;
  }
  consume(): { all: boolean; dirty: Set<string> } {
    const state = { all: this.all, dirty: this.dirty };
    this.all = false;
    this.dirty = new Set();
    return state;
  }
}

export function conversationsFromMatrixClient(
  rooms: Room[],
  ownUserId: string,
  cache?: ConversationCache,
): Conversation[] {
  const visible = rooms
    .filter((room) => ["join", "invite"].includes(room.getMyMembership()))
    .filter((room) => !isLegacyEncryptedRoom(room));
  let conversations: Conversation[];
  if (cache) {
    const { all, dirty } = cache.consume();
    const live = new Set<string>();
    conversations = visible.map((room) => {
      live.add(room.roomId);
      let conversation = cache.byRoom.get(room.roomId);
      if (all || dirty.has(room.roomId) || !conversation) {
        conversation = conversationFromMatrixRoom(room, ownUserId);
        cache.byRoom.set(room.roomId, conversation);
      }
      return conversation;
    });
    for (const id of [...cache.byRoom.keys()]) if (!live.has(id)) cache.byRoom.delete(id);
  } else {
    conversations = visible.map((room) => conversationFromMatrixRoom(room, ownUserId));
  }
  return collapseDuplicateDirects(
    [...conversations].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()),
  );
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
