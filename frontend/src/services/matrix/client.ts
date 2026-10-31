import type { IMatrixClientCreateOpts, MatrixClient } from "matrix-js-sdk";

import type { MatrixSession } from "../../types";

const DEFAULT_MATRIX_URL = "http://localhost:8008";

export const MATRIX_BASE_URL = (
  import.meta.env.VITE_MATRIX_HOMESERVER_URL ||
  import.meta.env.VITE_MATRIX_URL ||
  DEFAULT_MATRIX_URL
).replace(/\/+$/, "");

export const MATRIX_SERVER_NAME =
  import.meta.env.VITE_MATRIX_SERVER_NAME || "localhost";

export type MatrixClientFactory = (
  options: IMatrixClientCreateOpts,
) => MatrixClient;

const silentSdkLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  getChild: () => silentSdkLogger,
};

export type MatrixSessionErrorCode =
  | "invalid_session"
  | "identity_mismatch"
  | "invalid_homeserver";

export class MatrixSessionError extends Error {
  constructor(
    message: string,
    readonly code: MatrixSessionErrorCode,
  ) {
    super(message);
    this.name = "MatrixSessionError";
  }
}

export function getMatrixHomeserverUrl(): string {
  let url: URL;
  try {
    url = new URL(MATRIX_BASE_URL);
  } catch {
    throw new MatrixSessionError(
      "The Matrix homeserver URL is not a valid browser URL.",
      "invalid_homeserver",
    );
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new MatrixSessionError(
      "The Matrix homeserver URL must be an HTTP(S) URL without embedded credentials.",
      "invalid_homeserver",
    );
  }

  return url.toString().replace(/\/+$/, "");
}

export function validateMatrixSession(
  session: MatrixSession | null | undefined,
  expectedUserId: string,
): asserts session is MatrixSession {
  if (
    !session ||
    typeof session.access_token !== "string" ||
    session.access_token.trim().length === 0 ||
    typeof session.user_id !== "string" ||
    session.user_id.trim().length === 0 ||
    typeof session.device_id !== "string" ||
    session.device_id.trim().length === 0
  ) {
    throw new MatrixSessionError(
      "The FastAPI login response did not include a complete Matrix session.",
      "invalid_session",
    );
  }

  if (!expectedUserId || session.user_id !== expectedUserId) {
    throw new MatrixSessionError(
      "The Matrix session does not belong to the authenticated application user.",
      "identity_mismatch",
    );
  }
}

export function createAuthenticatedMatrixClient(
  session: MatrixSession | null | undefined,
  expectedUserId: string,
  factory?: MatrixClientFactory,
): Promise<MatrixClient> {
  validateMatrixSession(session, expectedUserId);
  const baseUrl = getMatrixHomeserverUrl();

  return import("matrix-js-sdk").then((sdk) => {
    const options: IMatrixClientCreateOpts = {
      baseUrl,
      accessToken: session.access_token,
      userId: session.user_id,
      deviceId: session.device_id,
      timelineSupport: true,
      // Keep sync responses in memory. No crypto store is created.
      store: new sdk.MemoryStore(),
      // Matrix SDK logs can include event metadata; surface sanitized state in the UI instead.
      logger: silentSdkLogger,
    };
    return factory ? factory(options) : sdk.createClient(options);
  });
}

export async function verifyMatrixClientIdentity(
  client: MatrixClient,
  session: MatrixSession,
  expectedUserId: string,
): Promise<void> {
  validateMatrixSession(session, expectedUserId);
  const whoami = await client.whoami();

  if (
    whoami.user_id !== expectedUserId ||
    client.getUserId() !== expectedUserId ||
    (whoami.device_id !== undefined &&
      whoami.device_id !== session.device_id) ||
    client.getDeviceId() !== session.device_id
  ) {
    throw new MatrixSessionError(
      "Synapse returned an identity that does not match the FastAPI session.",
      "identity_mismatch",
    );
  }
}

export function isMatrixAuthenticationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { httpStatus?: unknown; errcode?: unknown };
  return (
    candidate.httpStatus === 401 ||
    candidate.errcode === "M_UNKNOWN_TOKEN" ||
    candidate.errcode === "M_MISSING_TOKEN" ||
    candidate.errcode === "M_UNKNOWN_DEVICE"
  );
}
