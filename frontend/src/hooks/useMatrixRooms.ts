import { useCallback, useRef } from "react";

import { useMatrixContext } from "../context/MatrixContext";
import type { Conversation } from "../types";
import type { MatrixConnectionStatus, MatrixEventSummary } from "../services/matrix/session";
import { createEncryptedRoom } from "../services/matrix/encryption";

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
  };
}
