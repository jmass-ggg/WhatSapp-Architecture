import {
  ClientEvent,
  MatrixEvent,
  RoomEvent,
  SyncState,
  type IMatrixClientCreateOpts,
  type MatrixClient,
  type Room,
} from "matrix-js-sdk";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MatrixSession } from "../../types";
import type { MatrixClientFactory } from "./client";
import { UserEvent } from "matrix-js-sdk";
import { MatrixClientRegistry, MatrixClientSession } from "./session";

const userA = "@u_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:localhost";
const userB = "@u_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:localhost";

function matrixSession(userId = userA, deviceId = "DEVICE_A", accessToken = "token-a"): MatrixSession {
  return { access_token: accessToken, user_id: userId, device_id: deviceId, home_server: "localhost", expires_in_ms: null };
}

type Listener = (...args: unknown[]) => void;

class FakeMatrixClient {
  private readonly handlers = new Map<string, Set<Listener>>();
  readonly startClient = vi.fn(async () => undefined);
  readonly stopClient = vi.fn();
  readonly whoami = vi.fn(async () => ({ user_id: this.userId, device_id: this.deviceId }));
  /** Any crypto call would be a regression: the session must never touch crypto. */
  readonly initRustCrypto = vi.fn(async () => undefined);
  readonly getCrypto = vi.fn(() => undefined);
  readonly getPresence = vi.fn(async (_userId: string): Promise<{ presence?: string }> => ({ presence: "online" }));
  rooms: Room[] = [];
  options: IMatrixClientCreateOpts | undefined;

  constructor(private readonly userId: string, private readonly deviceId: string) {}

  on(event: string, listener: Listener): this {
    const listeners = this.handlers.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.handlers.set(event, listeners);
    return this;
  }
  removeListener(event: string, listener: Listener): this {
    this.handlers.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) listener(...args);
  }
  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
  getUserId() { return this.userId; }
  getDeviceId() { return this.deviceId; }
  getRooms() { return this.rooms; }
  getRoom(roomId: string) { return this.rooms.find((r) => r.roomId === roomId) ?? null; }
}

function factoryFor(client: FakeMatrixClient): MatrixClientFactory {
  return (options) => {
    client.options = options;
    return client as unknown as MatrixClient;
  };
}

function room(roomId: string, name: string, encrypted = false): Room {
  return {
    roomId,
    name,
    getMembers: () => [],
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getMyMembership: () => "join",
    getMember: () => null,
    hasEncryptionStateEvent: () => encrypted,
    currentState: { getStateEvents: () => null },
    getUnreadNotificationCount: () => 0,
    getLastActiveTimestamp: () => 0,
    guessDMUserId: () => "",
    getReadReceiptForUserId: () => null,
  } as unknown as Room;
}

function liveMessage(eventId = "$live:localhost"): MatrixEvent {
  return new MatrixEvent({
    event_id: eventId,
    room_id: "!room:localhost",
    sender: userB,
    type: "m.room.message",
    origin_server_ts: 1_750_000_000_000,
    content: { msgtype: "m.text", body: "arrived live" },
  });
}

const waitForStart = (client: FakeMatrixClient) =>
  waitFor(() => expect(client.startClient).toHaveBeenCalledTimes(1));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Matrix client session lifecycle (plaintext)", () => {
  it("starts sync without initializing any crypto", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);

    expect(client.initRustCrypto).not.toHaveBeenCalled();
    expect(client.getCrypto).not.toHaveBeenCalled();
    expect(client.options).not.toHaveProperty("cryptoCallbacks");
    expect(client.options).not.toHaveProperty("verificationMethods");
    expect(client.options).toMatchObject({ accessToken: "token-a", userId: userA, deviceId: "DEVICE_A" });
    expect(client.startClient).toHaveBeenCalledWith({ initialSyncLimit: 30, pollTimeout: 30_000 });
    manager.dispose();
  });

  it("publishes rooms after the first sync and hides retired encrypted rooms", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    client.rooms = [room("!plain:localhost", "Plain"), room("!old:localhost", "Old", true)];
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);

    expect(manager.getSnapshot().status).toBe("connecting");
    client.emit(ClientEvent.Sync, SyncState.Prepared, null);
    const snapshot = manager.getSnapshot();
    expect(snapshot.status).toBe("connected");
    expect(snapshot.initialSyncComplete).toBe(true);
    expect(snapshot.rooms.map((r) => r.roomId)).toEqual(["!plain:localhost"]);
    expect(snapshot.legacyRoomIds).toEqual(["!old:localhost"]);
    manager.dispose();
  });

  it("refreshes rooms on live events and records only event metadata", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);
    client.emit(ClientEvent.Sync, SyncState.Prepared, null);

    client.rooms = [room("!room:localhost", "New room")];
    client.emit(RoomEvent.Timeline, liveMessage());
    await flush();

    expect(manager.getSnapshot().rooms.map((r) => r.roomId)).toEqual(["!room:localhost"]);
    expect(manager.getSnapshot().recentEvents).toEqual([
      { eventId: "$live:localhost", roomId: "!room:localhost", senderId: userB, eventType: "m.room.message", timestamp: 1_750_000_000_000 },
    ]);
    manager.dispose();
  });

  it("reports reconnection and recovers", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);
    client.emit(ClientEvent.Sync, SyncState.Prepared, null);

    client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing);
    expect(manager.getSnapshot().status).toBe("reconnecting");
    client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Reconnecting);
    expect(manager.getSnapshot().status).toBe("connected");
    manager.dispose();
  });

  it("flags expired Matrix sessions as an authentication error and stops sync", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);

    client.emit(ClientEvent.Sync, SyncState.Error, null, { error: Object.assign(new Error("x"), { errcode: "M_UNKNOWN_TOKEN" }) });
    expect(manager.getSnapshot()).toMatchObject({ status: "error", authenticationError: true });
    expect(client.stopClient).toHaveBeenCalled();
    manager.dispose();
  });

  it("refuses a Matrix identity that differs from the application user", async () => {
    const client = new FakeMatrixClient(userB, "DEVICE_A");
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitFor(() => expect(manager.getSnapshot().status).toBe("error"));
    expect(client.startClient).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("detaches every listener and stops the client on dispose", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);
    expect(client.listenerCount(ClientEvent.Sync)).toBe(1);

    manager.dispose();
    expect(client.stopClient).toHaveBeenCalled();
    expect(client.listenerCount(ClientEvent.Sync)).toBe(0);
    expect(client.listenerCount(RoomEvent.Timeline)).toBe(0);
    expect(manager.getSnapshot().status).toBe("disabled");
  });
});

