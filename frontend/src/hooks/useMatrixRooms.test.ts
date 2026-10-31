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

vi.mock("../services/matrix/messaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/matrix/messaging")>()),
  createPlainRoom: createPlainRoomMock,
}));

import { useMatrixRooms } from "./useMatrixRooms";

const SELF = "@self:localhost";
const marker = { getContent: () => ({ version: 1 }) };
function fakeRoom(
  roomId: string,
  opts: {
    peers?: string[];
    membership?: "join" | "invite";
    encrypted?: boolean;
    markerType?: string;
    events?: number;
  } = {},
) {
  const members = [
    { userId: SELF, membership: "join", name: "Me", typing: false, events: { member: { getContent: () => ({}) } } },
    ...(opts.peers ?? []).map((userId) => ({
      userId, membership: "join", name: userId.slice(1, 5), typing: false,
      events: { member: { getContent: () => ({}) } },
    })),
  ];
  return {
    roomId,
    name: roomId,
    currentState: {
      getStateEvents: (type: string) => (type === opts.markerType ? marker : null),
    },
    getMembers: () => members,
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getMyMembership: () => opts.membership ?? "join",
    hasEncryptionStateEvent: () => Boolean(opts.encrypted),
    getUnreadNotificationCount: () => 0,
    getLastActiveTimestamp: () => opts.events ?? 0,
    guessDMUserId: () => opts.peers?.[0],
    getMxcAvatarUrl: () => null,
  };
}

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

  it("creates a room for an accepted contact with no room", async () => {
    const { result } = renderHook(() => useMatrixRooms());
    await expect(result.current.createDirect("p", "Peer", "@peer:localhost"))
      .resolves.toBe("!direct:localhost");
    expect(createPlainRoomMock).toHaveBeenCalledOnce();
  });

  it("does not reuse a one-member group as a direct conversation", async () => {
    matrixSnapshot.client.getRooms.mockReturnValue([
      fakeRoom("!group:localhost", { peers: ["@peer:localhost"], markerType: "org.recruitable.chat.group" }),
    ]);
    const { result } = renderHook(() => useMatrixRooms());
    await result.current.createDirect("p", "Peer", "@peer:localhost");
    expect(createPlainRoomMock).toHaveBeenCalledOnce();
  });

  it("does not reuse a multi-member room as a direct conversation", async () => {
    matrixSnapshot.client.getRooms.mockReturnValue([
      fakeRoom("!legacy-group:localhost", { peers: ["@peer:localhost", "@other:localhost"] }),
    ]);
    const { result } = renderHook(() => useMatrixRooms());
    await result.current.createDirect("p", "Peer", "@peer:localhost");
    expect(createPlainRoomMock).toHaveBeenCalledOnce();
  });

  it("never reuses a retired encrypted direct room", async () => {
    matrixSnapshot.client.getRooms.mockReturnValue([
      fakeRoom("!old:localhost", { peers: ["@peer:localhost"], encrypted: true }),
    ]);
    const { result } = renderHook(() => useMatrixRooms());
    await expect(result.current.createDirect("p", "Peer", "@peer:localhost"))
      .resolves.toBe("!direct:localhost");
    expect(createPlainRoomMock).toHaveBeenCalledOnce();
  });

  it("reuses an existing plaintext direct room (refresh, repeated refreshes)", async () => {
    matrixSnapshot.client.getRooms.mockReturnValue([
      fakeRoom("!plain:localhost", { peers: ["@peer:localhost"] }),
    ]);
    for (let refresh = 0; refresh < 5; refresh += 1) {
      const { result, unmount } = renderHook(() => useMatrixRooms());
      await expect(result.current.createDirect("p", "Peer", "@peer:localhost"))
        .resolves.toBe("!plain:localhost");
      unmount();
    }
    expect(createPlainRoomMock).not.toHaveBeenCalled();
  });

  it("mounting the hook never creates a room by itself", () => {
    renderHook(() => useMatrixRooms());
    renderHook(() => useMatrixRooms());
    expect(createPlainRoomMock).not.toHaveBeenCalled();
  });

  it("reuses a pending direct invitation instead of creating a room", async () => {
    matrixSnapshot.client.getRooms.mockReturnValue([
      fakeRoom("!invite:localhost", { peers: ["@peer:localhost"], membership: "invite" }),
    ]);
    const { result } = renderHook(() => useMatrixRooms());
    await expect(result.current.createDirect("p", "Peer", "@peer:localhost"))
      .resolves.toBe("!invite:localhost");
    expect(createPlainRoomMock).not.toHaveBeenCalled();
  });

  it("picks the same primary among existing duplicates, preferring joined rooms", async () => {
    matrixSnapshot.client.getRooms.mockReturnValue([
      fakeRoom("!b-dup:localhost", { peers: ["@peer:localhost"], membership: "invite" }),
      fakeRoom("!z-dup:localhost", { peers: ["@peer:localhost"] }),
      fakeRoom("!a-dup:localhost", { peers: ["@peer:localhost"] }),
    ]);
    const { result } = renderHook(() => useMatrixRooms());
    await expect(result.current.createDirect("p", "Peer", "@peer:localhost"))
      .resolves.toBe("!a-dup:localhost");
    expect(createPlainRoomMock).not.toHaveBeenCalled();
  });

  it("waits for the initial sync before discovering or creating", async () => {
    matrixSnapshot.initialSyncComplete = false;
    try {
      const { result } = renderHook(() => useMatrixRooms());
      await expect(result.current.createDirect("p", "Peer", "@peer:localhost"))
        .rejects.toThrow(/finish syncing/i);
      expect(createPlainRoomMock).not.toHaveBeenCalled();
    } finally {
      matrixSnapshot.initialSyncComplete = true;
    }
  });

  it("finds a room that arrives after delayed member synchronization", async () => {
    const { result } = renderHook(() => useMatrixRooms());
    matrixSnapshot.client.getRooms.mockReturnValue([
      fakeRoom("!late:localhost", { peers: ["@peer:localhost"] }),
    ]);
    await expect(result.current.createDirect("p", "Peer", "@peer:localhost"))
      .resolves.toBe("!late:localhost");
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
