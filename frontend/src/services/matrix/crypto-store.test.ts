import { afterEach, describe, expect, it, vi } from "vitest";

import type { MatrixSession } from "../../types";
import {
  acquireMatrixCryptoStoreLock,
  matrixCryptoStoreIdentity,
} from "./crypto-store";

const session: MatrixSession = {
  access_token: "ephemeral-test-token",
  user_id: "@u_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:localhost",
  device_id: "DEVICE_A",
  home_server: "localhost",
  expires_in_ms: null,
};

function stubCryptoSubtle(): void {
  const digest = vi.fn(
    async (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const input =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const output = new Uint8Array(32);
      input.forEach((value, index) => {
        output[index % output.length] = (output[index % output.length] + value) % 256;
      });
      return output.buffer;
    },
  );
  vi.stubGlobal("crypto", { subtle: { digest } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Matrix Rust crypto store isolation", () => {
  it("keeps a stable store identity for one homeserver, user, and device", async () => {
    stubCryptoSubtle();

    const first = await matrixCryptoStoreIdentity(session, "http://localhost:8008/");
    const second = await matrixCryptoStoreIdentity(session, "http://localhost:8008");

    expect(first).toEqual(second);
    expect(first.databasePrefix).toMatch(/^lumachat-rust-crypto-v1-[0-9a-f]{64}$/);
  });

  it("isolates different users, devices, and homeservers", async () => {
    stubCryptoSubtle();

    const original = await matrixCryptoStoreIdentity(session, "http://localhost:8008");
    const otherUser = await matrixCryptoStoreIdentity(
      { ...session, user_id: "@u_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:localhost" },
      "http://localhost:8008",
    );
    const otherDevice = await matrixCryptoStoreIdentity(
      { ...session, device_id: "DEVICE_B" },
      "http://localhost:8008",
    );
    const otherHomeserver = await matrixCryptoStoreIdentity(
      session,
      "https://matrix.example.org",
    );

    expect(new Set([
      original.databasePrefix,
      otherUser.databasePrefix,
      otherDevice.databasePrefix,
      otherHomeserver.databasePrefix,
    ]).size).toBe(4);
  });

  it("fails closed when Web Locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});

    await expect(acquireMatrixCryptoStoreLock("test-store")).rejects.toThrow(
      /does not support safe multi-tab Matrix crypto storage/,
    );
  });

  it("holds the Web Lock until its release callback is called", async () => {
    let lockRequestFinished = false;
    const locks = {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<void>,
      ) => {
        await callback({} as Lock);
        lockRequestFinished = true;
      },
    };
    vi.stubGlobal("navigator", { locks });

    const release = await acquireMatrixCryptoStoreLock("test-store");
    expect(lockRequestFinished).toBe(false);

    release();
    await vi.waitFor(() => expect(lockRequestFinished).toBe(true));
  });

  it("rejects when another tab already holds the Web Lock", async () => {
    const locks = {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<void>,
      ) => {
        await callback(null);
      },
    };
    vi.stubGlobal("navigator", { locks });

    await expect(acquireMatrixCryptoStoreLock("test-store")).rejects.toThrow(
      /already active in another tab/,
    );
  });
});
