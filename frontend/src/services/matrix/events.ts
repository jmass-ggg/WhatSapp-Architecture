import { EventStatus, type MatrixEvent } from "matrix-js-sdk";

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

function outgoingDelivery(event: MatrixEvent): Message["delivery"] {
  switch (event.status) {
    case EventStatus.NOT_SENT:
      return "failed";
    case EventStatus.CANCELLED:
      return "cancelled";
    case EventStatus.QUEUED:
    case EventStatus.SENDING:
      return "sending";
    case EventStatus.SENT:
      return "sent";
    default:
      return event.getId()?.startsWith("~") ? "sending" : "sent";
  }
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

  const timestamp = event.getTs();
  const sentAt = Number.isFinite(timestamp) &&
    Math.abs(timestamp as number) <= 8.64e15
    ? new Date(timestamp as number)
    : event.getId()?.startsWith("~") &&
        Number.isFinite(event.localTimestamp) &&
        Math.abs(event.localTimestamp) <= 8.64e15
      ? new Date(event.localTimestamp)
      : undefined;
  const eventId = event.getId();

  // Retired encrypted events are never surfaced as messages.
  if (wireType !== "m.room.message" || eventType !== "m.room.message") return null;

  const content = event.getContent<Record<string, unknown>>() as Record<string, unknown>;
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
  const relation = content["m.relates_to"] as { "m.in_reply_to"?: { event_id?: unknown } } | undefined;
  const replyEventId = relation?.["m.in_reply_to"]?.event_id;

  return {
    id: eventId ?? `local-${senderId}-${event.getTs()}-${body}`,
    sender: senderId === ownUserId ? "me" : "them",
    senderName: undefined,
    text: isFile ? "" : body,
    sentAt,
    delivery: senderId === ownUserId ? outgoingDelivery(event) : "sent",
    ...(typeof replyEventId === "string" ? { replyTo: { eventId: replyEventId, sender: "", text: "Original message unavailable" } } : {}),
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
    },
  };
}

export function initialsForDisplayName(name: string): string {
  return initialsFor(name);
}