describe("Matrix presence integration", () => {
  const peer = "@u_cccccccccccccccccccccccccccccccc:localhost";
  const directRoom = () => ({
    ...room("!dm:localhost", "Peer"),
    getMembers: () => [{ userId: peer, membership: "join", name: "Peer", typing: false, events: { member: { getContent: () => ({}) } } }],
  }) as unknown as Room;

  it("reads initial presence for direct-chat peers once and reacts to live updates", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    client.rooms = [directRoom()];
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);
    client.emit(ClientEvent.Sync, SyncState.Prepared, null);
    await waitFor(() => expect(manager.getSnapshot().presence[peer]).toBe("online"));

    client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Prepared);
    expect(client.getPresence).toHaveBeenCalledTimes(1);

    client.emit(UserEvent.Presence, undefined, { userId: peer, presence: "offline" });
    expect(manager.getSnapshot().presence[peer]).toBe("offline");
    manager.dispose();
  });

  it("drops stale presence while reconnecting and re-reads it afterwards", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    client.rooms = [directRoom()];
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);
    client.emit(ClientEvent.Sync, SyncState.Prepared, null);
    await waitFor(() => expect(manager.getSnapshot().presence[peer]).toBe("online"));

    client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing);
    expect(manager.getSnapshot().presence).toEqual({});
    client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Reconnecting);
    await waitFor(() => expect(client.getPresence).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(manager.getSnapshot().presence[peer]).toBe("online"));
    manager.dispose();
  });

  it("reports unknown when the server forbids reading presence", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    client.rooms = [directRoom()];
    client.getPresence.mockRejectedValue(Object.assign(new Error("forbidden"), { httpStatus: 403 }));
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);
    client.emit(ClientEvent.Sync, SyncState.Prepared, null);
    await waitFor(() => expect(manager.getSnapshot().presence[peer]).toBe("unknown"));
    manager.dispose();
  });

  it("does not request presence for groups or invitations and removes its listener on dispose", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const invited = { ...directRoom(), roomId: "!inv:localhost", getMyMembership: () => "invite" } as unknown as Room;
    client.rooms = [invited];
    const manager = new MatrixClientSession(matrixSession(), userA, factoryFor(client));
    await waitForStart(client);
    expect(client.listenerCount(UserEvent.Presence)).toBe(1);
    client.emit(ClientEvent.Sync, SyncState.Prepared, null);
    expect(client.getPresence).not.toHaveBeenCalled();

    manager.dispose();
    expect(client.listenerCount(UserEvent.Presence)).toBe(0);
  });
});

describe("Matrix client registry", () => {
  it("shares one session per identity and replaces it for another user", async () => {
    const registry = new MatrixClientRegistry();
    const clientA = new FakeMatrixClient(userA, "DEVICE_A");
    const clientB = new FakeMatrixClient(userB, "DEVICE_B");

    const first = registry.acquire(matrixSession(), userA, factoryFor(clientA));
    const second = registry.acquire(matrixSession(), userA, factoryFor(clientA));
    expect(second.manager).toBe(first.manager);

    const other = registry.acquire(matrixSession(userB, "DEVICE_B", "token-b"), userB, factoryFor(clientB));
    expect(other.manager).not.toBe(first.manager);
    expect(first.manager.getSnapshot().status).toBe("disabled");
    registry.stop();
  });

  it("only stops the session that matches the given credentials", async () => {
    const registry = new MatrixClientRegistry();
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const lease = registry.acquire(matrixSession(), userA, factoryFor(client));

    registry.stop(matrixSession(userB, "DEVICE_B", "token-b"));
    expect(lease.manager.getSnapshot().status).not.toBe("disabled");
    registry.stop(matrixSession());
    expect(lease.manager.getSnapshot().status).toBe("disabled");
  });
});
