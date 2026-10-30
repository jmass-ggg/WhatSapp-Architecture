import { MemoryStore, type MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import type { MatrixSession } from "../../types";
import {
  createAuthenticatedMatrixClient,
  getMatrixHomeserverUrl,
  isMatrixAuthenticationError,
  MatrixSessionError,
  validateMatrixSession,
  verifyMatrixClientIdentity,
  type MatrixClientFactory,
} from "./client";

const session: MatrixSession = {
  access_token: "opaque-test-token",
  user_id: "@u_0123456789abcdef0123456789abcdef:localhost",
  device_id: "TESTDEVICE01",
  home_server: "localhost",
  expires_in_ms: null,
};

describe("Matrix client configuration", () => {
  it("rejects a missing or incomplete Matrix session", () => {
    expect(() =>
      validateMatrixSession(null, session.user_id),
    ).toThrowError(MatrixSessionError);
    expect(() =>
      validateMatrixSession(
        { ...session, access_token: "" },
        session.user_id,
      ),
    ).toThrowError(/complete Matrix session/);
    expect(() =>
      validateMatrixSession(
        { ...session, user_id: "@someone:localhost" },
        session.user_id,
      ),
    ).toThrowError(/does not belong/);
  });

  it("creates one SDK client with the FastAPI-issued Matrix credentials", async () => {
    let options: Parameters<MatrixClientFactory>[0] | undefined;
    const expectedClient = {} as MatrixClient;
    const factory: MatrixClientFactory = (providedOptions) => {
      options = providedOptions;
      return expectedClient;
    };

    const client = await createAuthenticatedMatrixClient(
      session,
      session.user_id,
      factory,
    );

    expect(client).toBe(expectedClient);
    expect(options).toMatchObject({
      baseUrl: getMatrixHomeserverUrl(),
      accessToken: session.access_token,
      userId: session.user_id,
      deviceId: session.device_id,
      timelineSupport: true,
    });
    expect(options?.store).toBeInstanceOf(MemoryStore);
  });

  it("verifies both the Synapse user identity and device identity", async () => {
    const client = {
      whoami: vi.fn().mockResolvedValue({
        user_id: session.user_id,
        device_id: session.device_id,
      }),
      getUserId: () => session.user_id,
      getDeviceId: () => session.device_id,
    } as unknown as MatrixClient;

    await expect(
      verifyMatrixClientIdentity(client, session, session.user_id),
    ).resolves.toBeUndefined();

    const mismatchedClient = {
      ...client,
      whoami: vi.fn().mockResolvedValue({
        user_id: "@other:localhost",
        device_id: session.device_id,
      }),
    } as unknown as MatrixClient;
    await expect(
      verifyMatrixClientIdentity(
        mismatchedClient,
        session,
        session.user_id,
      ),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
  });

  it("classifies revoked Matrix tokens as authentication failures", () => {
    expect(isMatrixAuthenticationError({ httpStatus: 401 })).toBe(true);
    expect(isMatrixAuthenticationError({ errcode: "M_UNKNOWN_TOKEN" })).toBe(
      true,
    );
    expect(isMatrixAuthenticationError({ httpStatus: 503 })).toBe(false);
    expect(isMatrixAuthenticationError(new Error("network down"))).toBe(false);
  });
});
