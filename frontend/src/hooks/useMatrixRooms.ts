import { useCallback } from "react";

import { useMatrixContext } from "../context/MatrixContext";
import type { Conversation } from "../types";
import type { MatrixConnectionStatus, MatrixEventSummary } from "../services/matrix/session";

export interface UseMatrixRoomsResult {
  rooms: Conversation[];
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
}

export function useMatrixRooms(): UseMatrixRoomsResult {
  const {
    client,
    rooms,
    status,
    initialSyncComplete,
    error,
    authenticationError,
    recentEvents,
  } = useMatrixContext();

  const createDirect = useCallback(
    async (_userId: string, displayName: string, matrixUserId: string) => {
      if (!client) throw new Error("Sign in to start a conversation.");
      const { Preset, Visibility } = await import("matrix-js-sdk");
      const result = await client.createRoom({
        visibility: Visibility.Private,
        preset: Preset.TrustedPrivateChat,
        is_direct: true,
        invite: [matrixUserId],
        name: displayName,
      });
      return result.room_id;
    },
    [client],
  );

  return {
    rooms,
    status,
    initialSyncComplete,
    error,
    authenticationError,
    recentEvents,
    createDirect,
  };
}
