import type { MatrixSession } from "../../types";

export class MatrixCryptoStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixCryptoStoreError";
  }
}

export interface MatrixCryptoStoreIdentity {
  databasePrefix: string;
  lockName: string;
}

export async function matrixCryptoStoreIdentity(
  session: MatrixSession,
  homeserverUrl: string,
): Promise<MatrixCryptoStoreIdentity> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new MatrixCryptoStoreError(
      "This browser cannot safely identify an isolated Matrix crypto store.",
    );
  }

  const identity = [
    homeserverUrl.replace(/\/+$/, ""),
    session.user_id,
    session.device_id,
  ].join("\u0000");
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const suffix = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const prefix = `lumachat-rust-crypto-v1-${suffix}`;

  return {
    databasePrefix: prefix,
    lockName: `${prefix}-active-client`,
  };
}

/**
 * Holds an exclusive Web Lock for the lifetime of the Matrix crypto client.
 * The Rust crypto IndexedDB store is not safe to open from concurrent clients.
 */
export async function acquireMatrixCryptoStoreLock(
  lockName: string,
): Promise<() => void> {
  const locks =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks || typeof locks.request !== "function") {
    throw new MatrixCryptoStoreError(
      "This browser does not support safe multi-tab Matrix crypto storage.",
    );
  }

  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  let resolveAcquired!: (release: () => void) => void;
  let rejectAcquired!: (error: Error) => void;
  let acquired = false;
  const result = new Promise<() => void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });

  const lockRequest = locks
    .request(
      lockName,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          throw new MatrixCryptoStoreError(
            "This Matrix device is already active in another tab. Close that tab before continuing.",
          );
        }

        acquired = true;
        resolveAcquired(() => releaseHold());
        await hold;
      },
    )
    .catch((cause: unknown) => {
      if (acquired) return;
      rejectAcquired(
        cause instanceof MatrixCryptoStoreError
          ? cause
          : new MatrixCryptoStoreError(
              "A safe lock for this Matrix crypto store could not be acquired.",
            ),
      );
    });

  // Keep the request rejection observed for the full time the lock is held.
  void lockRequest.catch(() => undefined);
  return result;
}
