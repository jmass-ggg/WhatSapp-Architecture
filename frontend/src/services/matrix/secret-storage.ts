import type { MatrixClient } from "matrix-js-sdk";
import type { CryptoCallbacks } from "matrix-js-sdk/lib/crypto-api/index.js";

interface ActiveRecoveryKey {
  keyId: string;
  value: Uint8Array;
}

/**
 * Keeps secret-storage keys in memory only. Rust crypto's IndexedDB store and
 * Matrix account data remain the SDK's responsibility.
 */
export class SecretStorageKeyController {
  private client: MatrixClient | null = null;
  private readonly cachedKeys = new Map<string, Uint8Array>();
  private activeRecoveryKey: ActiveRecoveryKey | null = null;

  readonly callbacks: CryptoCallbacks = {
    getSecretStorageKey: async ({ keys }) => {
      const client = this.client;
      if (!client) return null;

      const defaultKeyId = await client.secretStorage.getDefaultKeyId();
      if (!defaultKeyId || !keys[defaultKeyId]) return null;

      const cached = this.cachedKeys.get(defaultKeyId);
      if (cached) return [defaultKeyId, new Uint8Array(cached)];

      if (this.activeRecoveryKey?.keyId === defaultKeyId) {
        return [
          defaultKeyId,
          new Uint8Array(this.activeRecoveryKey.value),
        ];
      }
      return null;
    },
    cacheSecretStorageKey: (keyId, _keyInfo, key) => {
      this.replaceCachedKey(keyId, key);
    },
  };

  bindClient(client: MatrixClient): void {
    this.client = client;
  }

  async withRecoveryKey<T>(
    keyId: string,
    key: Uint8Array,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.activeRecoveryKey;
    const temporary = new Uint8Array(key);
    this.activeRecoveryKey = { keyId, value: temporary };
    try {
      const result = await operation();
      this.replaceCachedKey(keyId, temporary);
      return result;
    } finally {
      temporary.fill(0);
      this.activeRecoveryKey = previous;
    }
  }

  hasCachedKeyMatching(keyId: string, expectedKey: Uint8Array): boolean {
    const cached = this.cachedKeys.get(keyId);
    if (!cached || cached.length !== expectedKey.length) return false;

    let difference = 0;
    for (let index = 0; index < cached.length; index += 1) {
      difference |= cached[index] ^ expectedKey[index];
    }
    return difference === 0;
  }

  clear(): void {
    for (const key of this.cachedKeys.values()) key.fill(0);
    this.cachedKeys.clear();
    this.activeRecoveryKey?.value.fill(0);
    this.activeRecoveryKey = null;
    this.client = null;
  }

  private replaceCachedKey(keyId: string, key: Uint8Array): void {
    this.cachedKeys.get(keyId)?.fill(0);
    this.cachedKeys.set(keyId, new Uint8Array(key));
  }
}
