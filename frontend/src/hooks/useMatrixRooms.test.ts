import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createEncryptedRoomMock, matrixSnapshot } = vi.hoisted(() => ({
  createEncryptedRoomMock: vi.fn(),
  matrixSnapshot: {
    client: {
      getRooms: vi.fn(() => []),
      getUserId: vi.fn(() => "@self:localhost"),
    },
    rooms: [],
    status: "connected",
    initialSyncComplete: true,
    cryptoStatus: "ready",
    cryptoOnboardingStatus: "ready",
    error: null,
    authenticationError: false,
    recentEvents: [],
  },
}));

vi.mock("../context/MatrixContext", () => ({
  useMatrixContext: () => matrixSnapshot,
}));

vi.mock("../services/matrix/encryption", () => ({
  createEncryptedRoom: createEncryptedRoomMock,
}));

import { useMatrixRooms } from "./useMatrixRooms";

describe("useMatrixRooms", () => {
  beforeEach(() => {
    createEncryptedRoomMock.mockReset();
    matrixSnapshot.client.getRooms.mockClear();
    createEncryptedRoomMock.mockResolvedValue("!direct:localhost");
  });

  it("shares an in-flight encrypted room creation for the same Matrix user", async () => {
    const { result } = renderHook(() => useMatrixRooms());

    const [first, second] = await Promise.all([
      result.current.createDirect("peer-id", "Peer", "@peer:localhost"),
      result.current.createDirect("peer-id", "Peer", "@peer:localhost"),
    ]);

    expect(first).toBe("!direct:localhost");
    expect(second).toBe("!direct:localhost");
    expect(createEncryptedRoomMock).toHaveBeenCalledTimes(1);
  });

  it("does not create a conversation before encryption onboarding is ready", async () => {
    matrixSnapshot.cryptoOnboardingStatus = "restore_encryption";
    const { result } = renderHook(() => useMatrixRooms());

    await expect(
      result.current.createDirect("peer-id", "Peer", "@peer:localhost"),
    ).rejects.toThrow(/finish secure messaging setup/i);
    expect(createEncryptedRoomMock).not.toHaveBeenCalled();
    matrixSnapshot.cryptoOnboardingStatus = "ready";
  });
});
