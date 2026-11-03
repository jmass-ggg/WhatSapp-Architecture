import { EventType, MsgType, RelationType, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/types";

import type { Announcement, AnnouncementReaction } from "../../types";
import { validateAttachment } from "./attachments";
import { messageFromMatrixEvent } from "./events";
import { hasOlderHistory } from "./history";

/**
 * Room type recorded in `m.room.create` of channel rooms (present in invite stripped state).
 * It only keeps channel rooms out of Chats and Groups; a room is shown as a channel solely
 * when the backend lists it.
 */
export const CHANNEL_ROOM_TYPE = "org.recruitable.chat.channel";
/** Content key carrying the announcement title (and caption text for attachments). */
export const ANNOUNCEMENT_CONTENT_KEY = "org.recruitable.chat.announcement";
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 4000;
/** Announcements rendered until the reader asks for older history. */
export const DEFAULT_ANNOUNCEMENT_WINDOW = 40;
export const ANNOUNCEMENT_PAGE = 40;
/** Quick reactions offered on every announcement. */
export const QUICK_REACTIONS = ["👍", "🎉", "❤️", "👏", "🔥", "👀"] as const;

type RoomLike = Pick<Room, "currentState"> & { getType?: () => string | undefined };

export function isChannelRoom(room: RoomLike): boolean {
  if (typeof room.getType === "function" && room.getType() === CHANNEL_ROOM_TYPE) return true;
  const create = room.currentState?.getStateEvents(EventType.RoomCreate, "")?.getContent();
  return create?.type === CHANNEL_ROOM_TYPE;
}

export interface ChannelRoomSummary {
  roomId: string;
  membership: "join" | "invite";
  unreadCount: number;
  announcements: Announcement[];
  lastActivity: Date;
  latestPreview: string;
  canPublish: boolean;
  canReact: boolean;
  /** Joined application users (the backend service identity is not counted). */
  joinedCount: number;
  hasOlder: boolean;
  avatarUrl: string | null;
}

/** Application accounts are the only members that count; service identities never do. */
function isAppUserId(userId: string): boolean {
  return userId.startsWith("@u_");
}

export function reactionsFor(room: Room, eventId: string, ownUserId: string): AnnouncementReaction[] {
  const relations = room.relations?.getChildEventsForEvent(eventId, "m.annotation", "m.reaction");
  const sorted = relations?.getSortedAnnotationsByKey();
  if (!sorted) return [];
  const result: AnnouncementReaction[] = [];
  for (const [key, events] of sorted) {
    let count = 0;
    let mine: MatrixEvent | undefined;
    for (const event of events) {
      if (event.isRedacted() || event.status === "cancelled" || event.status === "not_sent") continue;
      count += 1;
      if (event.getSender() === ownUserId && !mine) mine = event;
    }
    if (count > 0) result.push({ key, count, mine: Boolean(mine), myEventId: mine?.getId() });
  }
  return result;
}

function announcementFromEvent(event: MatrixEvent, room: Room, ownUserId: string): Announcement | null {
  const base = messageFromMatrixEvent(event, room.roomId, ownUserId);
  if (!base) return null;
  const content = event.getContent<Record<string, unknown>>();
  const meta = content[ANNOUNCEMENT_CONTENT_KEY] as { title?: unknown; text?: unknown } | undefined;
  const title = typeof meta?.title === "string" ? meta.title.trim().slice(0, ANNOUNCEMENT_TITLE_MAX) : "";
  let text = base.text;
  if (base.attachment) {
    // Attachments carry their caption in the announcement metadata (the body is the filename).
    text = typeof meta?.text === "string" ? meta.text : "";
    if (typeof content.filename === "string" && content.filename) base.attachment.name = content.filename;
  } else if (title && text.startsWith(title)) {
    text = text.slice(title.length).replace(/^\s+/, "");
  }
  const senderId = event.getSender() ?? "";
  const member = room.getMember?.(senderId);
  const senderName = member?.name && !member.name.startsWith("@") ? member.name : undefined;
  return {
    ...base,
    text: text.slice(0, ANNOUNCEMENT_BODY_MAX),
    senderName,
    ...(title ? { title } : {}),
    reactions: base.matrix?.eventId && !base.matrix.eventId.startsWith("~")
      ? reactionsFor(room, base.matrix.eventId, ownUserId)
      : [],
  };
}

function sameReactions(left: AnnouncementReaction[], right: AnnouncementReaction[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    if (a.key !== b.key || a.count !== b.count || a.mine !== b.mine || a.myEventId !== b.myEventId) return false;
  }
  return true;
}

function sameTime(left?: Date, right?: Date): boolean {
  return (left?.getTime() ?? Number.NaN) === (right?.getTime() ?? Number.NaN) || (!left && !right);
}

function sameAnnouncement(previous: Announcement, next: Announcement): boolean {
  if (
    previous.id !== next.id ||
    previous.matrix?.eventId !== next.matrix?.eventId ||
    previous.sender !== next.sender ||
    previous.senderName !== next.senderName ||
    previous.title !== next.title ||
    previous.text !== next.text ||
    previous.delivery !== next.delivery ||
    !sameTime(previous.sentAt, next.sentAt)
  ) return false;
  const pa = previous.attachment, na = next.attachment;
  if (Boolean(pa) !== Boolean(na)) return false;
  if (pa && na && (pa.name !== na.name || pa.mediaUri !== na.mediaUri || pa.kind !== na.kind || pa.size !== na.size)) return false;
  return sameReactions(previous.reactions, next.reactions);
}

/** Identity cache per room so memoised cards only re-render when their own data changed. */
const identityCache = new WeakMap<object, Map<string, Announcement>>();

function stabilize(room: Room, announcements: Announcement[]): Announcement[] {
  let cache = identityCache.get(room);
  if (!cache) {
    cache = new Map();
    identityCache.set(room, cache);
  }
  const keep = new Set<string>();
  const result = announcements.map((item) => {
    keep.add(item.id);
    const cached = cache.get(item.id);
    if (cached && sameAnnouncement(cached, item)) return cached;
    cache.set(item.id, item);
    return item;
  });
  for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
  return result;
}

export function channelRoomSummary(room: Room, ownUserId: string, limit: number): ChannelRoomSummary {
  const membership = room.getMyMembership() === "invite" ? "invite" : "join";
  const events = room.getLiveTimeline().getEvents();
  const byId = new Map<string, Announcement>();
  const localIds = new Set<string>();
  let lastTs = 0;
  // Newest first; stop once the window is full so long histories cost nothing extra.
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    const announcement = announcementFromEvent(event, room, ownUserId);
    if (!announcement) continue;
    if (byId.has(announcement.id)) continue;
    if (event.status) localIds.add(announcement.id);
    byId.set(announcement.id, announcement);
    lastTs = Math.max(lastTs, event.getTs() || 0);
    if (byId.size >= limit) break;
  }
  const ordered = [...byId.values()].reverse();
  const confirmed: Announcement[] = [];
  const pending: Announcement[] = [];
  for (const item of ordered) (localIds.has(item.id) ? pending : confirmed).push(item);
  confirmed.sort((left, right) => (left.sentAt?.getTime() ?? 0) - (right.sentAt?.getTime() ?? 0));
  const announcements = stabilize(room, pending.length ? confirmed.concat(pending) : confirmed);
  const latest = announcements.at(-1);
  const lastActivity = latest?.sentAt ?? new Date(lastTs || room.getLastActiveTimestamp() || 0);
  const latestPreview = latest
    ? latest.title || latest.text || latest.attachment?.name || ""
    : "";
  const joined = membership === "join";
  return {
    roomId: room.roomId,
    membership,
    unreadCount: joined ? room.getUnreadNotificationCount() ?? 0 : 0,
    announcements,
    lastActivity,
    latestPreview,
    canPublish: joined && room.currentState.maySendEvent(EventType.RoomMessage, ownUserId),
    canReact: joined && room.currentState.maySendEvent("m.reaction", ownUserId),
    joinedCount: room.getJoinedMembers().filter((member) => isAppUserId(member.userId)).length,
    // A timeline that already starts at the room's creation has nothing older to fetch.
    hasOlder: hasOlderHistory(room) && events[0]?.getType() !== EventType.RoomCreate,
    avatarUrl: room.getMxcAvatarUrl?.() ?? null,
  };
}

