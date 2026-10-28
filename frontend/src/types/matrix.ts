export type MatrixCryptoStatus =
  | "disabled"
  | "initializing"
  | "ready"
  | "error";

export type MatrixCryptoOnboardingStatus =
  | "checking"
  | "save_recovery_key"
  | "restore_encryption"
  | "incomplete"
  | "ready";

export type MatrixKeyBackupStatus =
  | "checking"
  | "not_configured"
  | "trusted"
  | "untrusted"
  | "error";

export type MatrixVerificationState =
  | "requested"
  | "ready"
  | "started"
  | "sas"
  | "done"
  | "cancelled"
  | "failed";

export interface MatrixVerificationSnapshot {
  id: string;
  userId: string;
  deviceId: string | null;
  initiatedByMe: boolean;
  state: MatrixVerificationState;
  emoji: string[];
  error: string | null;
}
