import type { MatrixConnectionStatus as ConnectionStatus } from "../services/matrix/session";

interface MatrixConnectionStatusProps {
  status: ConnectionStatus;
  initialSyncComplete: boolean;
  authenticationError?: boolean;
  error?: string | null;
  compact?: boolean;
}

function labelFor(
  status: ConnectionStatus,
  initialSyncComplete: boolean,
  authenticationError: boolean,
): string {
  if (status === "connected" && initialSyncComplete) return "Connected to Matrix";
  if (status === "connecting") return "Connecting to Matrix…";
  if (status === "reconnecting") return "Reconnecting to Matrix…";
  if (status === "error" && authenticationError) return "Matrix session expired";
  if (status === "error") return "Matrix connection unavailable";
  if (status === "disconnected") return "Disconnected from Matrix";
  return "Matrix is not connected";
}

export function MatrixConnectionStatus({
  status,
  initialSyncComplete,
  authenticationError = false,
  error,
  compact = false,
}: MatrixConnectionStatusProps) {
  const label = labelFor(status, initialSyncComplete, authenticationError);
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
