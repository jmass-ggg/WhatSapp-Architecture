import type { Conversation, DirectoryUser, Message } from "../../types";

const DEFAULT_MATRIX_URL = "http://localhost:8008";
export const MATRIX_BASE_URL = (
  import.meta.env.VITE_MATRIX_URL || DEFAULT_MATRIX_URL
).replace(/\/+$/, "");
export const MATRIX_SERVER_NAME =
  import.meta.env.VITE_MATRIX_SERVER_NAME || "localhost";

export interface MatrixEvent {
  event_id?: string;
  type?: string;
  sender?: string;
  state_key?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
}

interface MatrixRoomSync {
  state?: { events?: MatrixEvent[] };
  timeline?: { events?: MatrixEvent[]; limited?: boolean };
  ephemeral?: { events?: MatrixEvent[] };
  unread_notifications?: { notification_count?: number };
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, MatrixRoomSync>;
  };
  presence?: { events?: MatrixEvent[] };
}

export interface MatrixRoomView {
  conversation: Conversation;
  stateEvents: MatrixEvent[];
  messageEvents: MatrixEvent[];
  presenceEvents: MatrixEvent[];
}

export class MatrixApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MatrixApiError";
  }
}

function matrixError(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const message = (payload as { error?: unknown }).error;
    if (typeof message === "string") return message;
  }
  return fallback;
}

async function requestJson<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${MATRIX_BASE_URL}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new MatrixApiError("Synapse could not be reached.", 0);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new MatrixApiError(
      matrixError(payload, `Synapse returned status ${response.status}.`),
      response.status,
    );
  }
  return payload as T;
}

export function syncMatrix(
  token: string,
  since: string | null,
  signal: AbortSignal,
): Promise<MatrixSyncResponse> {
  const query = new URLSearchParams({ timeout: "30000" });
  if (since) query.set("since", since);
  else query.set("full_state", "true");

  return requestJson<MatrixSyncResponse>(
    token,
    `/_matrix/client/v3/sync?${query.toString()}`,
    { signal },
  );
}

export function sendMatrixText(
  token: string,
  roomId: string,
  text: string,
): Promise<{ event_id: string }> {
  const transactionId = crypto.randomUUID();
  return requestJson(
    token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
    {
      method: "PUT",
      body: JSON.stringify({ msgtype: "m.text", body: text }),
    },
  );
}

export async function sendMatrixFile(
  token: string,
  roomId: string,
  file: File,
): Promise<{ event_id: string; content_uri: string }> {
  const query = new URLSearchParams({ filename: file.name });
  const upload = await requestJson<{ content_uri: string }>(
    token,
    `/_matrix/media/v3/upload?${query.toString()}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  const isImage = file.type.startsWith("image/");
  const content = {
    msgtype: isImage ? "m.image" : "m.file",
    body: file.name,
    url: upload.content_uri,
    info: {
      mimetype: file.type || "application/octet-stream",
      size: file.size,
    },
  };
  const transactionId = crypto.randomUUID();
  const sent = await requestJson<{ event_id: string }>(
    token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
    {
      method: "PUT",
      body: JSON.stringify(content),
    },
  );
  return { ...sent, content_uri: upload.content_uri };
}

export function createMatrixDirectRoom(
  token: string,
  userId: string,
  displayName: string,
): Promise<{ room_id: string }> {
  return requestJson(token, "/_matrix/client/v3/createRoom", {
    method: "POST",
    body: JSON.stringify({
      visibility: "private",
      preset: "trusted_private_chat",
      is_direct: true,
      invite: [userId],
      name: displayName,
    }),
  });
}

export function markMatrixRoomRead(
  token: string,
  roomId: string,
  eventId: string,
): Promise<Record<string, never>> {
  return requestJson(
    token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchMatrixMedia(
  token: string,
  mediaUri: string,
): Promise<Blob> {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mediaUri);
  if (!match) throw new MatrixApiError("The media address is invalid.", 400);
  const [, serverName, mediaId] = match;
  const url = `${MATRIX_BASE_URL}/_matrix/media/v3/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new MatrixApiError("Synapse could not load this attachment.", 0);
  }
  if (!response.ok) {
    throw new MatrixApiError(
      `The attachment could not be loaded (status ${response.status}).`,
      response.status,
    );
  }
  return response.blob();
}

