import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import * as sdk from "matrix-js-sdk";
import {
  CryptoEvent,
  decodeRecoveryKey,
  OnlySignedDevicesIsolationMode,
  VerificationPhase,
  VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api/index.js";

const apiBaseUrl = process.env.LUMACHAT_TEST_API_URL?.replace(/\/+$/, "");
if (!apiBaseUrl) {
  throw new Error(
    "Set LUMACHAT_TEST_API_URL to an isolated FastAPI test server with registration enabled.",
  );
}

const matrixUrl = (
  process.env.LUMACHAT_MATRIX_HOMESERVER_URL || "http://localhost:8008"
).replace(/\/+$/, "");
const matrixServerName = process.env.LUMACHAT_MATRIX_SERVER_NAME || "localhost";
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const syntheticPassword = `Step07-${randomUUID()}!`;
const minimumLoginIntervalMs = 7_500;
const logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  getChild: () => logger,
};

const clients = [];
let lastLoginAttemptAt = 0;

function expectedMatrixUserId(appUserId) {
  return `@u_${appUserId.replaceAll("-", "").toLowerCase()}:${matrixServerName}`;
}

async function registerUser(label) {
  const username = `step07_${label}_${runId}`;
  const response = await fetch(`${apiBaseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${username}@example.com`,
      username,
      password: syntheticPassword,
      display_name: `Step 07 ${label} ${runId}`,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`Synthetic user registration failed with HTTP ${response.status}.`);
  }
  const profile = await response.json();
  return {
    id: profile.id,
    username,
    displayName: profile.profile?.display_name ?? username,
  };
}

async function loginUser(account) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const waitMs = Math.max(
      0,
      minimumLoginIntervalMs - (Date.now() - lastLoginAttemptAt),
    );
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    response = await fetch(`${apiBaseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: account.username,
        password: syntheticPassword,
      }),
    });
    lastLoginAttemptAt = Date.now();
    if (response.status === 200) break;
    if (response.status !== 429 && response.status !== 503) {
      throw new Error(
        `Synthetic user login failed with HTTP ${response.status}.`,
      );
    }
    const retryAfterSeconds = Number(response.headers.get("Retry-After"));
    const backoffMs = Math.max(
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0,
      10_000 * 2 ** attempt,
    );
    if (attempt === 3) {
      throw new Error(
        `Synthetic user login remained rate limited (HTTP ${response.status}).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  if (!response || response.status !== 200) {
    throw new Error("Synthetic user login did not return a Matrix session.");
  }

  const payload = await response.json();
  assert.equal(payload.matrix.user_id, expectedMatrixUserId(account.id));
  assert.ok(payload.matrix.device_id);
  assert.ok(payload.matrix.access_token);
  return { ...account, matrix: payload.matrix };
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function startSync(client) {
  const prepared = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener(sdk.ClientEvent.Sync, onSync);
      reject(new Error("Matrix client did not reach PREPARED."));
    }, 30_000);
    const onSync = (state) => {
      if (state !== sdk.SyncState.Prepared) return;
      clearTimeout(timer);
      client.removeListener(sdk.ClientEvent.Sync, onSync);
      resolve();
    };
    client.on(sdk.ClientEvent.Sync, onSync);
  });
  await client.startClient({ initialSyncLimit: 50, pollTimeout: 30_000 });
  await prepared;
}

async function createRustClient(account) {
  let client;
  const secretKeys = new Map();
  const cryptoCallbacks = {
    getSecretStorageKey: async ({ keys }) => {
      const defaultKeyId = await client.secretStorage.getDefaultKeyId();
      if (defaultKeyId && keys[defaultKeyId]) {
        const cached = secretKeys.get(defaultKeyId);
        if (cached) return [defaultKeyId, new Uint8Array(cached)];
      }
      for (const [keyId, key] of secretKeys) {
        if (keys[keyId]) return [keyId, new Uint8Array(key)];
      }
      return null;
    },
    cacheSecretStorageKey: (keyId, _keyInfo, key) => {
      secretKeys.get(keyId)?.fill(0);
      secretKeys.set(keyId, new Uint8Array(key));
    },
  };

  client = sdk.createClient({
    baseUrl: matrixUrl,
    accessToken: account.matrix.access_token,
    userId: account.matrix.user_id,
    deviceId: account.matrix.device_id,
    store: new sdk.MemoryStore(),
    cryptoStore: new sdk.MemoryCryptoStore(),
    cryptoCallbacks,
    verificationMethods: ["m.sas.v1"],
    logger,
  });
  const context = {
    account,
    client,
    crypto: null,
    secretKeys,
    cacheSecretStorageKey(keyId, key) {
      secretKeys.get(keyId)?.fill(0);
      secretKeys.set(keyId, new Uint8Array(key));
    },
  };
  clients.push(context);
  await client.initRustCrypto({ useIndexedDB: false });
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Rust crypto did not initialize.");
  context.crypto = crypto;
  crypto.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode());
  await startSync(client);
  const whoami = await client.whoami();
  assert.equal(whoami.user_id, account.matrix.user_id);
  assert.equal(whoami.device_id, account.matrix.device_id);

  return context;
}