export interface ChannelSummaryCache {
  byRoom: Map<string, ChannelRoomSummary>;
  consume(): { all: boolean; dirty: Set<string> };
}

/** Summaries for every channel-type room the user is joined to or invited to, keyed by room ID. */
export function channelRoomsFromClient(
  rooms: Room[],
  ownUserId: string,
  windows: ReadonlyMap<string, number>,
  cache?: ChannelSummaryCache,
): Record<string, ChannelRoomSummary> {
  const visible = rooms.filter(
    (room) => ["join", "invite"].includes(room.getMyMembership()) && isChannelRoom(room),
  );
  const result: Record<string, ChannelRoomSummary> = {};
  const state = cache?.consume();
  const live = new Set<string>();
  for (const room of visible) {
    live.add(room.roomId);
    const limit = windows.get(room.roomId) ?? DEFAULT_ANNOUNCEMENT_WINDOW;
    let summary = cache?.byRoom.get(room.roomId);
    if (!cache || !state || state.all || state.dirty.has(room.roomId) || !summary) {
      summary = channelRoomSummary(room, ownUserId, limit);
      cache?.byRoom.set(room.roomId, summary);
    }
    result[room.roomId] = summary;
  }
  if (cache) for (const id of [...cache.byRoom.keys()]) if (!live.has(id)) cache.byRoom.delete(id);
  return result;
}

