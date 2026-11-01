import type { MatrixClient } from "matrix-js-sdk";

/** Standard Matrix favourite tag; synced per user by the homeserver. */
export const FAVOURITE_TAG = "m.favourite";
/** Custom per-user tag (the `u.` prefix is reserved for user-defined tags). */
export const PINNED_TAG = "u.pinned";

export interface RoomTagSets {
  favorites: Set<string>;
  pinned: Set<string>;
}

type TaggedRoom = { roomId: string; tags?: Record<string, unknown> };

/** Reads the favourite/pinned room IDs from the rooms' synced tags. */
export function readRoomTags(rooms: TaggedRoom[]): RoomTagSets {
  const favorites = new Set<string>();
  const pinned = new Set<string>();
  for (const room of rooms) {
    if (room.tags?.[FAVOURITE_TAG]) favorites.add(room.roomId);
    if (room.tags?.[PINNED_TAG]) pinned.add(room.roomId);
  }
  return { favorites, pinned };
}

export async function setRoomTagEnabled(
  client: Pick<MatrixClient, "setRoomTag" | "deleteRoomTag">,
  roomId: string,
  tag: typeof FAVOURITE_TAG | typeof PINNED_TAG,
  enabled: boolean,
): Promise<void> {
  if (enabled) await client.setRoomTag(roomId, tag, { order: 0.5 });
  else await client.deleteRoomTag(roomId, tag);
}
