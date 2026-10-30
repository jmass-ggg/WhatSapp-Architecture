import { EventType, type MatrixClient, type Room } from "matrix-js-sdk";

export const MAX_PINNED_MESSAGES = 3;

type PinAction = "pin" | "unpin";

const queues = new WeakMap<MatrixClient, Map<string, Promise<unknown>>>();

function serializedForRoom<T>(
  client: MatrixClient,
  roomId: string,
  action: () => Promise<T>,
): Promise<T> {
  let clientQueues = queues.get(client);
  if (!clientQueues) {
    clientQueues = new Map();
    queues.set(client, clientQueues);
  }

  const previous = clientQueues.get(roomId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  clientQueues.set(roomId, current);
  return current.finally(() => {
    if (clientQueues?.get(roomId) === current) clientQueues.delete(roomId);
  });
}

function cleanPinnedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (id): id is string => typeof id === "string" && id.length > 0 && !id.startsWith("~"),
  ))];
}

export function getPinnedEventIds(room: Room | null | undefined): string[] {
  const event = room?.currentState.getStateEvents(EventType.RoomPinnedEvents, "");
  return cleanPinnedIds(event?.getContent()?.pinned);
}

export function canManagePinnedMessages(
  room: Room | null | undefined,
  userId: string | null | undefined,
): boolean {
  return Boolean(
    room &&
    userId &&
    room.getMyMembership() === "join" &&
    room.currentState.maySendStateEvent(EventType.RoomPinnedEvents, userId),
  );
}

function isMissingStateEvent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const matrixError = error as { httpStatus?: unknown; errcode?: unknown };
  return matrixError.httpStatus === 404 || matrixError.errcode === "M_NOT_FOUND";
}

async function readCurrentPinnedIds(
  client: MatrixClient,
  room: Room,
): Promise<string[]> {
  try {
    const content = await client.getStateEvent(
      room.roomId,
      EventType.RoomPinnedEvents,
      "",
    );
    if (!Array.isArray(content.pinned) ||
      content.pinned.some((id: unknown) =>
        typeof id !== "string" || id.length === 0 || id.startsWith("~"))) {
      throw new Error("The room's pinned-message state is invalid; no changes were made.");
    }
    return cleanPinnedIds(content.pinned);
  } catch (error) {
    if (isMissingStateEvent(error)) return [];
    throw error;
  }
}

/**
 * Reads the latest room state before modifying it and serializes this client's
 * updates per room. The homeserver remains authoritative for power-level checks.
 */
export function updatePinnedEvent(
  client: MatrixClient,
  room: Room,
  userId: string,
  eventId: string,
  action: PinAction,
): Promise<string[]> {
  return serializedForRoom(client, room.roomId, async () => {
    if (room.getMyMembership() !== "join") {
      throw new Error("Join this conversation before changing pinned messages.");
    }
    if (!room.currentState.maySendStateEvent(EventType.RoomPinnedEvents, userId)) {
      throw new Error("You do not have permission to change pinned messages.");
    }
    if (!eventId || eventId.startsWith("~")) {
      throw new Error("Only a sent Matrix message can be pinned.");
    }

    let current = await readCurrentPinnedIds(client, room);
    if (action === "pin" && current.includes(eventId)) return current;
    if (action === "unpin" && !current.includes(eventId)) return current;
    if (action === "pin" && current.length >= MAX_PINNED_MESSAGES) {
      throw new Error("A conversation can have up to three pinned messages.");
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pinned = action === "pin"
        ? [...current, eventId]
        : current.filter((id) => id !== eventId);
      await client.sendStateEvent(
        room.roomId,
        EventType.RoomPinnedEvents,
        { pinned },
        "",
      );

      const latest = await readCurrentPinnedIds(client, room);
      const operationApplied = action === "pin"
        ? latest.includes(eventId)
        : !latest.includes(eventId);
      if (operationApplied) return latest;

      // Another client may have written a state event between our read and
      // write. Rebase this operation on the newly observed list and retry.
      current = latest;
      if (action === "pin" && current.length >= MAX_PINNED_MESSAGES) {
        throw new Error("A conversation can have up to three pinned messages.");
      }
    }
    throw new Error("Pinned messages changed on another device. Please try again.");
  });
}