async function setupCrossSigning(context) {
  await context.crypto.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (makeRequest) => makeRequest(null),
  });
  assert.equal(await context.crypto.isCrossSigningReady(), true);
  const ownStatus = await context.crypto.getDeviceVerificationStatus(
    context.account.matrix.user_id,
    context.account.matrix.device_id,
  );
  assert.ok(ownStatus?.isVerified());
}

async function setupRecoveryAndBackup(context) {
  const [secretStatus, existingBackup] = await Promise.all([
    context.crypto.getSecretStorageStatus(),
    context.crypto.getKeyBackupInfo(),
  ]);
  if (secretStatus.defaultKeyId || existingBackup) {
    throw new Error("A synthetic test account unexpectedly already has recovery data.");
  }

  const generated = await context.crypto.createRecoveryKeyFromPassphrase();
  if (!generated.encodedPrivateKey) {
    generated.privateKey.fill(0);
    throw new Error("The SDK did not return an encoded recovery key.");
  }
  const encodedRecoveryKey = generated.encodedPrivateKey;

  try {
    await context.crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => generated,
    });
    await context.crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest) => makeRequest(null),
    });
    assert.equal(await context.crypto.isCrossSigningReady(), true);

    const backupBefore = await context.crypto.getKeyBackupInfo();
    if (!backupBefore) {
      // This account was checked above and is a newly-created test identity.
      await context.crypto.resetKeyBackup();
    }
    const check = await context.crypto.checkKeyBackupAndEnable();
    assert.equal(check?.trustInfo.trusted, true);

    const secretStorageStatus = await context.crypto.getSecretStorageStatus();
    assert.equal(secretStorageStatus.ready, true);
    return encodedRecoveryKey;
  } finally {
    generated.privateKey.fill(0);
  }
}

async function createEncryptedRoom(context, name, invitees, shareHistory = false) {
  const initialState = [
    {
      type: "m.room.encryption",
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    },
  ];
  if (shareHistory) {
    initialState.push({
      type: "m.room.history_visibility",
      state_key: "",
      content: { history_visibility: "shared" },
    });
  }
  const response = await context.client.createRoom({
    visibility: sdk.Visibility.Private,
    preset: sdk.Preset.PrivateChat,
    is_direct: invitees.length === 1,
    invite: invitees,
    name,
    initial_state: initialState,
  });
  const encryption = await context.client.getStateEvent(
    response.room_id,
    "m.room.encryption",
    "",
  );
  assert.equal(encryption.algorithm, "m.megolm.v1.aes-sha2");
  assert.equal(
    await context.crypto.isEncryptionEnabledInRoom(response.room_id),
    true,
  );
  return response.room_id;
}

async function joinRoom(context, roomId) {
  await context.client.joinRoom(roomId);
  await waitFor(
    () => {
      const room = context.client.getRoom(roomId);
      return room?.hasEncryptionStateEvent() ? room : null;
    },
    "joined encrypted room state",
  );
}

async function eventById(context, roomId, eventId) {
  const room = context.client.getRoom(roomId);
  return room
    ?.getLiveTimeline()
    .getEvents()
    .find((event) => event.getId() === eventId);
}

async function waitForDecrypted(context, roomId, eventId, body) {
  return waitFor(async () => {
    const event = await eventById(context, roomId, eventId);
    return event?.getClearContent()?.body === body ? event : null;
  }, "the encrypted event to decrypt");
}

async function serverEvent(context, roomId, eventId, plaintext) {
  const response = await fetch(
    `${matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    {
      headers: {
        Authorization: `Bearer ${context.account.matrix.access_token}`,
      },
    },
  );
  assert.equal(response.status, 200);
  const event = await response.json();
  assert.equal(event.type, "m.room.encrypted");
  assert.equal(event.room_id, roomId);
  assert.equal(event.event_id, eventId);
  assert.equal(event.content.algorithm, "m.megolm.v1.aes-sha2");
  assert.equal(typeof event.content.ciphertext, "string");
  assert.equal(JSON.stringify(event).includes(plaintext), false);
  return {
    eventId: event.event_id,
    roomId: event.room_id,
    senderId: event.sender,
    eventType: event.type,
    ciphertextPresent: true,
    plaintextAbsent: true,
  };
}

async function waitForBackup(context) {
  return waitFor(async () => {
    const response = await fetch(
      `${matrixUrl}/_matrix/client/v3/room_keys/version`,
      {
        headers: {
          Authorization: `Bearer ${context.account.matrix.access_token}`,
        },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Synapse key-backup status returned HTTP ${response.status}.`,
      );
    }
    const backup = await response.json();
    return backup && backup.count > 0 ? backup : null;
  }, "an uploaded encrypted room-key backup", 30_000);
}

