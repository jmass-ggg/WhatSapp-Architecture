import type { MatrixClient, MatrixEvent, Room, SyncState } from "matrix-js-sdk";

import type { Conversation, MatrixSession } from "../../types";
import {
  createAuthenticatedMatrixClient,
  isMatrixAuthenticationError,
  MatrixSessionError,
  type MatrixClientFactory,
  verifyMatrixClientIdentity,
} from "./client";
import { conversationsFromMatrixClient, legacyEncryptedRoomIds } from "./rooms";

export type MatrixConnectionStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "disconnected";

export interface MatrixEventSummary {
  eventId: string;
  roomId: string;
  senderId: string;
  eventType: string;
  timestamp: number;
}

export interface MatrixConnectionSnapshot {
  status: MatrixConnectionStatus;
  initialSyncComplete: boolean;
  rooms: Conversation[];
  /** IDs of retired encrypted rooms hidden from the UI (inventory only). */
  legacyRoomIds: string[];
  recentEvents: MatrixEventSummary[];
  error: string | null;
  authenticationError: boolean;
}

export const EMPTY_MATRIX_CONNECTION_SNAPSHOT: MatrixConnectionSnapshot = {
  status: "disabled",
  initialSyncComplete: false,
  rooms: [],
  legacyRoomIds: [],
  recentEvents: [],
  error: null,
  authenticationError: false,
};

type SnapshotListener = () => void;

const SYNC_RETRY_MESSAGE = "Matrix sync is interrupted. The SDK is retrying automatically.";

export class MatrixClientSession {
  private clientInstance: MatrixClient | null = null;
  private sdk: typeof import("matrix-js-sdk") | null = null;
  private readonly seenEventIds = new Set<string>();
  private retainCount = 0;
  private releaseGeneration = 0;
  private disposed = false;
  private authFailure = false;
  private refreshQueued = false;
  private readonly factory?: MatrixClientFactory;

  private snapshot: MatrixConnectionSnapshot = {
    ...EMPTY_MATRIX_CONNECTION_SNAPSHOT,
    status: "connecting",
  };
  private listeners = new Set<SnapshotListener>();

  private readonly onSync = (
    state: SyncState,
    _previousState: SyncState | null,
    data?: { error?: Error; catchingUp?: boolean },
  ) => {
    if (this.disposed) return;
    const syncStates = this.sdk?.SyncState;
    if (!syncStates) return;

    switch (state) {
      case syncStates.Prepared:
        this.publish({
          status: "connected",
          initialSyncComplete: true,
          ...this.readRooms(),
          error: null,
          authenticationError: false,
        });
        break;
      case syncStates.Syncing:
        this.publish({
          status:
            data?.catchingUp && this.snapshot.initialSyncComplete
              ? "reconnecting"
              : this.snapshot.initialSyncComplete
                ? "connected"
                : "connecting",
          ...(this.snapshot.initialSyncComplete ? this.readRooms() : {}),
          error: null,
          authenticationError: false,
        });
        break;
      case syncStates.Catchup:
      case syncStates.Reconnecting:
        this.publish({ status: "reconnecting", error: null, authenticationError: false });
        break;
      case syncStates.Error:
        if (data?.error && isMatrixAuthenticationError(data.error)) {
          this.failAuthentication();
        } else {
          this.publish({
            status: this.snapshot.initialSyncComplete ? "reconnecting" : "connecting",
            error: SYNC_RETRY_MESSAGE,
            authenticationError: false,
          });
        }
        break;
      case syncStates.Stopped:
        if (!this.authFailure) {
          this.publish({
            ...EMPTY_MATRIX_CONNECTION_SNAPSHOT,
            status: this.disposed ? "disabled" : "disconnected",
          });
        }
        break;
    }
  };

  private readonly onUnexpectedSyncError = (_error: Error) => {
    if (this.disposed || this.authFailure) return;
    this.publish({
      status: this.snapshot.initialSyncComplete ? "reconnecting" : "connecting",
      error: SYNC_RETRY_MESSAGE,
      authenticationError: false,
    });
  };

  private readonly onClientRoom = (_room: Room) => this.scheduleRoomRefresh();
  private readonly onDeleteRoom = (_roomId: string) => this.scheduleRoomRefresh();
  private readonly onTimeline = (event: MatrixEvent) => {
    this.recordEvent(event);
    this.scheduleRoomRefresh();
  };
  private readonly onRoomUpdate = () => this.scheduleRoomRefresh();
  private readonly onLiveEvent = (event: MatrixEvent) => {
    this.recordEvent(event);
    this.scheduleRoomRefresh();
  };

