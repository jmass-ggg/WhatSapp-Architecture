import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createPlainRoomMock, matrixSnapshot } = vi.hoisted(() => ({
  createPlainRoomMock: vi.fn(),
  matrixSnapshot: {
    client: {
      getRooms: vi.fn((): unknown[] => []),
      getUserId: vi.fn(() => "@self:localhost"),
    },
    rooms: [],
    status: "connected",
    initialSyncComplete: true,
    legacyRoomIds: [],
    error: null,
    authenticationError: false,
    recentEvents: [],
  },
}));

vi.mock("../context/MatrixContext", () => ({
  useMatrixContext: () => matrixSnapshot,
}));

vi.mock("../services/matrix/messaging", () => ({
  createPlainRoom: createPlainRoomMock,
  isLegacyEncryptedRoom: (room: { hasEncryptionStateEvent?: () => boolean }) =>
    Boolean(room.hasEncryptionStateEvent?.()),
  MATRIX_GROUP_MARKER_TYPE: "org.recruitable.chat.group",
}));

import { useMatrixRooms } from "./useMatrixRooms";

describe("useMatrixRooms", () => {
  beforeEach(() => {
    createPlainRoomMock.mockReset();
    matrixSnapshot.client.getRooms.mockClear();
    matrixSnapshot.client.getRooms.mockReturnValue([]);
    createPlainRoomMock.mockResolvedValue("!direct:localhost");
  });

  it("shares an in-flight plaintext room creation for the same Matrix user", async () => {
    const { result } = renderHook(() => useMatrixRooms());

    const [first, second] = await Promise.all([
      result.current.createDirect("peer-id", "Peer", "@peer:localhost"),
      result.current.createDirect("peer-id", "Peer", "@peer:localhost"),
    ]);

    expect(first).toBe("!direct:localhost");
    expect(second).toBe("!direct:localhost");
    expect(createPlainRoomMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a one-member group as a direct conversation", async () => {
    const groupRoom = {
      getMyMembership: () => "join",
      hasEncryptionStateEvent: () => false,
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

    expect(createPlainRoomMock).toHaveBeenCalledOnce();
  });

  it("never reuses a retired encrypted direct room", async () => {
    const encryptedDirect = {
      roomId: "!old:localhost",
      getMyMembership: () => "join",
      hasEncryptionStateEvent: () => true,
      currentState: { getStateEvents: () => null },
      getMembers: () => [{ userId: "@peer:localhost", membership: "join" }],
    };
    matrixSnapshot.client.getRooms.mockReturnValue([encryptedDirect]);
    const { result } = renderHook(() => useMatrixRooms());

    await expect(
      result.current.createDirect("peer-id", "Peer", "@peer:localhost"),
    ).resolves.toBe("!direct:localhost");
    expect(createPlainRoomMock).toHaveBeenCalledOnce();
  });

  it("reuses an existing plaintext direct room instead of creating a duplicate", async () => {
    const plainDirect = {
      roomId: "!plain:localhost",
      getMyMembership: () => "join",
      hasEncryptionStateEvent: () => false,
      currentState: { getStateEvents: () => null },
      getMembers: () => [
        { userId: "@self:localhost", membership: "join" },
        { userId: "@peer:localhost", membership: "join" },
      ],
    };
    matrixSnapshot.client.getRooms.mockReturnValue([plainDirect]);
    const { result } = renderHook(() => useMatrixRooms());

    await expect(
      result.current.createDirect("peer-id", "Peer", "@peer:localhost"),
    ).resolves.toBe("!plain:localhost");
    expect(createPlainRoomMock).not.toHaveBeenCalled();
  });

  it("creates a private plaintext group and shares in-flight requests", async () => {
    const { result } = renderHook(() => useMatrixRooms());
    const invitees = ["@bob:localhost", "@charlie:localhost"];

    const [first, second] = await Promise.all([
      result.current.createGroup("Development Team", invitees),
      result.current.createGroup("Development Team", invitees),
    ]);

    expect(first).toBe("!direct:localhost");
    expect(second).toBe("!direct:localhost");
    expect(createPlainRoomMock).toHaveBeenCalledOnce();
    expect(createPlainRoomMock).toHaveBeenCalledWith(
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
    expect(createPlainRoomMock).not.toHaveBeenCalled();
  });
});
