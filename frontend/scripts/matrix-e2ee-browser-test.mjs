import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import * as sdk from "matrix-js-sdk";
import {
  CryptoEvent,
  VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { chromium } from "playwright-core";

const apiBaseUrl = process.env.LUMACHAT_TEST_API_URL?.replace(/\/+$/, "");
if (!apiBaseUrl) {
  throw new Error(
    "Set LUMACHAT_TEST_API_URL to an isolated FastAPI test server with registration enabled.",
  );
}

const webUrl = (process.env.LUMACHAT_WEB_URL || "http://localhost:5173").replace(
  /\/+$/,
  "",
);
const matrixUrl = (
  process.env.LUMACHAT_MATRIX_HOMESERVER_URL || "http://localhost:8008"
).replace(/\/+$/, "");
const matrixServerName = process.env.LUMACHAT_MATRIX_SERVER_NAME || "localhost";
const chromiumPath =
  process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium-browser";
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const password = `Step07-browser-${randomUUID()}!`;
const logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  getChild: () => logger,
};

let browser;
let page;
let clientB;
let browserErrors = [];
let consoleErrors = [];
let browserHttpErrors = [];
let unsupportedRtcTransportResponses = 0;
let expectedE2eeSetupResponses = 0;
let genericNotFoundConsoleErrors = 0;
let browserOffline = false;

function isExpectedE2eeSetupNotFound(responseUrl) {
  const path = new URL(responseUrl).pathname;
  return (
    path === "/_matrix/client/v3/room_keys/version" ||
    /^\/_matrix\/client\/v3\/user\/[^/]+\/account_data\/(?:m\.secret_storage\.default_key|m\.cross_signing\.(?:master|user_signing|self_signing))$/.test(
      path,
    )
  );
}

function expectedMatrixUserId(appUserId) {
  return `@u_${appUserId.replaceAll("-", "").toLowerCase()}:${matrixServerName}`;
}

async function registerUser(label) {
  const username = `step07_browser_${label}_${runId}`;
  const response = await fetch(`${apiBaseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${username}@example.com`,
      username,
      password,
      display_name: `Step 07 Browser ${label} ${runId}`,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`Synthetic browser user registration failed with HTTP ${response.status}.`);
  }
  const profile = await response.json();
  return {
    id: profile.id,
    username,
    displayName: profile.profile?.display_name ?? username,
  };
}

async function loginUser(account) {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: account.username, password }),
  });
  if (!response.ok) {
    throw new Error(`Synthetic browser user login failed with HTTP ${response.status}.`);
  }
  const payload = await response.json();
  assert.equal(payload.matrix.user_id, expectedMatrixUserId(account.id));
  assert.ok(payload.matrix.device_id);
  assert.ok(payload.matrix.access_token);
  return { ...account, matrix: payload.matrix };
}

async function signInThroughUi(account) {
  await page.goto(`${webUrl}/login`);
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/auth/login") &&
      response.request().method() === "POST",
  );
  await page.getByLabel("Email or username").fill(account.username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log In" }).click();
  const response = await loginResponsePromise;
  assert.equal(response.status(), 200);
  const payload = await response.json();
  assert.equal(payload.matrix.user_id, expectedMatrixUserId(account.id));
  await page.waitForURL("**/chat", { timeout: 20_000 });
  await page.getByRole("status").filter({ hasText: "Connected to Matrix" }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  return payload.matrix;
}

async function startSync(client) {
  const prepared = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener(sdk.ClientEvent.Sync, onSync);
      reject(new Error("Matrix SDK client did not reach PREPARED."));
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

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function serverEvent(session, roomId, eventId, plaintext) {
  const response = await fetch(
    `${matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${session.access_token}` } },
  );
  assert.equal(response.status, 200);
  const event = await response.json();
  assert.equal(event.type, "m.room.encrypted");
  assert.equal(event.room_id, roomId);
  assert.equal(event.event_id, eventId);
  assert.equal(event.content.algorithm, "m.megolm.v1.aes-sha2");
  assert.equal(typeof event.content.ciphertext, "string");
  assert.equal(JSON.stringify(event).includes(plaintext), false);
  return event;
}

async function createEncryptedDirectRoom(client, inviteeUserId, name) {
  const created = await client.createRoom({
    visibility: sdk.Visibility.Private,
    preset: sdk.Preset.PrivateChat,
    is_direct: true,
    invite: [inviteeUserId],
    name,
    initial_state: [
      {
        type: "m.room.encryption",
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      },
    ],
  });
  return created.room_id;
}

