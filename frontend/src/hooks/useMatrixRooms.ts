import { useCallback } from "react";

import { useMatrixContext } from "../context/MatrixContext";
import type { Conversation } from "../types";
import type { MatrixConnectionStatus, MatrixEventSummary } from "../services/matrix/session";
import { createEncryptedRoom } from "../services/matrix/encryption";

export interface UseMatrixRoomsResult {
  rooms: Conversation[];
  status: MatrixConnectionStatus;
  initialSyncComplete: boolean;
  cryptoStatus: ReturnType<typeof useMatrixContext>["cryptoStatus"];
  error: string | null;
  authenticationError: boolean;
  recentEvents: MatrixEventSummary[];
  createDirect: (
    userId: string,
    displayName: string,
    matrixUserId: string,
  ) => Promise<string>;
  createEncryptedGroup: (
    displayName: string,
    matrixUserIds: string[],
  ) => Promise<string>;
}

export function useMatrixRooms(): UseMatrixRoomsResult {
  const {
    client,
    rooms,
    status,
    initialSyncComplete,
    cryptoStatus,
    error,
    authenticationError,
    recentEvents,
  } = useMatrixContext();

  const createDirect = useCallback(
    async (_userId: string, displayName: string, matrixUserId: string) => {
      if (!client) throw new Error("Sign in to start a conversation.");
      return createEncryptedRoom(client, {
        invitees: [matrixUserId],
        name: displayName,
        isDirect: true,
      });
    },
    [client],
  );
  const createEncryptedGroup = useCallback(
    async (displayName: string, matrixUserIds: string[]) => {
      if (!client) throw new Error("Sign in to start an encrypted group.");
      return createEncryptedRoom(client, {
        invitees: matrixUserIds,
        name: displayName,
        isDirect: false,
      });
    },
    [client],
  );

  return {
    rooms,
    status,
    initialSyncComplete,
    cryptoStatus,
    error,
    authenticationError,
    recentEvents,
    createDirect,
    createEncryptedGroup,
  };
}
