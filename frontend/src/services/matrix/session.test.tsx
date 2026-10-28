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
import {
  encodeRecoveryKey,
  OnlySignedDevicesIsolationMode,
  VerificationPhase,
  VerificationRequestEvent,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import type {
  CryptoCallbacks,
  SecretStorageStatus,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { describe, expect, it, vi } from "vitest";

import type { MatrixSession } from "../../types";
import type { MatrixClientFactory } from "./client";
import type { MatrixCryptoLockProvider } from "./session";
import {
  MatrixClientRegistry,
  MatrixClientSession,
} from "./session";

const userA = "@u_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:localhost";
const userB = "@u_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:localhost";
const testLockProvider: MatrixCryptoLockProvider = async () => () => undefined;
const fakeCrypto = {
  setDeviceIsolationMode: vi.fn(),
  getVersion: () => "Rust SDK test",
  getOwnDeviceKeys: async () => ({
    ed25519: "public-device-fingerprint",
    curve25519: "public-identity-key",
  }),
  isCrossSigningReady: async () => false,
  isSecretStorageReady: async () => false,
  getSecretStorageStatus: async (): Promise<SecretStorageStatus> => ({
    ready: false,
    defaultKeyId: null,
    secretStorageKeyValidityMap: {},
  }),
  getKeyBackupInfo: async () => null,
  checkKeyBackupAndEnable: async () => null,
  isKeyBackupTrusted: async () => ({ trusted: true }),
  createRecoveryKeyFromPassphrase: vi.fn(async () => {
    const privateKey = new Uint8Array(32).fill(29);
    return {
      privateKey,
      encodedPrivateKey: encodeRecoveryKey(privateKey),
    };
  }),
  bootstrapSecretStorage: vi.fn(async () => undefined),
  bootstrapCrossSigning: vi.fn(async () => undefined),
  resetKeyBackup: vi.fn(async () => undefined),
  loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => undefined),
  restoreKeyBackup: vi.fn(async () => ({ imported: 0, total: 0 })),
  requestVerificationDM: vi.fn(),
  getCrossSigningStatus: async () => ({
    publicKeysOnDevice: false,
    privateKeysInSecretStorage: false,
    privateKeysCachedLocally: {
      masterKey: false,
      selfSigningKey: false,
      userSigningKey: false,
    },
  }),
};

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
  readonly initRustCrypto = vi.fn(async () => undefined);
  readonly whoami = vi.fn(async () => ({
    user_id: this.userId,
    device_id: this.deviceId,
  }));
  readonly secretStorage = {
    getDefaultKeyId: vi.fn(async () => null),
  };
  cryptoCallbacks: CryptoCallbacks | undefined;
  rooms: Room[] = [];

  constructor(
    private readonly userId: string,
    private readonly deviceId: string,
    private readonly cryptoApi: object = fakeCrypto,
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

  getCrypto() {
    return this.cryptoApi;
  }

  getRooms(): Room[] {
    return this.rooms;
  }

  getRoom(roomId: string): Room | null {
    return this.rooms.find((candidate) => candidate.roomId === roomId) ?? null;
  }
}

function factoryFor(client: FakeMatrixClient): MatrixClientFactory {
  return (options: IMatrixClientCreateOpts) => {
    client.cryptoCallbacks = options.cryptoCallbacks;
    return client as unknown as MatrixClient;
  };
}

function room(roomId: string, name: string): Room {
  return {
    roomId,
    name,
    getMembers: () => [],
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getMyMembership: () => "join",
    getJoinedMembers: () => [],
    getMember: () => null,
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
  it("automatically prepares one recovery key for a new account and completes setup", async () => {
    const generatedKey = new Uint8Array(32).fill(61);
    const generated = {
      privateKey: generatedKey,
      encodedPrivateKey: encodeRecoveryKey(generatedKey),
    };
    let defaultKeyId: string | null = null;
    let secretStorageReady = false;
    let crossSigningReady = false;
    let failCrossSigningOnce = true;
    let backupInfo: { version: string } | null = null;
    let client!: FakeMatrixClient;
    const crypto = {
      ...fakeCrypto,
      isCrossSigningReady: vi.fn(async () => crossSigningReady),
      isSecretStorageReady: vi.fn(async () => secretStorageReady),
      getSecretStorageStatus: vi.fn(async () => ({
        ready: secretStorageReady,
        defaultKeyId,
        secretStorageKeyValidityMap: {},
      })),
      getKeyBackupInfo: vi.fn(async () => backupInfo as never),
      checkKeyBackupAndEnable: vi.fn(async () =>
        backupInfo
          ? ({ backupInfo, trustInfo: { trusted: true } } as never)
          : null,
      ),
      getCrossSigningStatus: vi.fn(async () => ({
        publicKeysOnDevice: crossSigningReady,
        privateKeysInSecretStorage: secretStorageReady,
        privateKeysCachedLocally: {
          masterKey: false,
          selfSigningKey: false,
          userSigningKey: false,
        },
      })),
      createRecoveryKeyFromPassphrase: vi.fn(async () => generated),
      bootstrapSecretStorage: vi.fn(async (options: {
        createSecretStorageKey?: () => Promise<typeof generated>;
      }) => {
        if (!defaultKeyId) {
          const stored = await options.createSecretStorageKey?.();
          defaultKeyId = "secret-storage-key";
          if (stored) {
            client.cryptoCallbacks?.cacheSecretStorageKey?.(
              defaultKeyId,
              {} as never,
              stored.privateKey,
            );
          }
        }
        secretStorageReady = true;
      }),
      bootstrapCrossSigning: vi.fn(async () => {
        if (failCrossSigningOnce) {
          failCrossSigningOnce = false;
          throw new Error("temporary upload failure");
        }
        crossSigningReady = true;
      }),
      resetKeyBackup: vi.fn(async () => {
        backupInfo = { version: "backup-version" };
      }),
      isKeyBackupTrusted: vi.fn(async () => ({ trusted: true })),
    };
    client = new FakeMatrixClient(userA, "DEVICE_A", crypto);
    const manager = new MatrixClientSession(
      matrixSession(),
      userA,
      factoryFor(client),
      testLockProvider,
    );
    await waitForStart(client);

    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
      client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
    });
    await waitFor(() =>
      expect(manager.getSnapshot()).toMatchObject({
        cryptoOnboardingStatus: "save_recovery_key",
        pendingRecoveryKey: generated.encodedPrivateKey,
      }),
    );
    expect(crypto.createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(client.initRustCrypto).toHaveBeenCalledTimes(1);

    await expect(manager.confirmRecoveryKeySaved()).rejects.toThrow(
      /secure recovery setup did not complete/i,
    );
    expect(manager.getSnapshot().pendingRecoveryKey).toBe(
      generated.encodedPrivateKey,
    );

    await manager.confirmRecoveryKeySaved();

    expect(crypto.createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(crypto.bootstrapSecretStorage).toHaveBeenCalledTimes(2);
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expect(crypto.resetKeyBackup).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).toMatchObject({
      cryptoOnboardingStatus: "ready",
      pendingRecoveryKey: null,
      crossSigningReady: true,
      secretStorageReady: true,
      keyBackupStatus: "trusted",
    });
    manager.dispose();
  });

  it("preserves detected signing keys and asks for recovery instead of generating new keys", async () => {
    const createRecoveryKey = vi.fn(async () => {
      const privateKey = new Uint8Array(32).fill(37);
      return {
        privateKey,
        encodedPrivateKey: encodeRecoveryKey(privateKey),
      };
    });
    const crypto = {
      ...fakeCrypto,
      getCrossSigningStatus: async () => ({
        publicKeysOnDevice: true,
        privateKeysInSecretStorage: false,
        privateKeysCachedLocally: {
          masterKey: false,
          selfSigningKey: false,
          userSigningKey: false,
        },
      }),
      createRecoveryKeyFromPassphrase: createRecoveryKey,
    };
    const client = new FakeMatrixClient(userA, "DEVICE_A", crypto);
    const manager = new MatrixClientSession(
      matrixSession(),
      userA,
      factoryFor(client),
      testLockProvider,
    );
    await waitForStart(client);

    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
    });
    await waitFor(() =>
      expect(manager.getSnapshot().cryptoOnboardingStatus).toBe("incomplete"),
    );

    expect(createRecoveryKey).not.toHaveBeenCalled();
    expect(manager.getSnapshot().pendingRecoveryKey).toBeNull();
    await expect(manager.prepareRecoveryKey()).rejects.toThrow(
      /existing cross-signing keys were detected/i,
    );
    expect(createRecoveryKey).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("retries automatic recovery setup after a transient SDK failure", async () => {
    const privateKey = new Uint8Array(32).fill(45);
    const createRecoveryKey = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary SDK error"))
      .mockResolvedValueOnce({
        privateKey,
        encodedPrivateKey: encodeRecoveryKey(privateKey),
      });
    const crypto = {
      ...fakeCrypto,
      createRecoveryKeyFromPassphrase: createRecoveryKey,
    };
    const client = new FakeMatrixClient(userA, "DEVICE_A", crypto);
    const manager = new MatrixClientSession(
      matrixSession(),
      userA,
      factoryFor(client),
      testLockProvider,
    );
    await waitForStart(client);

    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
    });
    await waitFor(() =>
      expect(manager.getSnapshot().cryptoOnboardingStatus).toBe("incomplete"),
    );
    await manager.retryCryptoOnboarding();

    expect(createRecoveryKey).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot()).toMatchObject({
      cryptoOnboardingStatus: "save_recovery_key",
      pendingRecoveryKey: encodeRecoveryKey(privateKey),
    });
    manager.dispose();
  });

  it("restores existing encryption on a new device without generating account keys", async () => {
    const recoveryBytes = new Uint8Array(32).fill(77);
    const recoveryKey = encodeRecoveryKey(recoveryBytes);
    if (!recoveryKey) throw new Error("The test recovery key was not encoded.");
    const backupInfo = { version: "existing-backup" };
    let crossSigningReady = false;
    const createRecoveryKey = vi.fn();
    const crypto = {
      ...fakeCrypto,
      isCrossSigningReady: vi.fn(async () => crossSigningReady),
      isSecretStorageReady: vi.fn(async () => true),
      getSecretStorageStatus: vi.fn(async () => ({
        ready: false,
        defaultKeyId: "existing-secret-storage-key",
        secretStorageKeyValidityMap: {},
      })),
      getKeyBackupInfo: vi.fn(async () => backupInfo as never),
      checkKeyBackupAndEnable: vi.fn(async () => ({
        backupInfo,
        trustInfo: { trusted: true },
      }) as never),
      getCrossSigningStatus: vi.fn(async () => ({
        publicKeysOnDevice: true,
        privateKeysInSecretStorage: true,
        privateKeysCachedLocally: {
          masterKey: false,
          selfSigningKey: false,
          userSigningKey: false,
        },
      })),
      createRecoveryKeyFromPassphrase: createRecoveryKey,
      bootstrapCrossSigning: vi.fn(async () => {
        crossSigningReady = true;
      }),
      loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => undefined),
      restoreKeyBackup: vi.fn(async () => ({ imported: 4, total: 4 })),
    };
    const isolationMode = vi.fn();
    const client = new FakeMatrixClient(userA, "DEVICE_NEW", {
      ...crypto,
      setDeviceIsolationMode: isolationMode,
    });
    const manager = new MatrixClientSession(
      matrixSession(userA, "DEVICE_NEW", "new-device-token"),
      userA,
      factoryFor(client),
      testLockProvider,
    );
    await waitForStart(client);

    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
    });
    await waitFor(() =>
      expect(manager.getSnapshot().cryptoOnboardingStatus).toBe(
        "restore_encryption",
      ),
    );

    const restored = await manager.restoreFromRecoveryKey(recoveryKey);

    expect(restored).toEqual({ imported: 4, total: 4 });
    expect(createRecoveryKey).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledTimes(1);
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledOnce();
    expect(crypto.restoreKeyBackup).toHaveBeenCalledOnce();
    expect(manager.getSnapshot().cryptoOnboardingStatus).toBe("ready");
    expect(isolationMode).toHaveBeenCalledWith(
      expect.any(OnlySignedDevicesIsolationMode),
    );
    manager.dispose();
  });

  it("waits for PREPARED before marking the first sync complete", async () => {
    const registry = new MatrixClientRegistry(testLockProvider);
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
      testLockProvider,
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
      testLockProvider,
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

  it("uses in-room verification only for a joined one-to-one conversation", async () => {
    const roomId = "!direct:localhost";
    const request = {
      transactionId: "verification-transaction",
      roomId,
      initiatedByMe: true,
      otherUserId: userB,
      otherDeviceId: undefined,
      phase: VerificationPhase.Requested,
      verifier: undefined,
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const testRoom = {
      ...room(roomId, "Direct room"),
      getJoinedMembers: () => [
        { userId: userA },
        { userId: userB },
      ],
      getMember: (userId: string) =>
        userId === userB ? { membership: "join" } : null,
    } as unknown as Room;
    const groupRoom = {
      ...testRoom,
      getJoinedMembers: () => [
        { userId: userA },
        { userId: userB },
        { userId: "@u_cccccccccccccccccccccccccccccccc:localhost" },
      ],
    } as unknown as Room;
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    client.rooms = [groupRoom];
    vi.mocked(fakeCrypto.requestVerificationDM).mockResolvedValueOnce(
      request as never,
    );
    const manager = new MatrixClientSession(
      matrixSession(),
      userA,
      factoryFor(client),
      testLockProvider,
    );
    await waitForStart(client);

    await expect(manager.requestVerificationDM(userB, roomId)).rejects.toThrow(
      /one-to-one conversation/,
    );
    expect(fakeCrypto.requestVerificationDM).not.toHaveBeenCalled();

    client.rooms = [testRoom];
    await manager.requestVerificationDM(userB, roomId);
    expect(fakeCrypto.requestVerificationDM).toHaveBeenCalledWith(userB, roomId);
    expect(manager.getSnapshot().verification).toMatchObject({
      id: "verification-transaction",
      userId: userB,
      initiatedByMe: true,
      state: "requested",
    });

    manager.dispose();
    expect(request.on).toHaveBeenCalledWith(
      VerificationRequestEvent.Change,
      expect.any(Function),
    );
  });

  it("rejects malformed recovery keys before touching secret storage", async () => {
    const secretStorageStatus = vi.spyOn(fakeCrypto, "getSecretStorageStatus");
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const manager = new MatrixClientSession(
      matrixSession(),
      userA,
      factoryFor(client),
      testLockProvider,
    );
    await waitForStart(client);

    await expect(
      manager.restoreFromRecoveryKey("not-a-Matrix-recovery-key"),
    ).rejects.toThrow(/recovery key format is invalid/);
    expect(secretStorageStatus).not.toHaveBeenCalled();
    manager.dispose();
    secretStorageStatus.mockRestore();
  });

  it("fails recovery safely when the account has no server-side backup", async () => {
    const recoveryKey = encodeRecoveryKey(new Uint8Array(32).fill(23));
    expect(recoveryKey).toBeTruthy();
    const secretStorageStatus = vi
      .spyOn(fakeCrypto, "getSecretStorageStatus")
      .mockResolvedValue({
        ready: true,
        defaultKeyId: "secret-storage-key",
        secretStorageKeyValidityMap: {},
      });
    const crossSigningStatus = vi
      .spyOn(fakeCrypto, "getCrossSigningStatus")
      .mockResolvedValue({
        publicKeysOnDevice: false,
        privateKeysInSecretStorage: false,
        privateKeysCachedLocally: {
          masterKey: false,
          selfSigningKey: false,
          userSigningKey: false,
        },
      });
    const backupInfo = vi
      .spyOn(fakeCrypto, "getKeyBackupInfo")
      .mockResolvedValue(null);
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    const manager = new MatrixClientSession(
      matrixSession(),
      userA,
      factoryFor(client),
      testLockProvider,
    );
    await waitForStart(client);

    await expect(
      manager.restoreFromRecoveryKey(recoveryKey!),
    ).rejects.toThrow(/Check the recovery key and backup status/);
    expect(secretStorageStatus).toHaveBeenCalled();
    expect(crossSigningStatus).toHaveBeenCalled();
    expect(backupInfo).toHaveBeenCalled();
    manager.dispose();
    secretStorageStatus.mockRestore();
    crossSigningStatus.mockRestore();
    backupInfo.mockRestore();
  });

  it("shares one client across StrictMode-style acquire/release and removes listeners on final release", async () => {
    const registry = new MatrixClientRegistry(testLockProvider);
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
    const registry = new MatrixClientRegistry(testLockProvider);
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
    const registry = new MatrixClientRegistry(testLockProvider);
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

  it("holds the crypto-store lock until an in-flight Rust initialization settles after disposal", async () => {
    let finishInitialization!: () => void;
    const initialization = new Promise<undefined>((resolve) => {
      finishInitialization = () => resolve(undefined);
    });
    const client = new FakeMatrixClient(userA, "DEVICE_A");
    client.initRustCrypto.mockReturnValue(initialization);
    const releaseLock = vi.fn();
    const lockProvider: MatrixCryptoLockProvider = async () => releaseLock;
    const manager = new MatrixClientSession(
      matrixSession(),
      userA,
      factoryFor(client),
      lockProvider,
    );

    await waitFor(() =>
      expect(client.initRustCrypto).toHaveBeenCalledTimes(1),
    );
    manager.dispose();
    expect(releaseLock).not.toHaveBeenCalled();

    finishInitialization();
    await waitFor(() => expect(releaseLock).toHaveBeenCalledTimes(1));
  });

  it("keeps an identity mismatch out of the syncing state", async () => {
    const registry = new MatrixClientRegistry(testLockProvider);
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
        cryptoStatus: "error",
        cryptoError: null,
      }),
    );
    expect(lease.manager.getSnapshot().error).toContain(
      "does not match the FastAPI session",
    );
    expect(client.initRustCrypto).not.toHaveBeenCalled();
    expect(client.startClient).not.toHaveBeenCalled();
    lease.release();
    await flushMicrotasks();
  });
});