async function joinInvitedRoom(session, roomId) {
  const response = await fetch(
    `${matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert.equal(response.status, 200, "Browser user should join the encrypted test room");
  const result = await response.json();
  assert.equal(result.room_id, roomId);
}

function waitForVerificationRequest(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener(CryptoEvent.VerificationRequestReceived, onRequest);
      reject(new Error("Timed out waiting for User B's verification request."));
    }, 20_000);
    const onRequest = (request) => {
      clearTimeout(timer);
      client.removeListener(CryptoEvent.VerificationRequestReceived, onRequest);
      resolve(request);
    };
    client.on(CryptoEvent.VerificationRequestReceived, onRequest);
  });
}

function waitForSas(verifier) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      verifier.removeListener(VerifierEvent.ShowSas, onShowSas);
      verifier.removeListener(VerifierEvent.Cancel, onCancel);
      reject(new Error("Timed out waiting for the SAS comparison."));
    }, 20_000);
    const onShowSas = (callbacks) => {
      clearTimeout(timer);
      verifier.removeListener(VerifierEvent.Cancel, onCancel);
      resolve(callbacks);
    };
    const onCancel = () => {
      clearTimeout(timer);
      verifier.removeListener(VerifierEvent.ShowSas, onShowSas);
      reject(new Error("The SAS verification was cancelled."));
    };
    verifier.on(VerifierEvent.ShowSas, onShowSas);
    verifier.on(VerifierEvent.Cancel, onCancel);
  });
}

async function verifyPeerInBrowser(client, peerDeviceId) {
  await page.getByRole("button", { name: "Encryption and devices" }).click();
  const dialog = page.getByRole("dialog", { name: "Encryption and devices" });
  const peerDevice = dialog
    .locator(".security-device")
    .filter({ hasText: peerDeviceId });
  await peerDevice.waitFor({ state: "visible", timeout: 20_000 });

  const incomingRequest = waitForVerificationRequest(client);
  await peerDevice.getByRole("button", { name: "Verify" }).click();
  let request;
  try {
    request = await incomingRequest;
  } catch (cause) {
    const dialogText = await dialog.innerText();
    throw new Error(
      `${cause instanceof Error ? cause.message : "Verification request failed"} Dialog state: ${dialogText}`,
    );
  }
  await request.accept();

  const startButton = dialog.getByRole("button", {
    name: "Start emoji verification",
  });
  await startButton.waitFor({ state: "visible", timeout: 20_000 });
  await startButton.click();
  const verifier = await waitFor(
    () => request.verifier,
    "User B's SAS verifier",
    20_000,
  );
  const sasReady = waitForSas(verifier);
  const verification = verifier.verify();
  const callbacks = await sasReady;
  const peerEmojis = callbacks.sas.emoji?.map(([emoji]) => emoji) ?? [];
  const localEmojis = await waitFor(
    async () => {
      const values = await dialog
        .locator(".verification-emojis span")
        .allTextContents();
      return values.length > 0 ? values : null;
    },
    "the matching SAS emojis in the browser",
  );
  assert.ok(peerEmojis.length > 0);
  assert.deepEqual(localEmojis, peerEmojis);

  await dialog.getByRole("button", { name: "The emojis match" }).click();
  await callbacks.confirm();
  await verification;
  await dialog.getByText("Verified", { exact: true }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await dialog.getByRole("button", { name: "Close security settings" }).click();
  console.log(
    `PASS browser completed interactive SAS verification for User B device ${peerDeviceId}`,
  );
}

async function prepareBrowserRecovery() {
  await page.getByRole("button", { name: "Encryption and devices" }).click();
  const dialog = page.getByRole("dialog", { name: "Encryption and devices" });
  await dialog
    .getByRole("button", { name: "Generate recovery key" })
    .click();
  const recoveryKey = await dialog.locator(".recovery-key-panel code").textContent();
  assert.ok(recoveryKey?.trim(), "The SDK should generate recovery material");
  await dialog
    .getByRole("checkbox", {
      name: "I saved this recovery key in a secure place.",
    })
    .check();
  await dialog
    .getByRole("button", { name: "Enable secure recovery" })
    .click();
  await dialog.locator(".security-pill.is-trusted").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await dialog
    .getByText("Cross-signing is ready on this device.", { exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  await dialog.getByRole("button", { name: "Close security settings" }).click();
  console.log(
    "PASS browser recovery-key acknowledgement, secret storage, trusted backup, and cross-signing setup",
  );
}

async function waitForDecrypted(client, roomId, eventId, body) {
  return waitFor(() => {
    const event = client
      .getRoom(roomId)
      ?.getLiveTimeline()
      .getEvents()
      .find((candidate) => candidate.getId() === eventId);
    return event?.getClearContent()?.body === body ? event : null;
  }, "the Node Matrix client to decrypt the browser-sent event");
}

async function signOutThroughUi() {
  if (!page) return;
  await page.getByRole("button", { name: "Sign out" }).click({ timeout: 3_000 });
  await page.getByLabel("Email or username").waitFor({
    state: "visible",
    timeout: 8_000,
  });
}

try {
  const accountA = await registerUser("a");
  const accountB = await registerUser("b");
  const sessionB = await loginUser(accountB);

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const browserContext = await browser.newContext({
    viewport: { width: 1365, height: 900 },
  });
  page = await browserContext.newPage();
  page.on("pageerror", (error) => {
    if (
      browserOffline &&
      /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|failed to fetch|networkerror/i.test(
        error.message,
      )
    ) {
      return;
    }
    browserErrors.push(error.message);
  });
  page.on("response", (response) => {
    if (
      response.status() === 404 &&
      response.url().includes(
        "/_matrix/client/unstable/org.matrix.msc4143/rtc/transports",
      )
    ) {
      unsupportedRtcTransportResponses += 1;
      return;
    }
    if (
      response.status() === 404 &&
      isExpectedE2eeSetupNotFound(response.url())
    ) {
      expectedE2eeSetupResponses += 1;
      return;
    }
    if (response.status() >= 400) {
      browserHttpErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      browserOffline &&
      /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_FAILED|failed to fetch|networkerror/i.test(
        message.text(),
      )
    ) {
      return;
    }
    if (message.text() === "Failed to load resource: the server responded with a status of 404 (Not Found)") {
      genericNotFoundConsoleErrors += 1;
    } else {
      consoleErrors.push(message.text());
    }
  });

  const sessionA = await signInThroughUi(accountA);
  assert.notEqual(sessionA.user_id, sessionB.matrix.user_id);

  clientB = sdk.createClient({
    baseUrl: matrixUrl,
    accessToken: sessionB.matrix.access_token,
    userId: sessionB.matrix.user_id,
    deviceId: sessionB.matrix.device_id,
    store: new sdk.MemoryStore(),
    cryptoStore: new sdk.MemoryCryptoStore(),
    logger,
    verificationMethods: ["m.sas.v1"],
  });
  await clientB.initRustCrypto({ useIndexedDB: false });
  assert.ok(clientB.getCrypto());
  await startSync(clientB);
  assert.equal((await clientB.whoami()).user_id, sessionB.matrix.user_id);
  await clientB.getCrypto().bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (makeRequest) => makeRequest(null),
  });
  assert.equal(await clientB.getCrypto().isCrossSigningReady(), true);

  const roomId = await createEncryptedDirectRoom(
    clientB,
    sessionA.user_id,
    `Step 07 browser E2EE ${runId}`,
  );
  await waitFor(
    () => clientB.getRoom(roomId)?.hasEncryptionStateEvent(),
    "User B to synchronize the encrypted room state",
  );
  await joinInvitedRoom(sessionA, roomId);
  const roomRow = page
    .locator(".conversation-row")
    .filter({ hasText: `Step 07 browser E2EE ${runId}` });
  await roomRow.waitFor({ state: "visible", timeout: 30_000 });
  await roomRow.click();
  await page.getByLabel("Write a message").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  assert.ok(roomId.startsWith("!"));
  await prepareBrowserRecovery();
  await verifyPeerInBrowser(clientB, sessionB.matrix.device_id);

  await waitFor(
    () => clientB.getRoom(roomId)?.hasEncryptionStateEvent(),
    "User B to synchronize the room encryption state",
  );
  assert.equal(clientB.getRoom(roomId)?.getMyMembership(), "join");
  assert.equal(
    await clientB.getCrypto().isEncryptionEnabledInRoom(roomId),
    true,
  );

  const inboundBody = `e2ee-browser-inbound-${runId}`;
  const inbound = await clientB.sendTextMessage(roomId, inboundBody);
  const inboundWireEvent = await serverEvent(
    sessionB.matrix,
    roomId,
    inbound.event_id,
    inboundBody,
  );
  const inboundRow = page.locator(
    `.message-row[data-event-id="${inbound.event_id}"]`,
  );
  await inboundRow.waitFor({ state: "visible", timeout: 30_000 });
  await inboundRow.getByText(inboundBody, { exact: true }).waitFor({
    state: "visible",
  });
  assert.equal(await inboundRow.count(), 1);
  assert.equal(await inboundRow.getAttribute("data-room-id"), roomId);
  assert.equal(await inboundRow.getAttribute("data-event-type"), "m.room.encrypted");
  assert.equal(
    await inboundRow.getAttribute("data-sender-id"),
    sessionB.matrix.user_id,
  );
  console.log(
    `PASS React Matrix client decrypted a live server event ${inboundWireEvent.event_id}; wire type=m.room.encrypted; plaintext absent`,
  );

  const outboundBody = `e2ee-browser-outbound-${runId}`;
  await page.getByLabel("Write a message").fill(outboundBody);
  await page.getByRole("button", { name: "Send message" }).click();
  const outboundRow = page
    .locator(".message-row")
    .filter({ hasText: outboundBody });
  await outboundRow.waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(
    async () =>
      (await outboundRow.getAttribute("data-event-type")) === "m.room.encrypted",
    "the React event to reflect its encrypted wire type",
  );
  const outboundEventId = await outboundRow.getAttribute("data-event-id");
  assert.ok(outboundEventId);
  assert.equal(
    await outboundRow.getAttribute("data-event-type"),
    "m.room.encrypted",
  );
  const outboundWireEvent = await serverEvent(
    sessionB.matrix,
    roomId,
    outboundEventId,
    outboundBody,
  );
  const decryptedByB = await waitForDecrypted(
    clientB,
    roomId,
    outboundEventId,
    outboundBody,
  );
  assert.equal(decryptedByB.getSender(), sessionA.user_id);
  console.log(
    `PASS React composer sent event ${outboundWireEvent.event_id}; User B decrypted the exact message; wire type=m.room.encrypted`,
  );

  browserOffline = true;
  await browserContext.setOffline(true);
  const offlineTriggerBody = `e2ee-browser-offline-trigger-${runId}`;
  const offlineTrigger = await clientB.sendTextMessage(
    roomId,
    offlineTriggerBody,
  );
  await serverEvent(
    sessionB.matrix,
    roomId,
    offlineTrigger.event_id,
    offlineTriggerBody,
  );
  await page.getByRole("status").filter({ hasText: "Reconnecting to Matrix" }).first().waitFor({
    state: "visible",
    timeout: 25_000,
  });
  const missedBody = `e2ee-browser-reconnect-${runId}`;
  const missed = await clientB.sendTextMessage(roomId, missedBody);
  const missedWireEvent = await serverEvent(
    sessionB.matrix,
    roomId,
    missed.event_id,
    missedBody,
  );
  await browserContext.setOffline(false);
  browserOffline = false;
  const recoveredRow = page.locator(
    `.message-row[data-event-id="${missed.event_id}"]`,
  );
  await recoveredRow.waitFor({ state: "visible", timeout: 60_000 });
  await recoveredRow.getByText(missedBody, { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  assert.equal(await recoveredRow.count(), 1);
  await page.getByRole("status").filter({ hasText: "Connected to Matrix" }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  console.log(
    `PASS browser recovered and decrypted offline event ${missedWireEvent.event_id} without a refresh`,
  );

  assert.deepEqual(browserErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(browserHttpErrors, []);
  assert.equal(
    genericNotFoundConsoleErrors,
    unsupportedRtcTransportResponses + expectedE2eeSetupResponses,
  );
  console.log("PASS browser JavaScript and unexpected console errors: 0");
  console.log(
    `PASS SDK's unsupported optional RTC probe produced ${unsupportedRtcTransportResponses} expected 404 response(s)`,
  );
  console.log(
    `PASS new-account crypto discovery produced ${expectedE2eeSetupResponses} expected not-configured response(s)`,
  );
  console.log(
    `PASS browser E2EE room=${roomId} sender=${sessionA.user_id} receiver=${sessionB.matrix.user_id}`,
  );
} finally {
  if (page) await signOutThroughUi().catch(() => undefined);
  if (page) await page.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (clientB) {
    clientB.stopClient();
    await clientB.logout().catch(() => undefined);
  }
}

// Rust crypto may keep optional SDK RTC timers alive after its Matrix client is
// stopped. This one-shot browser harness exits after awaited cleanup finishes.
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(0);
