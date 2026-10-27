import {
  Check,
  Copy,
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
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

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

  async function createRecoveryKey() {
    if (!manager) return;
    setBusy(true);
    setError("");
    try {
      await manager.prepareRecoveryKey();
      setAcknowledged(false);
    } catch {
      setError(
        "A recovery key could not be prepared. Check the account recovery status and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function enableRecovery() {
    if (!manager || !acknowledged) return;
    setBusy(true);
    setError("");
    try {
      await manager.confirmRecoveryKeySaved();
      setAcknowledged(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Secure recovery could not be enabled.",
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

  async function copyRecoveryKey() {
    if (!snapshot.pendingRecoveryKey) return;
    try {
      await navigator.clipboard.writeText(snapshot.pendingRecoveryKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Clipboard access is unavailable. Select and copy the key.");
    }
  }

  function close() {
    if (snapshot.pendingRecoveryKey) manager?.cancelRecoveryKeySetup();
    setRecoveryInput("");
    onClose();
  }

  const verification = snapshot.verification;
  const canCreateBackup =
    snapshot.keyBackupStatus === "not_configured" &&
    snapshot.secretStorageReady !== true;

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
            <h2 id="matrix-security-title">Encryption and devices</h2>
            <p>Room encryption, identity verification, and key recovery.</p>
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
                {snapshot.cryptoStatus === "ready"
                  ? "Rust crypto is ready"
                  : snapshot.cryptoStatus === "initializing"
                    ? "Initializing Rust crypto…"
                    : "End-to-end encryption unavailable"}
              </strong>
              <span>
                {snapshot.cryptoStatus === "ready"
                  ? `Device ${snapshot.deviceId ?? "unknown"} · ${snapshot.cryptoVersion ?? "Matrix Rust crypto"}`
                  : snapshot.cryptoError ?? "Encrypted messaging is blocked until crypto is ready."}
              </span>
            </div>
          </section>

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
            {canCreateBackup && !snapshot.pendingRecoveryKey && (
              <div>
                <p>
                  Create a recovery key and save it somewhere private. Losing the key can make
                  encrypted history permanently unrecoverable.
                </p>
                <button type="button" className="security-button" disabled={busy || snapshot.cryptoStatus !== "ready"} onClick={() => void createRecoveryKey()}>
                  Generate recovery key
                </button>
              </div>
            )}
            {snapshot.pendingRecoveryKey && (
              <div className="recovery-key-panel">
                <p>
                  Save this key now. LumaChat will not store or send it. Closing this dialog discards
                  the unsaved key.
                </p>
                <code>{snapshot.pendingRecoveryKey}</code>
                <button type="button" className="security-button secondary" onClick={() => void copyRecoveryKey()}>
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? "Copied" : "Copy recovery key"}
                </button>
                <label className="security-checkbox">
                  <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                  I saved this recovery key in a secure place.
                </label>
                <button type="button" className="security-button" disabled={busy || !acknowledged} onClick={() => void enableRecovery()}>
                  Enable secure recovery
                </button>
              </div>
            )}
            {(snapshot.keyBackupStatus === "trusted" ||
              snapshot.keyBackupStatus === "untrusted" ||
              snapshot.secretStorageReady === false) && (
              <div className="recovery-restore">
                <label htmlFor="matrix-recovery-key">Restore on this device</label>
                <input
                  id="matrix-recovery-key"
                  type="password"
                  autoComplete="off"
                  value={recoveryInput}
                  onChange={(event) => setRecoveryInput(event.target.value)}
                  placeholder="Enter your Matrix recovery key"
                />
                <button type="button" className="security-button secondary" disabled={busy || !recoveryInput.trim()} onClick={() => void restoreHistory()}>
                  Restore encrypted history
                </button>
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
