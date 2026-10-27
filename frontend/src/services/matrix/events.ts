import type { MatrixEvent } from "matrix-js-sdk";

import type { Message } from "../../types";

const FILE_MESSAGE_TYPES = new Set([
  "m.image",
  "m.file",
  "m.audio",
  "m.video",
]);

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0][0]}${parts.at(-1)?.[0] ?? ""}`.toUpperCase()
    : (parts[0]?.slice(0, 2) ?? "??").toUpperCase();
}

export function messageFromMatrixEvent(
  event: MatrixEvent,
  roomId: string,
  ownUserId: string,
): Message | null {
  const wireType = event.getWireType();
  const eventType = event.getType();
  const senderId = event.getSender();
  if (!senderId) return null;

  const sentAt = event.getDate() ?? new Date(event.getTs() || Date.now());
  const eventId = event.getId();

  const encrypted = wireType === "m.room.encrypted" || event.isEncrypted();
  const clearContent = encrypted ? event.getClearContent() : null;

  if (encrypted && (!clearContent || event.isDecryptionFailure())) {
    const failed = event.isDecryptionFailure();
    return {
      id: eventId ?? `encrypted-${senderId}-${event.getTs()}`,
      sender: senderId === ownUserId ? "me" : "them",
      senderName: senderId,
      text: failed
        ? "Unable to decrypt this encrypted message."
        : "Encrypted message · waiting for a room key.",
      sentAt,
      delivery: "sent",
      matrix: {
        eventId: eventId ?? "",
        roomId,
        eventType: wireType,
        senderId,
        encryptionStatus: failed ? "failed" : "pending",
      },
    };
  }

  const clearType = encrypted ? eventType : wireType;
  if (clearType !== "m.room.message") return null;

  const content = (clearContent ??
    event.getContent<Record<string, unknown>>()) as Record<string, unknown>;
  const messageType =
    typeof content.msgtype === "string" ? content.msgtype : "";
  const body = typeof content.body === "string" ? content.body : "";
  if (!body || (!FILE_MESSAGE_TYPES.has(messageType) &&
    messageType !== "m.text" &&
    messageType !== "m.notice" &&
    messageType !== "m.emote")) {
    return null;
  }

  const isFile = FILE_MESSAGE_TYPES.has(messageType);
  const info =
    typeof content.info === "object" && content.info !== null
      ? (content.info as Record<string, unknown>)
      : {};
  const mediaUri = typeof content.url === "string" ? content.url : undefined;

  return {
    id: eventId ?? `local-${senderId}-${event.getTs()}-${body}`,
    sender: senderId === ownUserId ? "me" : "them",
    senderName: senderId,
    text: isFile ? "" : body,
    sentAt,
    delivery: senderId === ownUserId ? "sent" : "delivered",
    ...(isFile
      ? {
          attachment: {
            name: body || (messageType === "m.image" ? "Shared image" : "Shared file"),
            size: typeof info.size === "number" ? info.size : undefined,
            mimeType:
              typeof info.mimetype === "string" ? info.mimetype : undefined,
            kind: messageType === "m.image" ? ("image" as const) : ("file" as const),
            mediaUri,
          },
        }
      : {}),
    matrix: {
      eventId: eventId ?? "",
      roomId,
      eventType: wireType,
      senderId,
      ...(encrypted ? { encryptionStatus: "decrypted" as const } : {}),
    },
  };
}

export function initialsForDisplayName(name: string): string {
  return initialsFor(name);
}
