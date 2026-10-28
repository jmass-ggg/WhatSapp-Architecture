import {
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { MatrixConnectionSnapshot, MatrixClientSession, MatrixDeviceSummary } from "../services/matrix/session";

function safeVerificationError(cause: unknown): string {
  if (cause instanceof Error && cause.message === "Not a known device") {
    return "That device is no longer available. Refresh the device list and try again.";
  }
  if (cause instanceof Error && /^unknown userId\b/.test(cause.message)) {
    return "No Matrix identity is available for that account yet. Ask the other user to sign in, then retry.";
  }
  if (
    cause instanceof Error &&
    cause.message === "A one-to-one conversation is required."
  ) {
    return "Open a one-to-one conversation with this contact before requesting verification.";
  }
  return "A verification request could not be sent. Refresh device information or try again later.";
}

interface MatrixSecurityDialogProps {
  manager: MatrixClientSession | null;
  snapshot: MatrixConnectionSnapshot;
  peerUserId?: string;
  roomId?: string;
  onClose: () => void;
}

export function MatrixSecurityDialog({
  manager,
  snapshot,
  peerUserId,
  roomId,
  onClose,
}: MatrixSecurityDialogProps) {
  const [peerDevices, setPeerDevices] = useState<MatrixDeviceSummary[]>([]);
  const [ownDevices, setOwnDevices] = useState<MatrixDeviceSummary[]>([]);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showLostRecoveryHelp, setShowLostRecoveryHelp] = useState(false);

  useEffect(() => {
    if (!manager || snapshot.cryptoStatus !== "ready") {
      setPeerDevices([]);
      setOwnDevices([]);
      return;
    }

    let active = true;
    void Promise.all([
      peerUserId ? manager.getDevices(peerUserId) : Promise.resolve([]),
      manager.getDevices(manager.expectedUserId),
    ])
      .then(([contacts, own]) => {
        if (!active) return;
        setPeerDevices(contacts);
        setOwnDevices(own);
      })
      .catch(() => {
        if (active) setError("Device information could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [manager, peerUserId, snapshot.cryptoStatus, snapshot.verification]);

  async function retrySetup() {
    if (!manager) return;
    setBusy(true);
    setError("");
    try {
      await manager.retryCryptoOnboarding();
    } catch {
      setError(
        "Secure messaging could not be checked. Check your connection and retry.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function restoreHistory() {
    if (!manager || !recoveryInput.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await manager.restoreFromRecoveryKey(recoveryInput);
      setRecoveryInput("");
      setError(
        `Recovery finished: ${result.imported} of ${result.total} room keys imported.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Encrypted history could not be restored.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyDevice(device: MatrixDeviceSummary) {
    if (!manager) return;
    setBusy(true);
    setError("");
    try {
      if (device.userId === manager.expectedUserId) {
        await manager.requestDeviceVerification(device.userId, device.deviceId);
      } else if (roomId && device.userId === peerUserId) {
        await manager.requestVerificationDM(device.userId, roomId);
      } else {
        throw new Error("A one-to-one conversation is required.");
      }
    } catch (cause) {
      setError(safeVerificationError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function acceptVerification(requestId: string) {
    if (!manager) return;
    setBusy(true);
    setError("");
    try {
      await manager.acceptVerificationRequest(requestId);
    } catch {
      setError("The verification request could not be accepted.");
    } finally {
      setBusy(false);
    }
  }

  async function beginVerification(requestId: string) {
    if (!manager) return;
    setBusy(true);
    setError("");
    try {
      await manager.beginSasVerification(requestId);
    } catch {
      setError("Emoji verification could not be started.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmVerification(requestId: string) {
    if (!manager) return;
    setBusy(true);
    setError("");
    try {
      await manager.confirmSasMatch(requestId);
    } catch {
      setError("The verification confirmation could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelVerification(requestId: string) {
    if (!manager) return;
    setBusy(true);
    try {
      await manager.cancelVerification(requestId);
    } catch {
      setError("The verification request could not be cancelled.");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setRecoveryInput("");
    onClose();
  }

  const verification = snapshot.verification;
  const onboardingTitle =
    snapshot.cryptoOnboardingStatus === "restore_encryption"
      ? "Restore encryption"
      : snapshot.cryptoOnboardingStatus === "incomplete"
        ? "Encryption setup needs attention"
        : "Encryption and devices";

  return (
    <div className="modal-backdrop new-chat-backdrop security-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section
        className="security-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-security-title"
      >
        <header className="new-chat-dialog-header">
          <div>
            <span className="eyebrow">MATRIX SECURITY</span>
            <h2 id="matrix-security-title">{onboardingTitle}</h2>
            <p>
              {snapshot.cryptoOnboardingStatus === "restore_encryption"
                ? "Use your existing recovery key to unlock encryption on this device."
                : snapshot.cryptoOnboardingStatus === "incomplete"
                  ? "Your existing encryption data was left unchanged."
                  : "Room encryption, identity verification, and encrypted history backup."}
            </p>
          </div>
          <button type="button" className="icon-button" aria-label="Close security settings" onClick={close}>
            <X size={19} />
          </button>
        </header>

        <div className="security-dialog-content">
          <section className="security-status-card">
            <LockKeyhole size={18} aria-hidden="true" />
            <div>
              <strong>
                {snapshot.cryptoStatus === "initializing" ||
                snapshot.cryptoOnboardingStatus === "checking"
                  ? "Setting up secure messaging…"
                  : snapshot.cryptoOnboardingStatus === "ready"
                    ? "Encrypted chat ready"
                    : snapshot.cryptoOnboardingStatus === "restore_encryption"
                      ? "Restore encryption to continue"
                      : snapshot.cryptoOnboardingStatus === "incomplete"
                        ? "Encryption needs attention"
                        : "Secure setup needs a retry"}
              </strong>
              <span>
                {snapshot.cryptoError ??
                  (snapshot.cryptoStatus === "ready"
                    ? `Device ${snapshot.deviceId ?? "unknown"} · ${snapshot.cryptoVersion ?? "Matrix Rust crypto"}`
                    : "Encrypted messaging will be available when setup finishes.")}
              </span>
            </div>
          </section>
          {snapshot.cryptoOnboardingStatus === "incomplete" && (
            <section className="security-section" role="status">
              <p>
                Encrypted messaging is blocked because this device cannot verify
                the account&apos;s cross-signing state. No replacement identity or
                recovery backup was created. Restore existing encryption material
                or verify another device.
              </p>
              <button
                type="button"
                className="security-button secondary"
                disabled={busy || snapshot.cryptoStatus !== "ready"}
                onClick={() => void retrySetup()}
              >
                Retry secure setup
              </button>
            </section>
          )}

          <section className="security-section">
            <div className="security-section-heading">
              <ShieldCheck size={16} aria-hidden="true" />
              <strong>Identity and cross-signing</strong>
            </div>
            <p>
              {snapshot.crossSigningReady === true
                ? "Cross-signing is ready on this device."
                : snapshot.crossSigningReady === false
                  ? "This device identity has not been cross-signed."
                  : "Cross-signing status is being checked."}
            </p>
            {snapshot.ownFingerprint && (
              <small className="security-fingerprint">
                Device fingerprint: {snapshot.ownFingerprint}
              </small>
            )}
            <p className="security-note">
              Encryption protects message content. It does not hide room membership or event timing.
              An encrypted room does not mean a contact's identity has been verified.
            </p>
          </section>

          <section className="security-section">
            <div className="security-section-heading">
              <KeyRound size={16} aria-hidden="true" />
              <strong>Encrypted history backup</strong>
              <span className={`security-pill is-${snapshot.keyBackupStatus}`}>
                {snapshot.keyBackupStatus.replaceAll("_", " ")}
              </span>
            </div>
            {snapshot.keyBackupVersion && (
              <p>Backup version: {snapshot.keyBackupVersion}</p>
            )}
            {snapshot.keyBackupStatus === "not_configured" && (
              <p>
                No encrypted history backup is configured. Losing this device may
                make old messages unrecoverable.
              </p>
            )}
            {snapshot.keyBackupStatus === "trusted" && (
              <p>A trusted encrypted history backup is configured.</p>
            )}
            {snapshot.keyBackupStatus === "untrusted" && (
              <p>
                A backup exists, but this device could not verify it. Restore with
                existing recovery material before relying on it.
              </p>
            )}
            {snapshot.keyBackupStatus === "error" && (
              <p>Encrypted history backup status could not be verified.</p>
            )}
            {(snapshot.keyBackupStatus === "trusted" ||
              snapshot.keyBackupStatus === "untrusted" ||
              snapshot.cryptoOnboardingStatus === "restore_encryption") && (
              <div className="recovery-restore">
                <label htmlFor="matrix-recovery-key">Restore encryption on this device</label>
                <input
                  id="matrix-recovery-key"
                  type="password"
                  autoComplete="off"
                  value={recoveryInput}
                  onChange={(event) => setRecoveryInput(event.target.value)}
                  placeholder="Enter your recovery key"
                />
                <button type="button" className="security-button secondary" disabled={busy || !recoveryInput.trim()} onClick={() => void restoreHistory()}>
                  Restore encryption
                </button>
              </div>
            )}
            {(snapshot.cryptoOnboardingStatus === "restore_encryption" ||
              snapshot.cryptoOnboardingStatus === "incomplete") && (
              <div className="recovery-restore">
                <button
                  type="button"
                  className="security-button secondary"
                  onClick={() => setShowLostRecoveryHelp((shown) => !shown)}
                  aria-expanded={showLostRecoveryHelp}
                >
                  Lost recovery key?
                </button>
                {showLostRecoveryHelp && (
                  <p role="status">
                    Keep any older signed-in device available: it may still have
                    the room keys needed to read your history. Device verification
                    confirms identity, but does not transfer those keys to this
                    device. Find the recovery key saved during initial setup and
                    enter it above. If neither the key nor a recoverable device
                    exists, older encrypted messages may be permanently unreadable.
                    Recruitable Chat will not reset your encryption identity or
                    overwrite your backup automatically.
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="security-section">
            <div className="security-section-heading">
              <ShieldCheck size={16} aria-hidden="true" />
              <strong>Device verification</strong>
            </div>
            <DeviceList
              heading="Your devices"
              devices={ownDevices.filter((device) => device.deviceId !== snapshot.deviceId)}
              empty="No other encryption-capable devices are known."
              busy={busy}
              onVerify={verifyDevice}
            />
            {peerUserId && (
              <DeviceList
                heading="Contact devices"
                devices={peerDevices}
                empty="No encryption-capable contact devices were found."
                busy={busy}
                onVerify={verifyDevice}
              />
            )}
            {verification && (
              <div className="verification-card">
                <strong>
                  {verification.state === "done"
                    ? "Verified"
                    : verification.state === "failed" || verification.state === "cancelled"
                      ? "Verification ended"
                      : `Verification with ${verification.userId}`}
                </strong>
                {verification.state === "sas" && (
                  <>
                    <span>Compare these emojis on both devices. Confirm only if they match.</span>
                    <div className="verification-emojis" aria-label="Emoji verification code">
                      {verification.emoji.map((emoji, index) => <span key={`${emoji}-${index}`}>{emoji}</span>)}
                    </div>
                    <button type="button" className="security-button" disabled={busy} onClick={() => void confirmVerification(verification.id)}>
                      The emojis match
                    </button>
                  </>
                )}
                {verification.state === "requested" && !verification.initiatedByMe && (
                  <button type="button" className="security-button" disabled={busy} onClick={() => void acceptVerification(verification.id)}>
                    Accept verification
                  </button>
                )}
                {verification.state === "ready" && verification.initiatedByMe && (
                  <button type="button" className="security-button" disabled={busy} onClick={() => void beginVerification(verification.id)}>
                    Start emoji verification
                  </button>
                )}
                {verification.state !== "done" &&
                  verification.state !== "cancelled" &&
                  verification.state !== "failed" && (
                    <button type="button" className="security-text-button" disabled={busy} onClick={() => void cancelVerification(verification.id)}>
                      Cancel verification
                    </button>
                  )}
                {verification.error && <small role="status">{verification.error}</small>}
              </div>
            )}
          </section>

          {error && <p className="dialog-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}

function DeviceList({
  heading,
  devices,
  empty,
  busy,
  onVerify,
}: {
  heading: string;
  devices: MatrixDeviceSummary[];
  empty: string;
  busy: boolean;
  onVerify: (device: MatrixDeviceSummary) => Promise<void>;
}) {
  return (
    <div className="security-device-list">
      <strong>{heading}</strong>
      {devices.length === 0 ? (
        <small>{empty}</small>
      ) : devices.map((device) => (
        <div className="security-device" key={`${device.userId}:${device.deviceId}`}>
          <span>
            <b>{device.displayName || device.deviceId}</b>
            <small>{device.verified ? "Verified" : "Unverified"} · {device.deviceId}</small>
          </span>
          {!device.verified && (
            <button type="button" disabled={busy} onClick={() => void onVerify(device)}>
              Verify
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
