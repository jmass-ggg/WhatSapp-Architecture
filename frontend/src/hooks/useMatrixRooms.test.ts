import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createEncryptedRoomMock, matrixSnapshot } = vi.hoisted(() => ({
  createEncryptedRoomMock: vi.fn(),
  matrixSnapshot: {
    client: {
      getRooms: vi.fn((): unknown[] => []),
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
  MATRIX_GROUP_MARKER_TYPE: "org.recruitable.chat.group",
}));

import { useMatrixRooms } from "./useMatrixRooms";

describe("useMatrixRooms", () => {
  beforeEach(() => {
    createEncryptedRoomMock.mockReset();
    matrixSnapshot.client.getRooms.mockClear();
    matrixSnapshot.client.getRooms.mockReturnValue([]);
    matrixSnapshot.cryptoStatus = "ready";
    matrixSnapshot.cryptoOnboardingStatus = "ready";
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

  it("does not reuse a one-member group as a direct conversation", async () => {
    const groupRoom = {
      getMyMembership: () => "join",
      hasEncryptionStateEvent: () => true,
      currentState: {
        getStateEvents: (type: string) =>
          type === "org.recruitable.chat.group"
            ? { getContent: () => ({ version: 1 }) }
            : null,
      },
      getMembers: () => [
        {
          userId: "@peer:localhost",
          membership: "join",
        },
      ],
    };
    matrixSnapshot.client.getRooms.mockReturnValue([groupRoom]);
    const { result } = renderHook(() => useMatrixRooms());

    await result.current.createDirect("peer-id", "Peer", "@peer:localhost");

    expect(createEncryptedRoomMock).toHaveBeenCalledOnce();
  });

  it("does not create a conversation before encryption onboarding is ready", async () => {
    matrixSnapshot.cryptoOnboardingStatus = "restore_encryption";
    const { result } = renderHook(() => useMatrixRooms());

    await expect(
      result.current.createDirect("peer-id", "Peer", "@peer:localhost"),
    ).rejects.toThrow(/finish secure messaging setup/i);
    expect(createEncryptedRoomMock).not.toHaveBeenCalled();
  });

  it("creates a private encrypted group and shares in-flight requests", async () => {
    const { result } = renderHook(() => useMatrixRooms());
    const invitees = ["@bob:localhost", "@charlie:localhost"];

    const [first, second] = await Promise.all([
      result.current.createGroup("Development Team", invitees),
      result.current.createGroup("Development Team", invitees),
    ]);

    expect(first).toBe("!direct:localhost");
    expect(second).toBe("!direct:localhost");
    expect(createEncryptedRoomMock).toHaveBeenCalledOnce();
    expect(createEncryptedRoomMock).toHaveBeenCalledWith(
      matrixSnapshot.client,
      {
        invitees,
        name: "Development Team",
        isDirect: false,
        isGroup: true,
      },
    );
  });

  it("rejects duplicate or insufficient group participants", async () => {
    const { result } = renderHook(() => useMatrixRooms());
    await expect(
      result.current.createGroup("Development Team", ["@bob:localhost"]),
    ).rejects.toThrow(/at least two different/i);
    await expect(
      result.current.createGroup("Development Team", [
        "@bob:localhost",
        "@bob:localhost",
      ]),
    ).rejects.toThrow(/at least two different/i);
    expect(createEncryptedRoomMock).not.toHaveBeenCalled();
  });
});
