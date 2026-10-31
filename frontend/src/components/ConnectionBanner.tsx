import type { MatrixConnectionStatus } from "../services/matrix/session";

interface ConnectionBannerProps {
  status: MatrixConnectionStatus;
  initialSyncComplete: boolean;
  authenticationError?: boolean;
  error?: string | null;
}

export function connectionLabel(
  status: MatrixConnectionStatus,
  initialSyncComplete: boolean,
  authenticationError: boolean,
): string {
  if (status === "error" && authenticationError) return "Session expired. Sign in again.";
  if (status === "connected" && initialSyncComplete) return "Connected";
  if (status === "connecting") return "Connecting…";
  if (status === "reconnecting") return "Reconnecting…";
  if (status === "error") return "Connection unavailable";
  if (status === "disconnected") return "Disconnected";
  return "Not connected";
}

/** Shown only while the realtime connection is not healthy. */
export function ConnectionBanner({
  status,
  initialSyncComplete,
  authenticationError = false,
  error,
}: ConnectionBannerProps) {
  if (status === "connected" && initialSyncComplete) return null;
  return (
    <div className={`connection-banner is-${status}`} role="status" aria-live="polite" title={error ?? undefined}>
      <span className="connection-dot" aria-hidden="true" />
      {connectionLabel(status, initialSyncComplete, authenticationError)}
    </div>
  );
}
