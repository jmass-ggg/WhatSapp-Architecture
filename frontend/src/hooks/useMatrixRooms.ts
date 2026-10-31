import { useCallback, useRef } from "react";

import { useMatrixContext } from "../context/MatrixContext";
import type { Conversation } from "../types";
import type { MatrixConnectionStatus, MatrixEventSummary } from "../services/matrix/session";
import { createPlainRoom } from "../services/matrix/messaging";
import { findDirectRoomId } from "../services/matrix/rooms";

export interface UseMatrixRoomsResult {
  rooms: Conversation[];
  legacyRoomIds: string[];
  status: MatrixConnectionStatus;
  initialSyncComplete: boolean;
  error: string | null;
  authenticationError: boolean;
  recentEvents: MatrixEventSummary[];
  createDirect: (
    userId: string,
    displayName: string,
    matrixUserId: string,
  ) => Promise<string>;
  createGroup: (name: string, matrixUserIds: string[]) => Promise<string>;
}

export function useMatrixRooms(): UseMatrixRoomsResult {
  const {
    client,
    rooms,
    legacyRoomIds,
    status,
    initialSyncComplete,
    error,
    authenticationError,
    recentEvents,
  } = useMatrixContext();
  const directRoomPromises = useRef(new Map<string, Promise<string>>());
  const groupRoomPromises = useRef(new Map<string, Promise<string>>());

  const createDirect = useCallback(
    async (_userId: string, _displayName: string, matrixUserId: string) => {
      if (!client) throw new Error("Sign in to start a conversation.");
      if (!initialSyncComplete) throw new Error("Wait for the connection to finish syncing.");
      const pending = directRoomPromises.current.get(matrixUserId);
      if (pending) return pending;

      const creation = (async () => {
        // Reuse a joined/invited plaintext direct room; never groups or retired encrypted rooms.
        const ownUserId = client.getUserId();
        if (!ownUserId) throw new Error("Sign in to start a conversation.");
        const existing = findDirectRoomId(client.getRooms(), ownUserId, matrixUserId);
        if (existing) return existing;
        return createPlainRoom(client, { invitees: [matrixUserId], isDirect: true });
      })();
      directRoomPromises.current.set(matrixUserId, creation);
      try {
        return await creation;
      } finally {
        if (directRoomPromises.current.get(matrixUserId) === creation) {
          directRoomPromises.current.delete(matrixUserId);
        }
      }
    },
    [client, initialSyncComplete],
  );

  const createGroup = useCallback(
    async (name: string, matrixUserIds: string[]) => {
      if (!client) throw new Error("Sign in to create a group.");
      const normalizedName = name.trim();
      if (!normalizedName) throw new Error("Enter a name for the group.");
      if (normalizedName.length > 80) {
        throw new Error("Group names must be 80 characters or fewer.");
      }
      const uniqueMatrixUserIds = [...new Set(matrixUserIds)];
      if (uniqueMatrixUserIds.length !== matrixUserIds.length || uniqueMatrixUserIds.length < 2) {
        throw new Error("Select at least two different accepted contacts.");
      }
      const ownUserId = client.getUserId();
      if (!ownUserId || uniqueMatrixUserIds.includes(ownUserId)) {
        throw new Error("The current user cannot be selected as a group participant.");
      }

      const key = JSON.stringify([normalizedName, [...uniqueMatrixUserIds].sort()]);
      const pending = groupRoomPromises.current.get(key);
      if (pending) return pending;

      const creation = createPlainRoom(client, {
        invitees: uniqueMatrixUserIds,
        name: normalizedName,
        isDirect: false,
        isGroup: true,
      });
      groupRoomPromises.current.set(key, creation);
      try {
        return await creation;
      } finally {
        if (groupRoomPromises.current.get(key) === creation) {
          groupRoomPromises.current.delete(key);
        }
      }
    },
    [client],
  );

  return {
    rooms,
    legacyRoomIds,
    status,
    initialSyncComplete,
    error,
    authenticationError,
    recentEvents,
    createDirect,
    createGroup,
  };
}
