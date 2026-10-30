import { useCallback, useRef } from "react";
import type { Room } from "matrix-js-sdk";

import { useMatrixContext } from "../context/MatrixContext";
import type { Conversation } from "../types";
import type { MatrixConnectionStatus, MatrixEventSummary } from "../services/matrix/session";
import {
  createEncryptedRoom,
  MATRIX_GROUP_MARKER_TYPE,
} from "../services/matrix/encryption";

function isMarkedGroupRoom(room: Room): boolean {
  const version = room.currentState
    .getStateEvents(MATRIX_GROUP_MARKER_TYPE, "")
    ?.getContent().version;
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 1
  );
}

export interface UseMatrixRoomsResult {
  rooms: Conversation[];
  status: MatrixConnectionStatus;
  initialSyncComplete: boolean;
  cryptoStatus: ReturnType<typeof useMatrixContext>["cryptoStatus"];
  cryptoOnboardingStatus: ReturnType<
    typeof useMatrixContext
  >["cryptoOnboardingStatus"];
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
    status,
    initialSyncComplete,
    cryptoStatus,
    cryptoOnboardingStatus,
    error,
    authenticationError,
    recentEvents,
  } = useMatrixContext();
  const directRoomPromises = useRef(new Map<string, Promise<string>>());
  const groupRoomPromises = useRef(new Map<string, Promise<string>>());

  const createDirect = useCallback(
    async (_userId: string, _displayName: string, matrixUserId: string) => {
      if (!client) throw new Error("Sign in to start a conversation.");
      if (cryptoStatus !== "ready" || cryptoOnboardingStatus !== "ready") {
        throw new Error(
          "Finish secure messaging setup before creating an encrypted conversation.",
        );
      }
      const pending = directRoomPromises.current.get(matrixUserId);
      if (pending) return pending;

      const creation = (async () => {
        const existing = client.getRooms().find((room) =>
          (room.getMyMembership() === "join" || room.getMyMembership() === "invite") &&
          room.hasEncryptionStateEvent() &&
          !isMarkedGroupRoom(room) &&
          room.getMembers().some((member) =>
            member.userId === matrixUserId &&
            (member.membership === "join" || member.membership === "invite"),
          ) &&
          room.getMembers().filter((member) =>
            member.userId !== client.getUserId() &&
            (member.membership === "join" || member.membership === "invite"),
          ).length === 1,
        );
        if (existing) return existing.roomId;
        return createEncryptedRoom(client, {
          invitees: [matrixUserId],
          isDirect: true,
        });
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
    [client, cryptoOnboardingStatus, cryptoStatus],
  );
  const createGroup = useCallback(
    async (name: string, matrixUserIds: string[]) => {
      if (!client) throw new Error("Sign in to create a group.");
      if (cryptoStatus !== "ready" || cryptoOnboardingStatus !== "ready") {
        throw new Error(
          "Finish secure messaging setup before creating an encrypted group.",
        );
      }

      const normalizedName = name.trim();
      if (!normalizedName) throw new Error("Enter a name for the group.");
      if (normalizedName.length > 80) {
        throw new Error("Group names must be 80 characters or fewer.");
      }
      const uniqueMatrixUserIds = [...new Set(matrixUserIds)];
      if (
        uniqueMatrixUserIds.length !== matrixUserIds.length ||
        uniqueMatrixUserIds.length < 2
      ) {
        throw new Error("Select at least two different accepted contacts.");
      }
      const ownUserId = client.getUserId();
      if (!ownUserId || uniqueMatrixUserIds.includes(ownUserId)) {
        throw new Error("The current user cannot be selected as a group participant.");
      }

      const key = JSON.stringify([
        normalizedName,
        [...uniqueMatrixUserIds].sort(),
      ]);
      const pending = groupRoomPromises.current.get(key);
      if (pending) return pending;

      const creation = createEncryptedRoom(client, {
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
    [client, cryptoOnboardingStatus, cryptoStatus],
  );
  return {
    rooms,
    status,
    initialSyncComplete,
    cryptoStatus,
    cryptoOnboardingStatus,
    error,
    authenticationError,
    recentEvents,
    createDirect,
    createGroup,
  };
}
