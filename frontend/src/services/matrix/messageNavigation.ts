import {
  Direction,
  type EventTimeline,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";

import type { Message } from "../../types";
import { messageFromMatrixEvent } from "./events";

const PAGINATION_PAGE_SIZE = 100;
const MAX_BACKWARD_PAGES = 50;

function senderDisplayName(
  room: Room,
  event: MatrixEvent,
  ownUserId: string,
  fallbackName: string,
): string {
  const senderId = event.getSender();
  if (senderId === ownUserId) return "You";
  const member = room.getMembers().find((candidate) => candidate.userId === senderId);
  const displayName = member?.name && !member.name.startsWith("@")
    ? member.name
    : undefined;
  return displayName || fallbackName || "A participant";
}

async function messageFromEvent(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  fallbackName: string,
): Promise<Message> {
  if (event.isRedacted()) {
    throw new Error("That message was deleted or redacted and is unavailable.");
  }

  const userId = client.getUserId();
  if (!userId) throw new Error("Your Matrix session is no longer available.");
  const message = messageFromMatrixEvent(event, room.roomId, userId);
  if (!message || message.matrix?.eventId !== event.getId()) {
    throw new Error("That event is not an available message in this conversation.");
  }
  message.senderName = senderDisplayName(room, event, userId, fallbackName);
  return message;
}

function findEvent(room: Room, eventId: string): MatrixEvent | undefined {
  return room.findEventById(eventId) ??
    room.getUnfilteredTimelineSet().getTimelines()
      .flatMap((timeline) => timeline.getEvents())
      .find((event) => event.getId() === eventId);
}

async function findWithEventContext(
  client: MatrixClient,
  room: Room,
  eventId: string,
): Promise<MatrixEvent | undefined> {
  const timeline = await client.getEventTimeline(
    room.getUnfilteredTimelineSet(),
    eventId,
  );
  if (!timeline) return undefined;
  return timeline.getEvents().find((event) => event.getId() === eventId) ??
    findEvent(room, eventId);
}

/**
 * Resolves banner metadata without inserting an old event into the visible
 * timeline. The sender, time and content still come from the Matrix event and
 * only plaintext m.room.message events are mapped.
 */
export async function loadMatrixMessagePreview(
  client: MatrixClient,
  room: Room,
  eventId: string,
  fallbackName: string,
): Promise<Message> {
  let event = findEvent(room, eventId);
  if (!event) {
    const rawEvent = await client.fetchRoomEvent(room.roomId, eventId);
    event = client.getEventMapper()({
      ...rawEvent,
      room_id: rawEvent.room_id ?? room.roomId,
    });
  }
  if (event.getId() !== eventId) {
    throw new Error("Matrix returned a different event than the requested message.");
  }
  if (event.getRoomId() !== room.roomId) {
    throw new Error("Matrix returned a message from a different conversation.");
  }
  return messageFromEvent(client, room, event, fallbackName);
}

/**
 * Loads the exact target using bounded room pagination, then falls back to the
 * Matrix /context timeline API for older events beyond that bound.
 */
export async function loadMatrixMessage(
  client: MatrixClient,
  room: Room,
  eventId: string,
  fallbackName: string,
  paginate = true,
): Promise<Message> {
  if (!eventId || eventId.startsWith("~")) {
    throw new Error("That message does not have a valid Matrix event ID.");
  }

  let event = findEvent(room, eventId);
  if (!event && paginate) {
    const seenTokens = new Set<string>();
    for (let page = 0; page < MAX_BACKWARD_PAGES; page += 1) {
      const timeline: EventTimeline = room.getLiveTimeline();
      const token = timeline.getPaginationToken(Direction.Backward);
      if (!token || seenTokens.has(token)) break;
      seenTokens.add(token);

      let hasMore: boolean;
      try {
        hasMore = await client.paginateEventTimeline(timeline, {
          backwards: true,
          limit: PAGINATION_PAGE_SIZE,
        });
      } catch {
        break;
      }
      event = findEvent(room, eventId);
      if (event) break;
      if (!hasMore) break;
      const nextToken = room.getLiveTimeline().getPaginationToken(Direction.Backward);
      if (!nextToken || nextToken === token || seenTokens.has(nextToken)) break;
    }
  }

  event ??= await findWithEventContext(client, room, eventId);
  if (!event || event.getId() !== eventId) {
    throw new Error("That message is unavailable or you no longer have access to it.");
  }
  if (event.getRoomId() !== room.roomId) {
    throw new Error("That message belongs to a different conversation.");
  }
  return messageFromEvent(client, room, event, fallbackName);
}