export interface AnnouncementDraft {
  title: string;
  body: string;
  file?: File;
}

export function assertPublishReady(client: MatrixClient, roomId: string): Room {
  const room = client.getRoom(roomId);
  const ownUserId = client.getUserId();
  if (!room || room.getMyMembership() !== "join") throw new Error("Subscribe to the channel before publishing.");
  if (!ownUserId || !room.currentState.maySendEvent(EventType.RoomMessage, ownUserId)) {
    throw new Error("Only channel admins can send messages.");
  }
  return room;
}

/**
 * Publishes one announcement as a single Matrix event: an `m.text` with the title in the
 * announcement metadata, or an `m.image`/`m.file` whose caption lives in that metadata.
 * Text announcements get the SDK's local echo, so the card appears immediately.
 */
export async function publishAnnouncement(
  client: MatrixClient,
  roomId: string,
  draft: AnnouncementDraft,
  progress?: (status: string) => void,
): Promise<void> {
  const title = draft.title.trim().slice(0, ANNOUNCEMENT_TITLE_MAX);
  const body = draft.body.trim().slice(0, ANNOUNCEMENT_BODY_MAX);
  if (!title && !body && !draft.file) throw new Error("Write an announcement first.");
  assertPublishReady(client, roomId);
  const meta = { version: 1, title, text: body };
  if (draft.file) {
    progress?.("Preparing file");
    const mime = await validateAttachment(draft.file);
    progress?.("Uploading: 0%");
    const uploaded = await client.uploadContent(draft.file, {
      type: mime,
      progressHandler: ({ loaded, total }) =>
        progress?.(`Uploading: ${Math.min(100, Math.round((100 * loaded) / (total || draft.file!.size)))}%`),
    });
    progress?.("Publishing");
    const content = {
      msgtype: mime.startsWith("image/") ? MsgType.Image : MsgType.File,
      body: draft.file.name,
      filename: draft.file.name,
      info: { size: draft.file.size, mimetype: mime },
      url: uploaded.content_uri,
      [ANNOUNCEMENT_CONTENT_KEY]: meta,
    } as unknown as RoomMessageEventContent;
    await client.sendMessage(roomId, content);
    progress?.("Published");
    return;
  }
  const text = title && body ? `${title}\n\n${body}` : title || body;
  const content = {
    msgtype: MsgType.Text,
    body: text,
    [ANNOUNCEMENT_CONTENT_KEY]: meta,
  } as unknown as RoomMessageEventContent;
  await client.sendMessage(roomId, content);
}

/** Adds the reaction, or removes the user's own existing reaction with the same key. */
export async function toggleReaction(
  client: MatrixClient,
  roomId: string,
  announcement: Announcement,
  key: string,
): Promise<void> {
  const eventId = announcement.matrix?.eventId;
  if (!eventId || eventId.startsWith("~")) throw new Error("Wait for the announcement to be confirmed.");
  const room = client.getRoom(roomId);
  const ownUserId = client.getUserId();
  if (!room || room.getMyMembership() !== "join" || !ownUserId) throw new Error("Subscribe to react.");
  const existing = announcement.reactions.find((reaction) => reaction.key === key && reaction.mine);
  if (existing?.myEventId) {
    await client.redactEvent(roomId, existing.myEventId);
    return;
  }
  if (!room.currentState.maySendEvent("m.reaction", ownUserId)) throw new Error("Reactions are not allowed here.");
  await client.sendEvent(roomId, "m.reaction" as EventType.Reaction, {
    "m.relates_to": { rel_type: RelationType.Annotation, event_id: eventId, key },
  });
}