  constructor(
    readonly session: MatrixSession,
    readonly expectedUserId: string,
    factory?: MatrixClientFactory,
  ) {
    this.factory = factory;
    void this.initialize();
  }

  get client(): MatrixClient | null {
    return this.clientInstance;
  }

  readonly subscribe = (listener: SnapshotListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): MatrixConnectionSnapshot => this.snapshot;

  retain(): () => void {
    if (this.disposed) throw new Error("The Matrix session has been stopped.");
    this.retainCount += 1;
    this.releaseGeneration += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retainCount = Math.max(0, this.retainCount - 1);
      const generation = ++this.releaseGeneration;
      if (this.retainCount === 0) {
        queueMicrotask(() => {
          if (this.retainCount === 0 && this.releaseGeneration === generation) {
            this.dispose();
          }
        });
      }
    };
  }

  matches(session: MatrixSession, expectedUserId: string): boolean {
    return !this.disposed && this.expectedUserId === expectedUserId && this.matchesSession(session);
  }

  matchesSession(session: MatrixSession): boolean {
    return (
      this.session.access_token === session.access_token &&
      this.session.user_id === session.user_id &&
      this.session.device_id === session.device_id
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.clientInstance?.stopClient();
    } finally {
      this.detachListeners();
    }
    this.clientInstance = null;
    this.snapshot = { ...EMPTY_MATRIX_CONNECTION_SNAPSHOT };
    for (const listener of this.listeners) listener();
    this.listeners.clear();
    this.seenEventIds.clear();
  }

  private attachListeners(): void {
    const client = this.clientInstance;
    const sdk = this.sdk;
    if (!client || !sdk) return;
    client.on(sdk.ClientEvent.Sync, this.onSync);
    client.on(sdk.ClientEvent.SyncUnexpectedError, this.onUnexpectedSyncError);
    client.on(sdk.ClientEvent.Room, this.onClientRoom);
    client.on(sdk.ClientEvent.DeleteRoom, this.onDeleteRoom);
    client.on(sdk.ClientEvent.Event, this.onLiveEvent);
    client.on(sdk.RoomEvent.Timeline, this.onTimeline);
    client.on(sdk.RoomEvent.LocalEchoUpdated, this.onRoomUpdate);
    client.on(sdk.RoomEvent.Name, this.onRoomUpdate);
    client.on(sdk.RoomEvent.MyMembership, this.onRoomUpdate);
    client.on(sdk.RoomEvent.Receipt, this.onRoomUpdate);
    client.on(sdk.RoomStateEvent.Events, this.onRoomUpdate);
    client.on(sdk.RoomStateEvent.Members, this.onRoomUpdate);
    client.on(sdk.RoomStateEvent.Update, this.onRoomUpdate);
    client.on(sdk.RoomMemberEvent.Membership, this.onRoomUpdate);
    client.on(sdk.RoomMemberEvent.Name, this.onRoomUpdate);
    client.on(sdk.RoomMemberEvent.Typing, this.onRoomUpdate);
  }

  private detachListeners(): void {
    const client = this.clientInstance;
    const sdk = this.sdk;
    if (!client || !sdk) return;
    client.removeListener(sdk.ClientEvent.Sync, this.onSync);
    client.removeListener(sdk.ClientEvent.SyncUnexpectedError, this.onUnexpectedSyncError);
    client.removeListener(sdk.ClientEvent.Room, this.onClientRoom);
    client.removeListener(sdk.ClientEvent.DeleteRoom, this.onDeleteRoom);
    client.removeListener(sdk.ClientEvent.Event, this.onLiveEvent);
    client.removeListener(sdk.RoomEvent.Timeline, this.onTimeline);
    client.removeListener(sdk.RoomEvent.LocalEchoUpdated, this.onRoomUpdate);
    client.removeListener(sdk.RoomEvent.Name, this.onRoomUpdate);
    client.removeListener(sdk.RoomEvent.MyMembership, this.onRoomUpdate);
    client.removeListener(sdk.RoomEvent.Receipt, this.onRoomUpdate);
    client.removeListener(sdk.RoomStateEvent.Events, this.onRoomUpdate);
    client.removeListener(sdk.RoomStateEvent.Members, this.onRoomUpdate);
    client.removeListener(sdk.RoomStateEvent.Update, this.onRoomUpdate);
    client.removeListener(sdk.RoomMemberEvent.Membership, this.onRoomUpdate);
    client.removeListener(sdk.RoomMemberEvent.Name, this.onRoomUpdate);
    client.removeListener(sdk.RoomMemberEvent.Typing, this.onRoomUpdate);
  }

  private async initialize(): Promise<void> {
    let phase: "identity" | "sync" = "identity";
    let client: MatrixClient | null = null;
    try {
      this.sdk = await import("matrix-js-sdk");
      if (this.disposed) return;
      client = await createAuthenticatedMatrixClient(
        this.session,
        this.expectedUserId,
        this.factory,
      );
      this.clientInstance = client;
      if (this.disposed) {
        client.stopClient();
        this.clientInstance = null;
        return;
      }
      this.attachListeners();
      await verifyMatrixClientIdentity(client, this.session, this.expectedUserId);
      if (this.disposed || this.authFailure) return;
      phase = "sync";
      await client.startClient({ initialSyncLimit: 30, pollTimeout: 30_000 });
    } catch (error) {
      if (this.disposed) return;
      if (isMatrixAuthenticationError(error)) {
        this.failAuthentication();
        return;
      }
      if (phase !== "sync") {
        client?.stopClient();
        this.detachListeners();
      }
      this.publish({
        status: "error",
        error:
          error instanceof MatrixSessionError
            ? error.message
            : phase === "identity"
              ? "The authenticated Matrix client could not be initialized."
              : "The Matrix sync client could not be started. Check the homeserver connection and sign in again if needed.",
        authenticationError: false,
      });
    }
  }

  private failAuthentication(): void {
    if (this.authFailure || this.disposed) return;
    this.authFailure = true;
    this.publish({
      status: "error",
      error: "The Matrix session expired or was revoked. Sign out and sign in again.",
      authenticationError: true,
    });
    this.clientInstance?.stopClient();
  }

  private recordEvent(event: MatrixEvent): void {
    if (this.disposed) return;
    const eventId = event.getId();
    const roomId = event.getRoomId();
    if (!eventId || !roomId || this.seenEventIds.has(eventId)) return;

    this.seenEventIds.add(eventId);
    const recentEvents = [
      ...this.snapshot.recentEvents,
      {
        eventId,
        roomId,
        senderId: event.getSender() ?? "",
        eventType: event.getWireType(),
        timestamp: event.getTs(),
      },
    ].slice(-100);
    while (this.seenEventIds.size > 500) {
      const oldest = this.seenEventIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.seenEventIds.delete(oldest);
    }
    this.publish({ recentEvents });
  }

  private scheduleRoomRefresh(): void {
    if (this.disposed || !this.snapshot.initialSyncComplete || this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (!this.disposed && this.snapshot.initialSyncComplete) {
        this.publish(this.readRooms());
      }
    });
  }

  private readRooms(): Pick<MatrixConnectionSnapshot, "rooms" | "legacyRoomIds"> {
    const client = this.clientInstance;
    const userId = client?.getUserId();
    if (!client || !userId) return { rooms: [], legacyRoomIds: [] };
    const rooms = client.getRooms();
    return {
      rooms: conversationsFromMatrixClient(rooms, userId),
      legacyRoomIds: legacyEncryptedRoomIds(rooms),
    };
  }

  private publish(update: Partial<MatrixConnectionSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}

export interface MatrixClientLease {
  manager: MatrixClientSession;
  release: () => void;
}

export class MatrixClientRegistry {
  private active: MatrixClientSession | null = null;

  acquire(
    session: MatrixSession,
    expectedUserId: string,
    factory?: MatrixClientFactory,
  ): MatrixClientLease {
    if (this.active && !this.active.matches(session, expectedUserId)) {
      this.active.dispose();
      this.active = null;
    }
    if (!this.active) {
      this.active = new MatrixClientSession(session, expectedUserId, factory);
    }
    return { manager: this.active, release: this.active.retain() };
  }

  stop(session?: MatrixSession | null): void {
    if (!this.active || (session && !this.active.matchesSession(session))) return;
    this.active.dispose();
    this.active = null;
  }
}

export const matrixClientRegistry = new MatrixClientRegistry();

export function stopManagedMatrixSession(session?: MatrixSession | null): void {
  matrixClientRegistry.stop(session);
}
