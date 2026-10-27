import {
  ClientEvent,
  MatrixEvent,
  RoomEvent,
  SyncState,
  type IMatrixClientCreateOpts,
  type MatrixClient,
  type Room,
} from "matrix-js-sdk";
import { useSyncExternalStore } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MatrixSession } from "../../types";
import type { MatrixClientFactory } from "./client";
import {
  MatrixClientRegistry,
  MatrixClientSession,
} from "./session";

const userA = "@u_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:localhost";
const userB = "@u_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:localhost";

function matrixSession(
  userId = userA,
  deviceId = "DEVICE_A",
  accessToken = "token-a",
): MatrixSession {
  return {
    access_token: accessToken,
    user_id: userId,
    device_id: deviceId,
    home_server: "localhost",
    expires_in_ms: null,
  };
}

type Listener = (...args: unknown[]) => void;

class FakeMatrixClient {
  private readonly handlers = new Map<string, Set<Listener>>();
  readonly startClient = vi.fn(async () => undefined);
  readonly stopClient = vi.fn();
  readonly whoami = vi.fn(async () => ({
    user_id: this.userId,
    device_id: this.deviceId,
  }));
  rooms: Room[] = [];

  constructor(
    private readonly userId: string,
    private readonly deviceId: string,
  ) {}

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
    for (const listener of this.handlers.get(event) ?? []) {
      listener(...args);
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  getUserId(): string {
    return this.userId;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getRooms(): Room[] {
    return this.rooms;
  }
}

function factoryFor(client: FakeMatrixClient): MatrixClientFactory {
  return (_options: IMatrixClientCreateOpts) =>
    client as unknown as MatrixClient;
}

function room(roomId: string, name: string): Room {
  return {
    roomId,
    name,
    getMembers: () => [],
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getMyMembership: () => "join",
    hasEncryptionStateEvent: () => false,
    getUnreadNotificationCount: () => 0,
    getLastActiveTimestamp: () => 0,
    guessDMUserId: () => "",
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

async function waitForStart(client: FakeMatrixClient): Promise<void> {
  await waitFor(() => expect(client.startClient).toHaveBeenCalledTimes(1));
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Matrix client session lifecycle", () => {
  it("waits for PREPARED before marking the first sync complete", async () => {
    const registry = new MatrixClientRegistry();
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const lease = registry.acquire(
      matrixSession(),
      userA,
      factoryFor(client),
    );

    expect(lease.manager.getSnapshot()).toMatchObject({
      status: "connecting",
      initialSyncComplete: false,
      rooms: [],
    });
    await waitForStart(client);
    expect(client.startClient).toHaveBeenCalledTimes(1);

    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
    });
    expect(lease.manager.getSnapshot()).toMatchObject({
      status: "connected",
      initialSyncComplete: true,
    });

    lease.release();
    await flushMicrotasks();
  });

  it("reports reconnecting and returns to connected when SDK sync resumes", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const manager = new MatrixClientSession(
      matrixSession(),
      userA,
      factoryFor(client),
    );
    await waitForStart(client);

    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
      client.emit(
        ClientEvent.Sync,
        SyncState.Reconnecting,
        SyncState.Syncing,
        {},
      );
    });
    expect(manager.getSnapshot().status).toBe("reconnecting");

    act(() => {
      client.emit(
        ClientEvent.Sync,
        SyncState.Syncing,
        SyncState.Reconnecting,
        { catchingUp: false },
      );
    });
    expect(manager.getSnapshot()).toMatchObject({
      status: "connected",
      initialSyncComplete: true,
    });
    manager.dispose();
  });

  it("deduplicates live timeline event IDs and updates the room snapshot", async () => {
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const testRoom = room("!room:localhost", "Live room");
    client.rooms = [testRoom];
    const manager = new MatrixClientSession(
      matrixSession(),
      userA,
      factoryFor(client),
    );
    await waitForStart(client);
    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
    });

    const message = liveMessage();
    act(() => {
      client.emit(ClientEvent.Event, message);
      client.emit(RoomEvent.Timeline, message, testRoom, false, false, {});
    });

    expect(manager.getSnapshot().recentEvents).toEqual([
      {
        eventId: "$live:localhost",
        roomId: "!room:localhost",
        senderId: userB,
        eventType: "m.room.message",
        timestamp: 1_750_000_000_000,
      },
    ]);
    expect(manager.getSnapshot().rooms.map((item) => item.id)).toEqual([
      "!room:localhost",
    ]);

    manager.dispose();
  });

  it("shares one client across StrictMode-style acquire/release and removes listeners on final release", async () => {
    const registry = new MatrixClientRegistry();
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const factory = vi.fn(factoryFor(client));
    const first = registry.acquire(matrixSession(), userA, factory);
    first.release();
    const second = registry.acquire(matrixSession(), userA, factory);

    await waitForStart(client);
    await flushMicrotasks();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.stopClient).not.toHaveBeenCalled();

    let renderCount = 0;
    const rendered = renderHook(() => {
      renderCount += 1;
      return useSyncExternalStore(
        second.manager.subscribe,
        second.manager.getSnapshot,
      );
    });
    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
    });
    expect(renderCount).toBeGreaterThan(1);

    rendered.unmount();
    const countAfterUnmount = renderCount;
    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing, {});
    });
    expect(renderCount).toBe(countAfterUnmount);

    second.release();
    await flushMicrotasks();
    expect(client.stopClient).toHaveBeenCalledTimes(1);
    expect(client.listenerCount(ClientEvent.Sync)).toBe(0);
  });

  it("isolates rooms when switching accounts", async () => {
    const registry = new MatrixClientRegistry();
    const clientA = new FakeMatrixClient(userA, "DEVICE_A");
    clientA.rooms = [room("!private-a:localhost", "A private room")];
    const leaseA = registry.acquire(
      matrixSession(),
      userA,
      factoryFor(clientA),
    );
    await waitForStart(clientA);
    act(() => {
      clientA.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
    });
    expect(leaseA.manager.getSnapshot().rooms[0]?.id).toBe(
      "!private-a:localhost",
    );

    const clientB = new FakeMatrixClient(userB, "DEVICE_B");
    clientB.rooms = [room("!private-b:localhost", "B private room")];
    const leaseB = registry.acquire(
      matrixSession(userB, "DEVICE_B", "token-b"),
      userB,
      factoryFor(clientB),
    );

    expect(clientA.stopClient).toHaveBeenCalledTimes(1);
    expect(leaseB.manager.getSnapshot().rooms).toEqual([]);
    await waitForStart(clientB);
    act(() => {
      clientB.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
    });
    expect(leaseB.manager.getSnapshot().rooms.map((item) => item.id)).toEqual([
      "!private-b:localhost",
    ]);

    leaseA.release();
    leaseB.release();
    await flushMicrotasks();
  });

  it("stops instead of retrying when Synapse rejects an expired token", async () => {
    const registry = new MatrixClientRegistry();
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    client.whoami.mockRejectedValue({ httpStatus: 401 });
    const lease = registry.acquire(
      matrixSession(),
      userA,
      factoryFor(client),
    );

    await waitFor(() =>
      expect(lease.manager.getSnapshot()).toMatchObject({
        status: "error",
        authenticationError: true,
      }),
    );
    expect(client.startClient).not.toHaveBeenCalled();
    expect(client.stopClient).toHaveBeenCalledTimes(1);
    lease.release();
    await flushMicrotasks();
  });

  it("keeps an identity mismatch out of the syncing state", async () => {
    const registry = new MatrixClientRegistry();
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    client.whoami.mockResolvedValue({
      user_id: userB,
      device_id: "DEVICE_A",
    });
    const lease = registry.acquire(
      matrixSession(),
      userA,
      factoryFor(client),
    );

    await waitFor(() =>
      expect(lease.manager.getSnapshot()).toMatchObject({
        status: "error",
        initialSyncComplete: false,
      }),
    );
    expect(client.startClient).not.toHaveBeenCalled();
    lease.release();
    await flushMicrotasks();
  });
});