async function completeSasVerification(outgoing, incoming) {
  await incoming.accept();
  await waitFor(
    () => outgoing.phase === VerificationPhase.Ready,
    "the SAS verification request to become ready",
  );
  const verifierA = await outgoing.startVerification("m.sas.v1");
  const verifierB = await waitFor(
    () => incoming.verifier,
    "the second device to create its SAS verifier",
  );

  const waitForSas = (verifier) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SAS comparison timed out.")), 20_000);
      verifier.once(VerifierEvent.ShowSas, (callbacks) => {
        clearTimeout(timer);
        resolve(callbacks);
      });
      verifier.once(VerifierEvent.Cancel, () => {
        clearTimeout(timer);
        reject(new Error("The SAS verification was cancelled."));
      });
    });
  const sasAReady = waitForSas(verifierA);
  const sasBReady = waitForSas(verifierB);
  const verifyA = verifierA.verify();
  const verifyB = verifierB.verify();
  const [sasA, sasB] = await Promise.all([sasAReady, sasBReady]);
  const emojiA = sasA.sas.emoji?.map(([emoji]) => emoji) ?? [];
  const emojiB = sasB.sas.emoji?.map(([emoji]) => emoji) ?? [];
  assert.ok(emojiA.length > 0);
  assert.deepEqual(emojiA, emojiB);
  await Promise.all([sasA.confirm(), sasB.confirm()]);
  await Promise.all([verifyA, verifyB]);
  return emojiA.length;
}

async function waitForVerificationRequest(client, startRequest) {
  let resolveIncoming;
  let rejectIncoming;
  let timeout;
  const incomingRequest = new Promise((resolve, reject) => {
    resolveIncoming = resolve;
    rejectIncoming = reject;
  });
  const onRequest = (request) => resolveIncoming(request);
  client.on(CryptoEvent.VerificationRequestReceived, onRequest);
  try {
    const outgoing = await startRequest();
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Verification request timed out.")),
        20_000,
      );
    });
    const incoming = await Promise.race([
      incomingRequest,
      timedOut,
    ]);
    return { outgoing, incoming };
  } finally {
    if (timeout) clearTimeout(timeout);
    client.removeListener(CryptoEvent.VerificationRequestReceived, onRequest);
    void rejectIncoming;
  }
}

async function verifySas(first, second, roomId) {
  await waitFor(
    async () => {
      const devices = await first.crypto.getUserDeviceInfo(
        [second.account.matrix.user_id],
      );
      return devices.get(second.account.matrix.user_id)?.has(
        second.account.matrix.device_id,
      );
    },
    "the joined peer's device list to be tracked by Rust crypto",
  );

  const { outgoing, incoming } = await waitForVerificationRequest(
    second.client,
    () =>
      first.crypto.requestVerificationDM(
        second.account.matrix.user_id,
        roomId,
      ),
  );
  const sasItemsCompared = await completeSasVerification(outgoing, incoming);

  const status = await first.crypto.getDeviceVerificationStatus(
    second.account.matrix.user_id,
    second.account.matrix.device_id,
  );
  assert.ok(status?.isVerified());
  return { sasItemsCompared, verified: true };
}

async function verifyOwnDeviceSas(first, second) {
  const { outgoing, incoming } = await waitForVerificationRequest(
    first.client,
    () => second.crypto.requestOwnUserVerification(),
  );
  const sasItemsCompared = await completeSasVerification(outgoing, incoming);
  const status = await first.crypto.getDeviceVerificationStatus(
    first.account.matrix.user_id,
    second.account.matrix.device_id,
  );
  assert.ok(status?.isVerified());
  return { sasItemsCompared, verified: true };
}

