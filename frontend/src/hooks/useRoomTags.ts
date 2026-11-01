import type { MatrixClient } from "matrix-js-sdk";
import { RoomEvent } from "matrix-js-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  FAVOURITE_TAG,
  PINNED_TAG,
  readRoomTags,
  setRoomTagEnabled,
  type RoomTagSets,
} from "../services/matrix/roomTags";

type TagName = typeof FAVOURITE_TAG | typeof PINNED_TAG;

export interface UseRoomTagsResult extends RoomTagSets {
  toggleFavorite: (roomId: string) => Promise<void>;
  togglePinned: (roomId: string) => Promise<void>;
}

/** Favourite and pinned conversations, persisted as Matrix room tags on the user's account. */
export function useRoomTags(client: MatrixClient | null, syncKey: unknown): UseRoomTagsResult {
  const [version, setVersion] = useState(0);
  // Optimistic overrides survive until the server echoes the tag back through sync.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!client) return undefined;
    const onTags = () => {
      setOverrides({});
      setVersion((value) => value + 1);
    };
    client.on(RoomEvent.Tags, onTags);
    return () => {
      client.off(RoomEvent.Tags, onTags);
    };
  }, [client]);

  const base = useMemo(
    () => readRoomTags(client?.getRooms() ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, version, syncKey],
  );

  const sets = useMemo(() => {
    const favorites = new Set(base.favorites);
    const pinned = new Set(base.pinned);
    for (const [key, enabled] of Object.entries(overrides)) {
      const separator = key.indexOf("|");
      const tag = key.slice(0, separator);
      const roomId = key.slice(separator + 1);
      const target = tag === FAVOURITE_TAG ? favorites : pinned;
      if (enabled) target.add(roomId);
      else target.delete(roomId);
    }
    return { favorites, pinned };
  }, [base, overrides]);

  const toggle = useCallback(
    async (roomId: string, tag: TagName, current: boolean) => {
      if (!client) throw new Error("Sign in to update conversations.");
      const key = `${tag}|${roomId}`;
      setOverrides((value) => ({ ...value, [key]: !current }));
      try {
        await setRoomTagEnabled(client, roomId, tag, !current);
      } catch (cause) {
        setOverrides((value) => {
          const { [key]: _removed, ...rest } = value;
          return rest;
        });
        throw cause;
      }
    },
    [client],
  );

  return {
    ...sets,
    toggleFavorite: (roomId) => toggle(roomId, FAVOURITE_TAG, sets.favorites.has(roomId)),
    togglePinned: (roomId) => toggle(roomId, PINNED_TAG, sets.pinned.has(roomId)),
  };
}
