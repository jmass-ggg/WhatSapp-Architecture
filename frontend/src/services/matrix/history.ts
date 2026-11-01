import { Direction, type MatrixClient, type Room } from "matrix-js-sdk";

const PAGE_SIZE = 50;

/** True while the homeserver still has older events for this room. */
export function hasOlderHistory(room: Pick<Room, "getLiveTimeline">): boolean {
  return Boolean(room.getLiveTimeline().getPaginationToken(Direction.Backward));
}

/** Loads one older page; the Matrix session refreshes conversations from timeline events. */
export async function loadOlderMessages(
  client: Pick<MatrixClient, "paginateEventTimeline">,
  room: Pick<Room, "getLiveTimeline">,
): Promise<boolean> {
  if (!hasOlderHistory(room)) return false;
  return client.paginateEventTimeline(room.getLiveTimeline(), { backwards: true, limit: PAGE_SIZE });
}
