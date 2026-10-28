import type { MatrixConnectionStatus as ConnectionStatus } from "../services/matrix/session";
import type {
  MatrixCryptoOnboardingStatus,
  MatrixCryptoStatus,
} from "../types/matrix";

interface MatrixConnectionStatusProps {
  status: ConnectionStatus;
  initialSyncComplete: boolean;
  cryptoStatus?: MatrixCryptoStatus;
  cryptoOnboardingStatus?: MatrixCryptoOnboardingStatus;
  authenticationError?: boolean;
  error?: string | null;
  compact?: boolean;
}

function labelFor(
  status: ConnectionStatus,
  initialSyncComplete: boolean,
  authenticationError: boolean,
  cryptoStatus: MatrixCryptoStatus | undefined,
  cryptoOnboardingStatus: MatrixCryptoOnboardingStatus | undefined,
): string {
  if (status === "error" && authenticationError) return "Matrix session expired";
  if (cryptoStatus === "error") return "Secure messaging unavailable";
  if (cryptoStatus === "initializing" || cryptoOnboardingStatus === "checking") {
    return "Setting up secure messaging…";
  }
  if (cryptoOnboardingStatus === "restore_encryption") return "Restore encryption";
  if (cryptoOnboardingStatus === "incomplete") return "Encryption setup needs attention";
  if (
    status === "connected" &&
    initialSyncComplete &&
    cryptoOnboardingStatus === "ready"
  ) {
    return "Encrypted chat ready";
  }
  if (status === "connected" && initialSyncComplete) return "Connected to Matrix";
  if (status === "connecting") return "Connecting to Matrix…";
  if (status === "reconnecting") return "Reconnecting to Matrix…";
  if (status === "error") return "Matrix connection unavailable";
  if (status === "disconnected") return "Disconnected from Matrix";
  return "Matrix is not connected";
}

export function MatrixConnectionStatus({
  status,
  initialSyncComplete,
  cryptoStatus,
  cryptoOnboardingStatus,
  authenticationError = false,
  error,
  compact = false,
}: MatrixConnectionStatusProps) {
  const label = labelFor(
    status,
    initialSyncComplete,
    authenticationError,
    cryptoStatus,
    cryptoOnboardingStatus,
  );
  return (
    <span
      className={[
        "matrix-connection-status",
        `is-${status}`,
        compact ? "is-compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-live="polite"
      title={error ?? label}
    >
      <span className="matrix-connection-indicator" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
