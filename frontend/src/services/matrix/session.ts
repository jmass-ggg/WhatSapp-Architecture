import type {
  MatrixClient,
  MatrixEvent,
  Room,
  SyncState,
} from "matrix-js-sdk";
import { MatrixEventEvent } from "matrix-js-sdk";
import {
  CryptoEvent,
  OnlySignedDevicesIsolationMode,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import type {
  CryptoApi,
  KeyBackupRestoreResult,
  ShowSasCallbacks,
  VerificationRequest,
  Verifier,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import type { Device } from "matrix-js-sdk";

import type { Conversation, MatrixSession } from "../../types";
import type {
  MatrixCryptoOnboardingStatus,
  MatrixCryptoStatus,
  MatrixKeyBackupStatus,
  MatrixVerificationSnapshot,
  MatrixVerificationState,
} from "../../types/matrix";
import {
  createAuthenticatedMatrixClient,
  getMatrixHomeserverUrl,
  isMatrixAuthenticationError,
  MatrixSessionError,
  type MatrixClientFactory,
  verifyMatrixClientIdentity,
} from "./client";
import {
  acquireMatrixCryptoStoreLock,
  MatrixCryptoStoreError,
  matrixCryptoStoreIdentity,
} from "./crypto-store";
import type { MatrixCryptoStoreIdentity } from "./crypto-store";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/index.js";
import { conversationsFromMatrixClient } from "./rooms";
import { SecretStorageKeyController } from "./secret-storage";

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
  recentEvents: MatrixEventSummary[];
  error: string | null;
  authenticationError: boolean;
  cryptoStatus: MatrixCryptoStatus;
  cryptoOnboardingStatus: MatrixCryptoOnboardingStatus;
  cryptoError: string | null;
  cryptoVersion: string | null;
  deviceId: string | null;
  ownFingerprint: string | null;
  crossSigningReady: boolean | null;
  secretStorageReady: boolean | null;
  keyBackupStatus: MatrixKeyBackupStatus;
  keyBackupVersion: string | null;
  verification: MatrixVerificationSnapshot | null;
}

export const EMPTY_MATRIX_CONNECTION_SNAPSHOT: MatrixConnectionSnapshot = {
  status: "disabled",
  initialSyncComplete: false,
  rooms: [],
  recentEvents: [],
  error: null,
  authenticationError: false,
  cryptoStatus: "disabled",
  cryptoOnboardingStatus: "checking",
  cryptoError: null,
  cryptoVersion: null,
  deviceId: null,
  ownFingerprint: null,
  crossSigningReady: null,
  secretStorageReady: null,
  keyBackupStatus: "checking",
  keyBackupVersion: null,
  verification: null,
};

type SnapshotListener = () => void;
export type MatrixCryptoLockProvider = (
  lockName: string,
) => Promise<() => void>;

export interface MatrixDeviceSummary {
  userId: string;
  deviceId: string;
  displayName: string | null;
  fingerprint: string | null;
  verified: boolean;
  signedByOwner: boolean;
  crossSigningVerified: boolean;
}

function verificationStateFromPhase(
  phase: VerificationPhase,
): MatrixVerificationState {
  switch (phase) {
    case VerificationPhase.Requested:
      return "requested";
    case VerificationPhase.Ready:
      return "ready";
    case VerificationPhase.Started:
      return "started";
    case VerificationPhase.Done:
      return "done";
    case VerificationPhase.Cancelled:
      return "cancelled";
    case VerificationPhase.Unsent:
    default:
      return "requested";
  }
}

export class MatrixClientSession {
  private clientInstance: MatrixClient | null = null;
  private sdk: typeof import("matrix-js-sdk") | null = null;
  private crypto: CryptoApi | null = null;
  private readonly secretStorageKeys = new SecretStorageKeyController();
  private cryptoStoreLockRelease: (() => void) | null = null;
  private cryptoStoreIdentity: MatrixCryptoStoreIdentity | null = null;
  private cryptoOnboardingAttempt: Promise<void> | null = null;
  private cryptoOnboardingEvaluated = false;
  private readonly verificationRequests = new Map<
    string,
    {
      request: VerificationRequest;
      onChange: () => void;
    }
  >();
  private readonly verificationRequestIds = new WeakMap<
    VerificationRequest,
    string
  >();
  private currentSasCallbacks: ShowSasCallbacks | null = null;
  private readonly verifierBindings = new Map<
    string,
    {
      verifier: Verifier;
      onShowSas: (callbacks: NonNullable<ReturnType<Verifier["getShowSasCallbacks"]>>) => void;
      onCancel: () => void;
    }
  >();
  private readonly decryptedEventListeners = new Map<
    MatrixEvent,
    (event: MatrixEvent, error?: Error) => void
  >();
  private readonly seenEventIds = new Set<string>();
  private retainCount = 0;
  private releaseGeneration = 0;
  private disposed = false;
  private initializationFinished = false;
  private authFailure = false;
  private refreshQueued = false;
  private readonly factory?: MatrixClientFactory;
  private readonly lockProvider: MatrixCryptoLockProvider;

  private snapshot: MatrixConnectionSnapshot = {
    ...EMPTY_MATRIX_CONNECTION_SNAPSHOT,
    status: "connecting",
    cryptoStatus: "initializing",
    cryptoOnboardingStatus: "checking",
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
          rooms: this.readRooms(),
          error: null,
          authenticationError: false,
        });
        void this.refreshCryptoStatus();
        if (!this.cryptoOnboardingEvaluated) {
          void this.checkCryptoOnboarding();
        }
        break;
      case syncStates.Syncing:
        this.publish({
          status:
            data?.catchingUp && this.snapshot.initialSyncComplete
              ? "reconnecting"
              : this.snapshot.initialSyncComplete
                ? "connected"
                : "connecting",
          rooms: this.snapshot.initialSyncComplete
            ? this.readRooms()
            : this.snapshot.rooms,
          error: null,
          authenticationError: false,
        });
        break;
      case syncStates.Catchup:
      case syncStates.Reconnecting:
        this.publish({
          status: "reconnecting",
          error: null,
          authenticationError: false,
        });
        break;
      case syncStates.Error:
        if (data?.error && isMatrixAuthenticationError(data.error)) {
          this.failAuthentication();
        } else {
          this.publish({
            status: this.snapshot.initialSyncComplete
              ? "reconnecting"
              : "connecting",
            error: "Matrix sync is interrupted. The SDK is retrying automatically.",
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
      error: "Matrix sync is interrupted. The SDK is retrying automatically.",
      authenticationError: false,
    });
  };

  private readonly onClientRoom = (_room: Room) => this.scheduleRoomRefresh();
  private readonly onDeleteRoom = (_roomId: string) => this.scheduleRoomRefresh();
  private readonly onTimeline = (
    event: MatrixEvent,
    _room: Room | undefined,
    _toStartOfTimeline?: boolean,
    _removed?: boolean,
  ) => {
    this.watchForDecryption(event);
    this.recordEvent(event);
    this.scheduleRoomRefresh();
  };
  private readonly onRoomUpdate = () => this.scheduleRoomRefresh();
  private readonly onLiveEvent = (event: MatrixEvent) => {
    this.watchForDecryption(event);
    this.recordEvent(event);
    this.scheduleRoomRefresh();
  };
  private readonly onVerificationRequest = (request: VerificationRequest) => {
    this.trackVerificationRequest(request);
  };
  private readonly onCryptoDevicesUpdated = () => {
    void this.refreshCryptoStatus();
  };
  private readonly onUserTrustChanged = () => {
    void this.refreshCryptoStatus();
  };

  constructor(
    readonly session: MatrixSession,
    readonly expectedUserId: string,
    factory?: MatrixClientFactory,
    lockProvider: MatrixCryptoLockProvider = acquireMatrixCryptoStoreLock,
    readonly newAccount = false,
  ) {
    this.factory = factory;
    this.lockProvider = lockProvider;
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

  async restoreFromRecoveryKey(
    encodedRecoveryKey: string,
  ): Promise<KeyBackupRestoreResult> {
    const crypto = this.requireCrypto();
    const normalized = encodedRecoveryKey.trim();
    let recoveryKey: Uint8Array;
    try {
      recoveryKey = decodeRecoveryKey(normalized);
    } catch {
      throw new Error("The recovery key format is invalid.");
    }

    try {
      const secretStorageStatus = await crypto.getSecretStorageStatus();
      const keyId = secretStorageStatus.defaultKeyId;
      if (!keyId) {
        throw new Error("This Matrix account has no configured recovery key.");
      }

      return await this.secretStorageKeys.withRecoveryKey(
        keyId,
        recoveryKey,
        async () => {
          const crossSigningStatus = await crypto.getCrossSigningStatus();
          if (
            crossSigningStatus.publicKeysOnDevice &&
            !(
              await crypto.isCrossSigningReady()
            )
          ) {
            if (
              !crossSigningStatus.privateKeysInSecretStorage &&
              !Object.values(
                crossSigningStatus.privateKeysCachedLocally,
              ).some(Boolean)
            ) {
              throw new Error(
                "This account has no recoverable cross-signing private keys.",
              );
            }
            await crypto.bootstrapCrossSigning({
              authUploadDeviceSigningKeys: async (makeRequest) =>
                makeRequest(null),
            });
          }

          const backupInfo = await crypto.getKeyBackupInfo();
          if (!backupInfo) {
            throw new Error("This Matrix account has no server-side key backup.");
          }
          const backupCheck = await crypto.checkKeyBackupAndEnable();
          if (!backupCheck?.trustInfo.trusted) {
            throw new Error("The server-side key backup is not trusted.");
          }

          await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
          const result = await crypto.restoreKeyBackup();
          await this.refreshCryptoStatus();
          this.publish({ cryptoError: null });
          this.cryptoOnboardingEvaluated = false;
          await this.checkCryptoOnboarding();
          return result;
        },
      );
    } catch {
      this.publish({
        cryptoError:
          "History recovery failed. The recovery key or trusted server backup may be unavailable.",
      });
      throw new Error(
        "History recovery failed. Check the recovery key and backup status.",
      );
    } finally {
      recoveryKey.fill(0);
    }
  }

  async getDevices(userId: string): Promise<MatrixDeviceSummary[]> {
    const crypto = this.requireCrypto();
    const deviceMap = await crypto.getUserDeviceInfo([userId], true);
    const devices = deviceMap.get(userId);
    if (!devices) return [];

    return Promise.all(
      [...devices.values()].map((device: Device) =>
        this.deviceSummary(crypto, userId, device),
      ),
    );
  }

  async requestDeviceVerification(
    userId: string,
    deviceId: string,
  ): Promise<void> {
    const crypto = this.requireCrypto();
    const request = await crypto.requestDeviceVerification(userId, deviceId);
    this.trackVerificationRequest(request);
  }

  async requestVerificationDM(userId: string, roomId: string): Promise<void> {
    const crypto = this.requireCrypto();
    const client = this.clientInstance;
    const room = client?.getRoom(roomId);
    const ownUserId = client?.getUserId();
    const joinedMembers = room?.getJoinedMembers() ?? [];
    const peerIsJoined = room?.getMember(userId)?.membership === "join";

    if (
      !room ||
      !ownUserId ||
      userId === ownUserId ||
      room.getMyMembership() !== "join" ||
      !peerIsJoined ||
      joinedMembers.length !== 2
    ) {
      throw new Error(
        "Contact verification requires a joined one-to-one conversation with that user.",
      );
    }

    const request = await crypto.requestVerificationDM(userId, roomId);
    this.trackVerificationRequest(request);
  }

  async acceptVerificationRequest(requestId: string): Promise<void> {
    const request = this.getVerificationRequest(requestId);
    await request.accept();
  }

  async beginSasVerification(requestId: string): Promise<void> {
    const request = this.getVerificationRequest(requestId);
    if (request.phase !== VerificationPhase.Ready) {
      throw new Error("The verification request is not ready for emoji SAS.");
    }
    const verifier = await request.startVerification("m.sas.v1");
    this.runVerifier(request, verifier);
  }

  async confirmSasMatch(requestId: string): Promise<void> {
    const current = this.snapshot.verification;
    const callbacks = this.currentSasCallbacks;
    if (!current || current.id !== requestId || !callbacks) {
      throw new Error("There is no active emoji verification to confirm.");
    }
    await callbacks.confirm();
  }

  async cancelVerification(requestId: string): Promise<void> {
    const request = this.getVerificationRequest(requestId);
    const verifier = this.verifierBindings.get(requestId)?.verifier;
    const callbacks = this.currentSasCallbacks;
    if (callbacks && this.snapshot.verification?.id === requestId) {
      callbacks.cancel();
    } else if (verifier) {
      verifier.cancel(new Error("Verification cancelled by the user."));
    } else {
      await request.cancel({ reason: "Verification cancelled by the user." });
    }
    this.publishVerification(request, requestId, "cancelled", [], null);
  }

  private requireCrypto(): CryptoApi {
    if (this.disposed || this.snapshot.cryptoStatus !== "ready" || !this.crypto) {
      throw new Error(
        "Matrix Rust crypto is not ready. Encrypted operations are unavailable.",
      );
    }
    return this.crypto;
  }

  async retryCryptoOnboarding(): Promise<void> {
    if (this.snapshot.cryptoStatus !== "ready") {
      throw new Error("Secure messaging is still initializing. Try again shortly.");
    }
    this.cryptoOnboardingEvaluated = false;
    await this.checkCryptoOnboarding();
  }

  private async checkCryptoOnboarding(): Promise<void> {
    if (this.disposed || this.cryptoOnboardingEvaluated) return;
    if (this.cryptoOnboardingAttempt) return this.cryptoOnboardingAttempt;

    const attempt = (async () => {
      const crypto = this.crypto;
      if (!crypto || this.snapshot.cryptoStatus !== "ready") return;

      try {
        const [
          crossSigningReady,
          secretStorageStatus,
          backupCheck,
          backupInfo,
          crossSigningStatus,
          accountHasCrossSigningKeys,
        ] = await Promise.all([
          crypto.isCrossSigningReady(),
          crypto.getSecretStorageStatus(),
          crypto.checkKeyBackupAndEnable(),
          crypto.getKeyBackupInfo(),
          crypto.getCrossSigningStatus(),
          crypto.userHasCrossSigningKeys(this.expectedUserId, true),
        ]);
        if (this.disposed) return;

        const currentBackup = backupCheck?.backupInfo ?? backupInfo;
        const backupTrust = currentBackup
          ? backupCheck?.trustInfo ??
            (await crypto.isKeyBackupTrusted(currentBackup))
          : null;
        const backupTrusted = backupTrust?.trusted === true;
        const hasCrossSigningKeys =
          accountHasCrossSigningKeys ||
          crossSigningStatus.publicKeysOnDevice ||
          crossSigningStatus.privateKeysInSecretStorage ||
          Object.values(crossSigningStatus.privateKeysCachedLocally).some(
            Boolean,
          );

        if (
          crossSigningReady &&
          (!currentBackup || backupTrusted)
        ) {
          this.publish({
            crossSigningReady,
            secretStorageReady: secretStorageStatus.ready,
            keyBackupStatus: !currentBackup
              ? "not_configured"
              : "trusted",
            keyBackupVersion: currentBackup?.version ?? null,
            cryptoOnboardingStatus: "ready",
            cryptoError: null,
          });
          this.cryptoOnboardingEvaluated = true;
          return;
        }

        const accountHasRecoveryState =
          Boolean(secretStorageStatus.defaultKeyId) ||
          Boolean(currentBackup) ||
          hasCrossSigningKeys ||
          secretStorageStatus.ready;
        if (!accountHasRecoveryState) {
          if (!this.newAccount) {
            this.publish({
              crossSigningReady,
              secretStorageReady: secretStorageStatus.ready,
              keyBackupStatus: "not_configured",
              keyBackupVersion: null,
              cryptoOnboardingStatus: "incomplete",
              cryptoError:
                "No existing cross-signing identity or recovery backup was found. Existing accounts are not assigned a replacement identity automatically.",
            });
            this.cryptoOnboardingEvaluated = true;
            return;
          }

          await crypto.bootstrapCrossSigning({
            authUploadDeviceSigningKeys: async (makeRequest) =>
              makeRequest(null),
          });
          const crossSigningIsReady = await crypto.isCrossSigningReady();
          if (!crossSigningIsReady) {
            throw new Error("Cross-signing was not ready after setup.");
          }

          const [
            updatedSecretStorageStatus,
            updatedBackupCheck,
            updatedBackupInfo,
          ] = await Promise.all([
            crypto.getSecretStorageStatus(),
            crypto.checkKeyBackupAndEnable(),
            crypto.getKeyBackupInfo(),
          ]);
          const updatedBackup =
            updatedBackupCheck?.backupInfo ?? updatedBackupInfo;
          const updatedBackupTrust = updatedBackup
            ? updatedBackupCheck?.trustInfo ??
              (await crypto.isKeyBackupTrusted(updatedBackup))
            : null;
          if (updatedBackup && !updatedBackupTrust?.trusted) {
            throw new Error(
              "An existing encrypted history backup could not be verified.",
            );
          }

          this.publish({
            crossSigningReady: crossSigningIsReady,
            secretStorageReady: updatedSecretStorageStatus.ready,
            keyBackupStatus: updatedBackup ? "trusted" : "not_configured",
            keyBackupVersion: updatedBackup?.version ?? null,
            cryptoOnboardingStatus: "ready",
            cryptoError: null,
          });
          this.cryptoOnboardingEvaluated = true;
          return;
        }

        this.publish({
          crossSigningReady,
          secretStorageReady: secretStorageStatus.ready,
          keyBackupStatus: !currentBackup
            ? "not_configured"
            : backupTrusted
              ? "trusted"
              : "untrusted",
          keyBackupVersion: currentBackup?.version ?? null,
          cryptoOnboardingStatus:
            secretStorageStatus.defaultKeyId || currentBackup
              ? "restore_encryption"
              : "incomplete",
          cryptoError: null,
        });
        this.cryptoOnboardingEvaluated = true;
      } catch {
        if (this.disposed) return;
        this.publish({
          cryptoOnboardingStatus: "incomplete",
          cryptoError:
            "Cross-signing could not be verified or initialized safely. No existing identity or backup was changed. Retry when your connection is available.",
        });
      }
    })();
    this.cryptoOnboardingAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.cryptoOnboardingAttempt === attempt) {
        this.cryptoOnboardingAttempt = null;
      }
    }
  }

  private async refreshCryptoStatus(): Promise<void> {
    const crypto = this.crypto;
    if (!crypto || this.disposed) return;

    try {
      const [crossSigningReady, secretStorageReady, backupCheck, backupInfo] =
        await Promise.all([
          crypto.isCrossSigningReady(),
          crypto.isSecretStorageReady(),
          crypto.checkKeyBackupAndEnable(),
          crypto.getKeyBackupInfo(),
        ]);
      if (this.disposed) return;

      const currentBackup = backupCheck?.backupInfo ?? backupInfo;
      const trusted =
        backupCheck?.trustInfo ??
        (currentBackup ? await crypto.isKeyBackupTrusted(currentBackup) : null);
      this.publish({
        crossSigningReady,
        secretStorageReady,
        keyBackupStatus: !currentBackup
          ? "not_configured"
          : trusted?.trusted
            ? "trusted"
            : "untrusted",
        keyBackupVersion: currentBackup?.version ?? null,
      });
    } catch {
      if (this.disposed) return;
      this.publish({
        keyBackupStatus: "error",
        cryptoError:
          "Crypto status could not be refreshed. Encrypted sending remains fail-closed.",
      });
    }
  }

  private async deviceSummary(
    crypto: CryptoApi,
    userId: string,
    device: Device,
  ): Promise<MatrixDeviceSummary> {
    const status = await crypto.getDeviceVerificationStatus(
      userId,
      device.deviceId,
    );
    return {
      userId,
      deviceId: device.deviceId,
      displayName: device.displayName ?? null,
      fingerprint: device.getFingerprint() ?? null,
      verified: status?.isVerified() ?? false,
      signedByOwner: status?.signedByOwner ?? false,
      crossSigningVerified: status?.crossSigningVerified ?? false,
    };
  }

  private trackVerificationRequest(request: VerificationRequest): void {
    if (this.disposed) return;

    const existingId = this.verificationRequestIds.get(request);
    if (existingId) {
      this.updateVerificationFromRequest(request, existingId);
      return;
    }

    const id =
      request.transactionId ??
      `${request.otherUserId}:${request.otherDeviceId ?? "device"}:${crypto.randomUUID()}`;
    this.verificationRequestIds.set(request, id);
    const onChange = () => this.updateVerificationFromRequest(request, id);
    request.on(VerificationRequestEvent.Change, onChange);
    this.verificationRequests.set(id, { request, onChange });
    this.updateVerificationFromRequest(request, id);
  }

  private updateVerificationFromRequest(
    request: VerificationRequest,
    id: string,
  ): void {
    if (this.disposed) return;
    const phaseState = verificationStateFromPhase(request.phase);
    if (request.phase === VerificationPhase.Started && request.verifier) {
      this.runVerifier(request, request.verifier);
    }
    this.publishVerification(
      request,
      id,
      phaseState,
      this.snapshot.verification?.id === id
        ? this.snapshot.verification.emoji
        : [],
      this.snapshot.verification?.id === id
        ? this.snapshot.verification.error
        : null,
    );
  }

  private publishVerification(
    request: VerificationRequest,
    id: string,
    state: MatrixVerificationState,
    emoji: string[],
    error: string | null,
  ): void {
    this.publish({
      verification: {
        id,
        userId: request.otherUserId,
        deviceId: request.otherDeviceId ?? null,
        initiatedByMe: request.initiatedByMe,
        state,
        emoji,
        error,
      },
    });
  }

  private runVerifier(request: VerificationRequest, verifier: Verifier): void {
    const id = this.verificationRequestIds.get(request);
    if (!id || this.disposed || this.verifierBindings.has(id)) return;

    const onShowSas = (callbacks: ShowSasCallbacks) => {
      this.currentSasCallbacks = callbacks;
      this.publishVerification(
        request,
        id,
        "sas",
        callbacks.sas.emoji?.map(([emoji]) => emoji) ?? [],
        null,
      );
    };
    const onCancel = () => {
      this.currentSasCallbacks = null;
      this.publishVerification(
        request,
        id,
        "cancelled",
        [],
        "The other device cancelled verification.",
      );
    };
    verifier.on(VerifierEvent.ShowSas, onShowSas);
    verifier.on(VerifierEvent.Cancel, onCancel);
    this.verifierBindings.set(id, { verifier, onShowSas, onCancel });
    this.publishVerification(request, id, "started", [], null);

    void verifier
      .verify()
      .then(() => {
        if (this.disposed) return;
        this.currentSasCallbacks = null;
        this.publishVerification(request, id, "done", [], null);
        void this.refreshCryptoStatus();
      })
      .catch(() => {
        if (this.disposed) return;
        this.currentSasCallbacks = null;
        const state =
          request.phase === VerificationPhase.Cancelled
            ? "cancelled"
            : "failed";
        this.publishVerification(
          request,
          id,
          state,
          [],
          state === "failed"
            ? "The verification exchange did not complete."
            : "The other device cancelled verification.",
        );
      });
  }

  private getVerificationRequest(requestId: string): VerificationRequest {
    const request = this.verificationRequests.get(requestId)?.request;
    if (!request) throw new Error("The verification request is no longer active.");
    return request;
  }

  private watchForDecryption(event: MatrixEvent): void {
    if (!event.isEncrypted() || this.decryptedEventListeners.has(event)) return;
    const onDecrypted = () => this.scheduleRoomRefresh();
    this.decryptedEventListeners.set(event, onDecrypted);
    event.on(MatrixEventEvent.Decrypted, onDecrypted);
  }

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
          if (
            this.retainCount === 0 &&
            this.releaseGeneration === generation
          ) {
            this.dispose();
          }
        });
      }
    };
  }

  matches(session: MatrixSession, expectedUserId: string): boolean {
    return (
      !this.disposed &&
      this.expectedUserId === expectedUserId &&
      this.session.access_token === session.access_token &&
      this.session.user_id === session.user_id &&
      this.session.device_id === session.device_id
    );
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
      for (const [event, listener] of this.decryptedEventListeners) {
        event.removeListener(MatrixEventEvent.Decrypted, listener);
      }
      this.decryptedEventListeners.clear();
      for (const { request, onChange } of this.verificationRequests.values()) {
        request.removeListener(VerificationRequestEvent.Change, onChange);
      }
      this.verificationRequests.clear();
      for (const { verifier, onShowSas, onCancel } of this.verifierBindings.values()) {
        verifier.removeListener(VerifierEvent.ShowSas, onShowSas);
        verifier.removeListener(VerifierEvent.Cancel, onCancel);
      }
      this.verifierBindings.clear();
      this.currentSasCallbacks = null;
      this.secretStorageKeys.clear();
      this.crypto = null;
      if (this.initializationFinished) this.releaseCryptoStoreLock();
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
    client.on(CryptoEvent.VerificationRequestReceived, this.onVerificationRequest);
    client.on(CryptoEvent.DevicesUpdated, this.onCryptoDevicesUpdated);
    client.on(CryptoEvent.UserTrustStatusChanged, this.onUserTrustChanged);
  }

  private detachListeners(): void {
    const client = this.clientInstance;
    const sdk = this.sdk;
    if (!client || !sdk) return;
    client.removeListener(sdk.ClientEvent.Sync, this.onSync);
    client.removeListener(
      sdk.ClientEvent.SyncUnexpectedError,
      this.onUnexpectedSyncError,
    );
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
    client.removeListener(
      CryptoEvent.VerificationRequestReceived,
      this.onVerificationRequest,
    );
    client.removeListener(CryptoEvent.DevicesUpdated, this.onCryptoDevicesUpdated);
    client.removeListener(CryptoEvent.UserTrustStatusChanged, this.onUserTrustChanged);
  }

  private releaseCryptoStoreLock(): void {
    const release = this.cryptoStoreLockRelease;
    this.cryptoStoreLockRelease = null;
    release?.();
  }

  private async initialize(): Promise<void> {
    let phase: "identity" | "crypto" | "sync" = "identity";
    let client: MatrixClient | null = null;
    try {
      this.sdk = await import("matrix-js-sdk");
      if (this.disposed) return;
      this.cryptoStoreIdentity = await matrixCryptoStoreIdentity(
        this.session,
        getMatrixHomeserverUrl(),
      );
      this.cryptoStoreLockRelease = await this.lockProvider(
        this.cryptoStoreIdentity.lockName,
      );
      if (this.disposed) {
        this.releaseCryptoStoreLock();
        return;
      }
      client = await createAuthenticatedMatrixClient(
        this.session,
        this.expectedUserId,
        this.factory,
        this.secretStorageKeys.callbacks,
      );
      this.clientInstance = client;
      this.secretStorageKeys.bindClient(client);
      if (this.disposed) {
        client.stopClient();
        this.clientInstance = null;
        return;
      }
      this.attachListeners();
      await verifyMatrixClientIdentity(client, this.session, this.expectedUserId);
      if (this.disposed || this.authFailure) return;
      phase = "crypto";
      await client.initRustCrypto({
        useIndexedDB: true,
        cryptoDatabasePrefix: this.cryptoStoreIdentity.databasePrefix,
      });
      if (this.disposed) {
        client.stopClient();
        return;
      }
      const crypto = client.getCrypto();
      if (!crypto) {
        throw new Error("Rust crypto did not become available.");
      }
      this.crypto = crypto;
      crypto.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode());
      const ownDeviceKeys = await crypto.getOwnDeviceKeys();
      if (this.disposed) {
        client.stopClient();
        return;
      }
      this.publish({
        cryptoStatus: "ready",
        cryptoError: null,
        cryptoVersion: crypto.getVersion(),
        deviceId: this.session.device_id,
        ownFingerprint: ownDeviceKeys.ed25519,
      });
      void this.refreshCryptoStatus();
      phase = "sync";
      await client.startClient({
        initialSyncLimit: 30,
        pollTimeout: 30_000,
      });
    } catch (error) {
      if (this.disposed) return;
      if (isMatrixAuthenticationError(error)) {
        this.failAuthentication();
        return;
      }
      const sessionInvalid = error instanceof MatrixSessionError;
      const storeFailure = error instanceof MatrixCryptoStoreError;
      const cryptoFailed = phase === "crypto" || storeFailure;
      const initializationFailed = phase !== "sync";
      if (initializationFailed) {
        client?.stopClient();
        this.detachListeners();
        this.secretStorageKeys.clear();
        this.crypto = null;
      }
      this.publish({
        status: "error",
        error:
          sessionInvalid
            ? error.message
            : storeFailure
              ? error.message
            : cryptoFailed
              ? "Matrix Rust crypto could not be initialized. Encrypted messaging is unavailable and plaintext fallback is disabled."
              : phase === "identity"
                ? "The authenticated Matrix client could not be initialized."
                : "The Matrix sync client could not be started. Check the homeserver connection and sign in again if needed.",
        authenticationError: false,
        cryptoStatus: initializationFailed ? "error" : this.snapshot.cryptoStatus,
        cryptoError: storeFailure
          ? error.message
          : cryptoFailed
          ? "Check IndexedDB availability, browser cross-tab locking, and the Matrix session."
          : sessionInvalid
            ? null
            : this.snapshot.cryptoError,
      });
    } finally {
      this.initializationFinished = true;
      if (this.disposed || !this.crypto) this.releaseCryptoStoreLock();
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
      const oldest = this.seenEventIds.values().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.seenEventIds.delete(oldest);
    }
    this.publish({ recentEvents });
  }

  private scheduleRoomRefresh(): void {
    if (
      this.disposed ||
      !this.snapshot.initialSyncComplete ||
      this.refreshQueued
    ) {
      return;
    }

    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (!this.disposed && this.snapshot.initialSyncComplete) {
        this.publish({ rooms: this.readRooms() });
      }
    });
  }

  private readRooms(): Conversation[] {
    const client = this.clientInstance;
    if (!client) return [];
    const userId = client.getUserId();
    return userId
      ? conversationsFromMatrixClient(client.getRooms(), userId)
      : [];
  }

  private publish(
    update: Partial<MatrixConnectionSnapshot>,
  ): void {
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

  constructor(
    private readonly lockProvider: MatrixCryptoLockProvider =
      acquireMatrixCryptoStoreLock,
  ) {}

  acquire(
    session: MatrixSession,
    expectedUserId: string,
    factory?: MatrixClientFactory,
    newAccount = false,
  ): MatrixClientLease {
    if (this.active && !this.active.matches(session, expectedUserId)) {
      this.active.dispose();
      this.active = null;
    }

    if (!this.active) {
      this.active = new MatrixClientSession(
        session,
        expectedUserId,
        factory,
        this.lockProvider,
        newAccount,
      );
    }

    return {
      manager: this.active,
      release: this.active.retain(),
    };
  }

  stop(session?: MatrixSession | null): void {
    if (!this.active || (session && !this.active.matchesSession(session))) {
      return;
    }
    this.active.dispose();
    this.active = null;
  }
}

export const matrixClientRegistry = new MatrixClientRegistry();

export function stopManagedMatrixSession(
  session?: MatrixSession | null,
): void {
  matrixClientRegistry.stop(session);
}