async function restoreAHistory(accountA, recoveryKey, eventId, body) {
  const newDevice = await loginUser(accountA);
  assert.notEqual(
    newDevice.matrix.device_id,
    accountA.matrix.device_id,
    "FastAPI login should create a distinct Matrix device for this synthetic recovery test.",
  );
  const context = await createRustClient(newDevice);
  const hasNoHistoricalKey = await waitFor(async () => {
    const event = await eventById(context, dmRoomId, eventId);
    return event && event.getClearContent()?.body !== body ? event : null;
  }, "the fresh device to initially lack the historical room key");
  assert.notEqual(hasNoHistoricalKey.getClearContent()?.body, body);

  const defaultKeyId = await context.client.secretStorage.getDefaultKeyId();
  assert.ok(defaultKeyId);
  const key = decodeRecoveryKey(recoveryKey);
  try {
    context.cacheSecretStorageKey(defaultKeyId, key);
    await context.crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest) => makeRequest(null),
    });
    assert.equal(await context.crypto.isCrossSigningReady(), true);
    const check = await context.crypto.checkKeyBackupAndEnable();
    assert.equal(check?.trustInfo.trusted, true);
    await context.crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    const result = await context.crypto.restoreKeyBackup();
    assert.ok(result.imported > 0);
    const restored = await waitForDecrypted(context, dmRoomId, eventId, body);
    assert.equal(restored.getClearContent()?.body, body);
    return {
      deviceId: newDevice.matrix.device_id,
      importedKeys: result.imported,
      context,
    };
  } finally {
    key.fill(0);
  }
}

let dmRoomId;