export function mappedMatrixUserId(user: DirectoryUser): string {
  const localpart = `u_${user.id.replaceAll("-", "").toLowerCase()}`;
  return `@${localpart}:${MATRIX_SERVER_NAME}`;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0][0]}${parts.at(-1)?.[0] ?? ""}`.toUpperCase()
    : (parts[0]?.slice(0, 2) ?? "??").toUpperCase();
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function messageFromEvent(event: MatrixEvent, userId: string): Message | null {
  if (event.type !== "m.room.message" || !event.content) return null;
  const content = event.content;
  const kind = textValue(content.msgtype);
  const body = textValue(content.body);
  const mediaUri = textValue(content.url);
  const info =
    typeof content.info === "object" && content.info !== null
      ? (content.info as Record<string, unknown>)
      : {};
  const isImage = kind === "m.image";
  const hasFile = isImage || kind === "m.file" || kind === "m.audio" || kind === "m.video";
  const sentAt = new Date(event.origin_server_ts ?? Date.now());

  return {
    id: event.event_id ?? `${event.sender ?? "unknown"}-${sentAt.getTime()}-${body}`,
    sender: event.sender === userId ? "me" : "them",
    senderName: event.sender,
    text: hasFile ? "" : body,
    sentAt,
    delivery: "sent",
    ...(hasFile
      ? {
          attachment: {
            name: body || (isImage ? "Shared image" : "Shared file"),
            size: typeof info.size === "number" ? info.size : undefined,
            mimeType: textValue(info.mimetype),
            kind: isImage ? ("image" as const) : ("file" as const),
            mediaUri: mediaUri || undefined,
          },
        }
      : {}),
  };
}

function memberData(stateEvents: MatrixEvent[], ownUserId: string) {
  return stateEvents
    .filter(
      (event) =>
        event.type === "m.room.member" &&
        typeof event.state_key === "string" &&
        event.state_key !== ownUserId,
    )
    .map((event) => {
      const content = event.content ?? {};
      const userId = event.state_key ?? "";
      return {
        userId,
        name: textValue(content.displayname) || userId.split(":")[0]?.slice(1) || "Contact",
        avatar: textValue(content.avatar_url) || null,
        membership: textValue(content.membership),
      };
    });
}

function toConversation(
  roomId: string,
  room: MatrixRoomSync,
  stateEvents: MatrixEvent[],
  messageEvents: MatrixEvent[],
  presenceEvents: MatrixEvent[],
  ownUserId: string,
): Conversation {
  const others = memberData(stateEvents, ownUserId).filter(
    (member) => member.membership === "join" || member.membership === "invite",
  );
  const roomName = stateEvents.find(
    (event) => event.type === "m.room.name" && event.state_key === "",
  );
  const name =
    textValue(roomName?.content?.name) ||
    (others.length > 1 ? `${others[0].name} + ${others.length - 1}` : others[0]?.name) ||
    "New conversation";
  const isEncrypted = stateEvents.some((event) => event.type === "m.room.encryption");
  const latestEvent = [...messageEvents]
    .filter((event) => event.type === "m.room.message" || event.type === "m.room.encrypted")
    .sort((left, right) => (right.origin_server_ts ?? 0) - (left.origin_server_ts ?? 0))[0];
  const latestMessage = latestEvent ? messageFromEvent(latestEvent, ownUserId) : null;
  const typingEvent = room.ephemeral?.events?.find((event) => event.type === "m.typing");
  const typingIds = Array.isArray(typingEvent?.content?.user_ids)
    ? (typingEvent.content?.user_ids as unknown[]).filter(
        (id): id is string => typeof id === "string" && id !== ownUserId,
      )
    : [];
  const presence = presenceEvents.find((event) => event.sender === others[0]?.userId);
  const unread = room.unread_notifications?.notification_count;
  const messages = messageEvents
    .map((event) => messageFromEvent(event, ownUserId))
    .filter((message): message is Message => message !== null)
    .sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());

  return {
    id: roomId,
    roomId,
    name,
    matrixUserId: others[0]?.userId,
    initials: initialsFor(name),
    avatarUrl: others[0]?.avatar ?? null,
    accent: Math.abs(roomId.length * 13) % 6,
    isOnline:
      textValue(presence?.content?.presence) === "online" ? true : undefined,
    isTyping: typingIds.length > 0,
    lastMessage:
      latestMessage?.text ||
      latestMessage?.attachment?.name ||
      (isEncrypted && latestEvent ? "Encrypted message" : "Start a conversation"),
    updatedAt: latestMessage?.sentAt ??
      (latestEvent ? new Date(latestEvent.origin_server_ts ?? Date.now()) : new Date(0)),
    unreadCount: typeof unread === "number" ? unread : 0,
    messages,
    bio: others.length > 1 ? `${others.length + 1} people in this conversation` : "Matrix conversation",
    isDemo: false,
    isGroup: others.length > 1,
    isEncrypted,
  };
}

export function mergeMatrixSync(
  current: MatrixRoomView[],
  response: MatrixSyncResponse,
  ownUserId: string,
): MatrixRoomView[] {
  const currentById = new Map(current.map((room) => [room.conversation.id, room]));
  const incomingRooms = response.rooms?.join ?? {};
  const presenceEvents = response.presence?.events ?? [];

  for (const [roomId, room] of Object.entries(incomingRooms)) {
    const previous = currentById.get(roomId);
    const timelineEvents = room.timeline?.events ?? [];
    const newStateEvents = [
      ...(room.state?.events ?? []),
      ...timelineEvents.filter((event) => event.state_key !== undefined),
    ];
    const stateByKey = new Map<string, MatrixEvent>();
    for (const event of [...(previous?.stateEvents ?? []), ...newStateEvents]) {
      if (!event.type) continue;
      stateByKey.set(`${event.type}:${event.state_key ?? ""}`, event);
    }

    const messageById = new Map<string, MatrixEvent>();
    for (const event of [...(previous?.messageEvents ?? []), ...timelineEvents]) {
      if (event.type !== "m.room.message" && event.type !== "m.room.encrypted") continue;
      const key =
        event.event_id ??
        `${event.sender ?? "unknown"}:${event.origin_server_ts ?? 0}:${textValue(event.content?.body)}`;
      messageById.set(key, event);
    }

    const mergedState = [...stateByKey.values()];
    const mergedMessages = [...messageById.values()].sort(
      (left, right) => (left.origin_server_ts ?? 0) - (right.origin_server_ts ?? 0),
    );
    const mergedPresence = [
      ...(previous?.presenceEvents ?? []),
      ...presenceEvents,
    ].filter((event, index, all) => {
      const key = event.sender ?? "";
      return all.findIndex((candidate) => candidate.sender === key) === index;
    });

    const conversation = toConversation(
      roomId,
      room,
      mergedState,
      mergedMessages,
      mergedPresence,
      ownUserId,
    );
    currentById.set(roomId, {
      conversation,
      stateEvents: mergedState,
      messageEvents: mergedMessages,
      presenceEvents: mergedPresence,
    });
  }

  return [...currentById.values()].sort(
    (left, right) =>
      right.conversation.updatedAt.getTime() - left.conversation.updatedAt.getTime(),
  );
}

export function createOptimisticMessage(
  id: string,
  text: string,
  attachment?: Message["attachment"],
): Message {
  return {
    id,
    sender: "me",
    text,
    sentAt: new Date(),
    delivery: "sending",
    attachment,
  };
}