try {
  const [accountA, accountB, accountC, lateJoiner, outsider] = await Promise.all([
    registerUser("a"),
    registerUser("b"),
    registerUser("c"),
    registerUser("late"),
    registerUser("outsider"),
  ]);
  const sessionA = await loginUser(accountA);
  const sessionB = await loginUser(accountB);
  const sessionC = await loginUser(accountC);
  const sessionLate = await loginUser(lateJoiner);
  const sessionOutsider = await loginUser(outsider);

  const [clientA, clientB, clientC, clientLate, clientOutsider] =
    await Promise.all([
      createRustClient(sessionA),
      createRustClient(sessionB),
      createRustClient(sessionC),
      createRustClient(sessionLate),
      createRustClient(sessionOutsider),
    ]);
  const recoveryKeyA = await setupRecoveryAndBackup(clientA);
  await Promise.all([
    setupCrossSigning(clientB),
    setupCrossSigning(clientC),
    setupCrossSigning(clientLate),
  ]);
  console.log("PASS FastAPI JWT sessions initialized distinct Rust-crypto Matrix devices");
  console.log("PASS device keys, cross-signing, secret storage, and trusted backup initialized");

  dmRoomId = await createEncryptedRoom(
    clientA,
    `Step 07 encrypted DM ${runId}`,
    [sessionB.matrix.user_id],
  );
  await joinRoom(clientB, dmRoomId);

  const verification = await verifySas(clientA, clientB, dmRoomId);
  console.log(
    `PASS interactive SAS verification: ${verification.sasItemsCompared} matching items and verified device trust`,
  );

  const dmMessageA = `e2ee-dm-a-${runId}`;
  const sentA = await clientA.client.sendTextMessage(dmRoomId, dmMessageA);
  const rawA = await serverEvent(
    clientA,
    dmRoomId,
    sentA.event_id,
    dmMessageA,
  );
  const receivedByB = await waitForDecrypted(
    clientB,
    dmRoomId,
    sentA.event_id,
    dmMessageA,
  );
  assert.equal(receivedByB.getSender(), sessionA.matrix.user_id);

  const dmMessageB = `e2ee-dm-b-${runId}`;
  const sentB = await clientB.client.sendTextMessage(dmRoomId, dmMessageB);
  const rawB = await serverEvent(
    clientB,
    dmRoomId,
    sentB.event_id,
    dmMessageB,
  );
  const receivedByA = await waitForDecrypted(
    clientA,
    dmRoomId,
    sentB.event_id,
    dmMessageB,
  );
  assert.equal(receivedByA.getSender(), sessionB.matrix.user_id);
  console.log(
    `PASS bidirectional encrypted DM; server events ${rawA.eventType}/${rawB.eventType}; plaintext absent`,
  );
  console.log(
    `PASS live DM metadata: room=${dmRoomId} event=${rawA.eventId} sender=${rawA.senderId} ciphertext-present`,
  );
  const backedUp = await waitForBackup(clientA);
  assert.ok(backedUp.count > 0);
  const recovery = await restoreAHistory(
    sessionA,
    recoveryKeyA,
    sentB.event_id,
    dmMessageB,
  );
  console.log(
    `PASS fresh Matrix device ${recovery.deviceId} restored ${recovery.importedKeys} historical key(s) and decrypted an old event`,
  );
  const ownDeviceVerification = await verifyOwnDeviceSas(
    clientA,
    recovery.context,
  );
  console.log(
    `PASS new account device completed interactive SAS verification: ${ownDeviceVerification.sasItemsCompared} matching items and verified device trust`,
  );

  const groupRoomId = await createEncryptedRoom(
    clientA,
    `Step 07 encrypted group ${runId}`,
    [sessionB.matrix.user_id, sessionC.matrix.user_id],
    true,
  );
  await Promise.all([
    joinRoom(clientB, groupRoomId),
    joinRoom(clientC, groupRoomId),
  ]);
  const groupMessageA = `e2ee-group-a-${runId}`;
  const groupSentA = await clientA.client.sendTextMessage(groupRoomId, groupMessageA);
  const groupRawA = await serverEvent(
    clientA,
    groupRoomId,
    groupSentA.event_id,
    groupMessageA,
  );
  await Promise.all([
    waitForDecrypted(clientB, groupRoomId, groupSentA.event_id, groupMessageA),
    waitForDecrypted(clientC, groupRoomId, groupSentA.event_id, groupMessageA),
  ]);

  const groupMessageB = `e2ee-group-b-${runId}`;
  const groupSentB = await clientB.client.sendTextMessage(groupRoomId, groupMessageB);
  const groupRawB = await serverEvent(
    clientB,
    groupRoomId,
    groupSentB.event_id,
    groupMessageB,
  );
  await Promise.all([
    waitForDecrypted(clientA, groupRoomId, groupSentB.event_id, groupMessageB),
    waitForDecrypted(clientC, groupRoomId, groupSentB.event_id, groupMessageB),
  ]);

  const groupMessageC = `e2ee-group-c-${runId}`;
  const groupSentC = await clientC.client.sendTextMessage(groupRoomId, groupMessageC);
  const groupRawC = await serverEvent(
    clientC,
    groupRoomId,
    groupSentC.event_id,
    groupMessageC,
  );
  await Promise.all([
    waitForDecrypted(clientA, groupRoomId, groupSentC.event_id, groupMessageC),
    waitForDecrypted(clientB, groupRoomId, groupSentC.event_id, groupMessageC),
  ]);
  console.log(
    `PASS three-user encrypted group exchange; server event types ${groupRawA.eventType}, ${groupRawB.eventType}, ${groupRawC.eventType}`,
  );

  await clientA.client.invite(groupRoomId, sessionLate.matrix.user_id);
  await joinRoom(clientLate, groupRoomId);
  const oldGroupEvent = await waitFor(
    () => eventById(clientLate, groupRoomId, groupSentA.event_id),
    "the late member to sync the historical encrypted event",
  );
  assert.notEqual(oldGroupEvent.getClearContent()?.body, groupMessageA);
  const futureGroupMessage = `e2ee-group-after-join-${runId}`;
  const futureSent = await clientA.client.sendTextMessage(
    groupRoomId,
    futureGroupMessage,
  );
  const futureRaw = await serverEvent(
    clientA,
    groupRoomId,
    futureSent.event_id,
    futureGroupMessage,
  );
  await Promise.all([
    waitForDecrypted(clientB, groupRoomId, futureSent.event_id, futureGroupMessage),
    waitForDecrypted(clientC, groupRoomId, futureSent.event_id, futureGroupMessage),
    waitForDecrypted(clientLate, groupRoomId, futureSent.event_id, futureGroupMessage),
  ]);
  assert.equal(
    (await eventById(clientLate, groupRoomId, groupSentA.event_id))?.getClearContent()
      ?.body === groupMessageA,
    false,
  );
  console.log(
    `PASS late member received future ciphertext (${futureRaw.eventType}) but not the pre-join room key`,
  );

  const outsiderResponse = await fetch(
    `${matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(groupRoomId)}/event/${encodeURIComponent(groupSentA.event_id)}`,
    {
      headers: {
        Authorization: `Bearer ${sessionOutsider.matrix.access_token}`,
      },
    },
  );
  assert.ok(
    outsiderResponse.status === 403 || outsiderResponse.status === 404,
    `Unrelated account unexpectedly fetched the group event (HTTP ${outsiderResponse.status}).`,
  );
  console.log(
    `PASS unrelated account cannot fetch the group's encrypted event (HTTP ${outsiderResponse.status})`,
  );
} finally {
  for (const context of clients) {
    for (const key of context.secretKeys.values()) key.fill(0);
    context.secretKeys.clear();
    context.client.stopClient();
    await context.client.logout().catch(() => undefined);
  }
}

// This one-shot Node harness can leave optional SDK RTC timers alive after all
// clients have been stopped and logged out. Exit after allowing output to flush.
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(0);
