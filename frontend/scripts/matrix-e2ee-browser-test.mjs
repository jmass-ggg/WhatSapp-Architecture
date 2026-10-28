import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

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
// Keep the conservative Synapse default for unspecified servers. The isolated
// local test homeserver can override this after applying test-only rc_login limits.
const minimumLoginIntervalMs = Number(
  process.env.LUMACHAT_TEST_MATRIX_LOGIN_INTERVAL_MS ?? 350_000,
);
if (!Number.isFinite(minimumLoginIntervalMs) || minimumLoginIntervalMs < 0) {
  throw new Error(
    "LUMACHAT_TEST_MATRIX_LOGIN_INTERVAL_MS must be a non-negative number.",
  );
}

let browser;
let browserContext;
let page;
let pageB;
let pageC;
let browserContextB;
let browserContextC;
let browserErrors = [];
let consoleErrors = [];
let browserHttpErrors = [];
let browserAuthRequests = [];
let unsupportedRtcTransportResponses = 0;
let expectedE2eeSetupResponses = 0;
let unauthenticatedRestoreResponses = 0;
let genericNotFoundConsoleErrors = 0;
let browserOffline = false;
let lastLoginAttemptAt = 0;

async function respectMatrixLoginRateLimit() {
  const waitMs = Math.max(
    0,
    lastLoginAttemptAt + minimumLoginIntervalMs - Date.now(),
  );
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastLoginAttemptAt = Date.now();
}

function waitForLoginResponse(targetPage) {
  return targetPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/auth/login") &&
      response.request().method() === "POST",
    { timeout: 60_000 },
  );
}

async function retryLimitedLogin(targetPage, initialResponse, buttonName) {
  let response = initialResponse;
  lastLoginAttemptAt = Date.now();
  for (let attempt = 0; response.status() !== 200 && attempt < 2; attempt += 1) {
    if (response.status() !== 429 && response.status() !== 503) break;
    console.log(
      `RETRY login returned HTTP ${response.status()}; waiting for the Matrix login interval`,
    );
    const button = targetPage.getByRole("button", { name: buttonName });
    await button.waitFor({ state: "visible", timeout: 20_000 });
    await respectMatrixLoginRateLimit();
    const nextResponse = waitForLoginResponse(targetPage);
    await button.click();
    response = await nextResponse;
    lastLoginAttemptAt = Date.now();
  }
  return response;
}

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

async function registerThroughUi(label, targetPage = page) {
  const username = `step07_browser_${label}_${runId}`;
  await targetPage.goto(`${webUrl}/register`);
  await targetPage.getByLabel("Full name").fill(`Step 07 Browser ${label} ${runId}`);
  await targetPage.getByLabel("Email address").fill(`${username}@example.com`);
  await targetPage.getByLabel("Username").fill(username);
  await targetPage.getByLabel("Password", { exact: true }).fill(password);
  await targetPage.getByLabel("Confirm password").fill(password);
  await targetPage.getByLabel(/I agree to the/).check();
  await respectMatrixLoginRateLimit();
  const registrationPromise = targetPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/auth/register") &&
      response.request().method() === "POST",
  );
  const loginResponsePromise = waitForLoginResponse(targetPage).catch(
    (error) => ({ waitError: error }),
  );
  await targetPage.getByRole("button", { name: "Create Account" }).click();

  let registration;
  try {
    registration = await registrationPromise;
  } catch (cause) {
    const formErrors = await targetPage
      .locator('[role="alert"]')
      .allTextContents()
      .catch(() => []);
    throw new Error(
      `Registration request did not complete at ${targetPage.url()}. Form errors: ${formErrors.join(" | ") || "none"}`,
      { cause },
    );
  }
  assert.equal(registration.status(), 201);
  const profile = await registration.json();
  const loginResponseResult = await loginResponsePromise;
  if ("waitError" in loginResponseResult) {
    const notices = await targetPage
      .locator('[role="alert"], [role="status"]')
      .allTextContents()
      .catch(() => []);
    throw new Error(
      `Automatic login request did not complete at ${targetPage.url()}. Notices: ${notices.join(" | ") || "none"}. Auth requests observed: ${browserAuthRequests.join(", ") || "none"}`,
      { cause: loginResponseResult.waitError },
    );
  }
  const loginResponse = await retryLimitedLogin(
    targetPage,
    loginResponseResult,
    "Retry sign in",
  );
  assert.equal(loginResponse.status(), 200);
  const payload = await loginResponse.json();
  assert.equal(payload.matrix.user_id, expectedMatrixUserId(profile.id));
  assert.ok(payload.access_token);
  assert.ok(payload.matrix.access_token);
  assert.ok(payload.matrix.device_id);
  await targetPage.waitForURL("**/chat", { timeout: 20_000 });
  await targetPage.getByRole("status")
    .filter({ hasText: "Encrypted chat ready" })
    .first()
    .waitFor({ state: "visible", timeout: 45_000 });
  return {
    account: {
      id: profile.id,
      username,
      displayName: profile.profile?.display_name ?? username,
    },
    appAccessToken: payload.access_token,
    matrix: payload.matrix,
  };
}

async function loginThroughUi(account, targetPage = page) {
  const authRequestStart = browserAuthRequests.length;
  await respectMatrixLoginRateLimit();
  await targetPage.goto(`${webUrl}/login`);
  await targetPage.getByLabel("Email or username").fill(account.username);
  await targetPage.getByLabel("Password", { exact: true }).fill(password);
  const loginResponsePromise = waitForLoginResponse(targetPage);
  await targetPage.getByRole("button", { name: "Log In" }).click();

  let firstResponse;
  try {
    firstResponse = await loginResponsePromise;
  } catch (cause) {
    const notices = await targetPage
      .locator('[role="alert"], [role="status"]')
      .allTextContents()
      .catch(() => []);
    throw new Error(
      `Login response did not complete at ${targetPage.url()}. Notices: ${notices.join(" | ") || "none"}. Auth requests from this page: ${browserAuthRequests.slice(authRequestStart).join(", ") || "none"}`,
      { cause },
    );
  }
  const loginResponse = await retryLimitedLogin(
    targetPage,
    firstResponse,
    "Log In",
  );
  assert.equal(loginResponse.status(), 200);
  const payload = await loginResponse.json();
  assert.equal(payload.matrix.user_id, expectedMatrixUserId(account.id));
  assert.ok(payload.access_token);
  assert.ok(payload.matrix.access_token);
  assert.ok(payload.matrix.device_id);
  await targetPage.waitForURL("**/chat", { timeout: 20_000 });
  return {
    ...account,
    appAccessToken: payload.access_token,
    matrix: payload.matrix,
  };
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

async function waitForServerEventId(row, label) {
  return waitFor(async () => {
    const eventId = await row.getAttribute("data-event-id");
    return eventId && !eventId.startsWith("~") ? eventId : null;
  }, label, 30_000);
}

async function serverEvent(session, roomId, eventId, plaintext) {
  return waitFor(async () => {
    const response = await fetch(
      `${matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${session.access_token}` } },
    );
    if (response.status === 404) return null;
    assert.equal(response.status, 200);
    const event = await response.json();
    assert.equal(event.type, "m.room.encrypted");
    assert.equal(event.room_id, roomId);
    assert.equal(event.event_id, eventId);
    assert.equal(event.content.algorithm, "m.megolm.v1.aes-sha2");
    assert.equal(typeof event.content.ciphertext, "string");
    assert.equal(JSON.stringify(event).includes(plaintext), false);
    return event;
  }, `encrypted event ${eventId} to reach Synapse`, 15_000);
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

async function sendTyping(session, roomId, isTyping) {
  const response = await fetch(
    `${matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(session.user_id)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        isTyping ? { typing: true, timeout: 15_000 } : { typing: false },
      ),
    },
  );
  assert.ok(response.ok, "Matrix should accept the synthetic typing indicator");
}

async function verifyPeerInBrowser(initiatorPage, responderPage, peerDeviceId) {
  await initiatorPage
    .getByRole("button", { name: "Encryption and devices" })
    .click();
  await responderPage
    .getByRole("button", { name: "Encryption and devices" })
    .click();
  const initiatorDialog = initiatorPage.getByRole("dialog", {
    name: "Encryption and devices",
  });
  const responderDialog = responderPage.getByRole("dialog", {
    name: "Encryption and devices",
  });
  const peerDevice = initiatorDialog
    .locator(".security-device")
    .filter({ hasText: peerDeviceId });
  await peerDevice.waitFor({ state: "visible", timeout: 20_000 });
  await peerDevice.getByRole("button", { name: "Verify" }).click();
  const acceptButton = responderDialog.getByRole("button", {
    name: "Accept verification",
  });
  await acceptButton.waitFor({ state: "visible", timeout: 20_000 });
  await acceptButton.click();

  const startButton = initiatorDialog.getByRole("button", {
    name: "Start emoji verification",
  });
  await startButton.waitFor({ state: "visible", timeout: 20_000 });
  await startButton.click();
  const initiatorEmojis = initiatorDialog.locator(".verification-emojis span");
  const responderEmojis = responderDialog.locator(".verification-emojis span");
  await initiatorEmojis.first().waitFor({ state: "visible", timeout: 20_000 });
  await responderEmojis.first().waitFor({ state: "visible", timeout: 20_000 });
  const [emojiA, emojiB] = await Promise.all([
    initiatorEmojis.allTextContents(),
    responderEmojis.allTextContents(),
  ]);
  assert.ok(emojiA.length > 0);
  assert.deepEqual(emojiA, emojiB);

  await Promise.all([
    initiatorDialog
      .getByRole("button", { name: "The emojis match" })
      .click(),
    responderDialog
      .getByRole("button", { name: "The emojis match" })
      .click(),
  ]);
  await Promise.all([
    initiatorDialog.getByText("Verified", { exact: true }).waitFor({
      state: "visible",
      timeout: 20_000,
    }),
    responderDialog.getByText("Verified", { exact: true }).waitFor({
      state: "visible",
      timeout: 20_000,
    }),
  ]);
  await Promise.all([
    initiatorDialog
      .getByRole("button", { name: "Close security settings" })
      .click(),
    responderDialog
      .getByRole("button", { name: "Close security settings" })
      .click(),
  ]);
  console.log(
    `PASS both browser clients completed interactive SAS verification for device ${peerDeviceId}`,
  );
}

async function verifyAutomaticCryptoSetup(targetPage = page) {
  assert.equal(
    await targetPage.getByRole("dialog", { name: "Save your recovery key" }).count(),
    0,
    "New accounts must not receive a blocking recovery-key dialog",
  );
  await targetPage
    .getByRole("button", { name: "Encryption and devices" })
    .click();
  const dialog = targetPage.getByRole("dialog", {
    name: "Encryption and devices",
  });
  await dialog
    .getByText("Cross-signing is ready on this device.", { exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  await dialog.getByText(
    "No encrypted history backup is configured. Losing this device may make old messages unrecoverable.",
    { exact: true },
  ).waitFor({ state: "visible", timeout: 20_000 });
  for (const name of [
    "Generate recovery key",
    "Save recovery key",
    "I saved my recovery key",
  ]) {
    assert.equal(
      await dialog.getByRole("button", { name, exact: true }).count(),
      0,
      `New account setup must not expose "${name}"`,
    );
  }
  await dialog.getByRole("button", { name: "Close security settings" }).click();
  console.log(
    "PASS automatic cross-signing setup without recovery-key UI or an implied history backup",
  );
}

function monitorPage(targetPage) {
  targetPage.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/auth/")) {
      browserAuthRequests.push(`${request.method()} ${path}`);
    }
  });
  targetPage.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/auth/")) {
      browserAuthRequests.push(
        `${request.method()} ${path} failed: ${request.failure()?.errorText ?? "unknown"}`,
      );
    }
  });
  targetPage.on("pageerror", (error) => {
    if (
      targetPage === page &&
      browserOffline &&
      /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|failed to fetch|networkerror/i.test(
        error.message,
      )
    ) {
      return;
    }
    browserErrors.push(error.message);
  });
  targetPage.on("response", (response) => {
    if (
      response.status() === 401 &&
      new URL(response.url()).pathname.endsWith("/auth/restore")
    ) {
      unauthenticatedRestoreResponses += 1;
      return;
    }
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
  targetPage.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      message.text() ===
        "Failed to load resource: the server responded with a status of 401 (Unauthorized)" &&
      new URL(message.location().url).pathname.endsWith("/auth/restore")
    ) {
      return;
    }
    if (
      targetPage === page &&
      browserOffline &&
      /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_FAILED|failed to fetch|networkerror/i.test(
        message.text(),
      )
    ) {
      return;
    }
    if (
      message.text() ===
      "Failed to load resource: the server responded with a status of 404 (Not Found)"
    ) {
      genericNotFoundConsoleErrors += 1;
    } else {
      consoleErrors.push(message.text());
    }
  });
}

async function signOutThroughUi(targetPage = page) {
  if (!targetPage) return;
  await targetPage.getByRole("button", { name: "Sign out" }).click({ timeout: 3_000 });
  await targetPage.getByLabel("Email or username").waitFor({
    state: "visible",
    timeout: 8_000,
  });
}

async function assertNoServerBackup(session) {
  const response = await fetch(
    `${matrixUrl}/_matrix/client/v3/room_keys/version`,
    {
      headers: { Authorization: `Bearer ${session.access_token}` },
    },
  );
  if (response.status === 404) return;
  assert.equal(response.status, 200);
  const backup = await response.json();
  assert.equal(backup.count, 0, "New-account setup must not create a key backup");
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  browserContext = await browser.newContext({
    viewport: { width: 1365, height: 900 },
  });
  browserContextB = await browser.newContext({
    viewport: { width: 1365, height: 900 },
  });
  page = await browserContext.newPage();
  pageB = await browserContextB.newPage();
  monitorPage(page);
  monitorPage(pageB);

  const registeredA = await registerThroughUi("a");
  const accountA = registeredA.account;
  const sessionA = registeredA.matrix;
  await verifyAutomaticCryptoSetup(page);
  await assertNoServerBackup(sessionA);
  console.log("PASS Alice registered through the UI and was signed in automatically");

  const registeredB = await registerThroughUi("b", pageB);
  const accountB = registeredB.account;
  const sessionB = registeredB;
  await verifyAutomaticCryptoSetup(pageB);
  await assertNoServerBackup(sessionB.matrix);
  assert.notEqual(sessionA.user_id, sessionB.matrix.user_id);
  console.log("PASS Bob registered through the UI and was signed in automatically");

  const restoreResponsePromise = pageB.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith("/auth/restore"),
    { timeout: 30_000 },
  );
  await pageB.reload();
  const restoreResponse = await restoreResponsePromise;
  assert.equal(restoreResponse.status(), 200);
  const restoredSession = await restoreResponse.json();
  assert.equal(restoredSession.matrix.device_id, sessionB.matrix.device_id);
  await pageB.getByRole("status")
    .filter({ hasText: "Encrypted chat ready" }).first()
    .waitFor({ state: "visible", timeout: 45_000 });
  console.log("PASS browser reload resumed Bob's Matrix device and crypto readiness");

  await page.getByRole("button", { name: "Start a new chat" }).click();
  const directoryDialog = page.getByRole("dialog", {
    name: "Start a conversation",
  });
  await directoryDialog
    .getByPlaceholder("Search username")
    .fill(accountB.username);
  const requestResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/connections/requests") &&
      response.request().method() === "POST",
  );
  await directoryDialog
    .getByRole("button", { name: "Add Contact" })
    .click();
  const requestResponse = await requestResponsePromise;
  assert.ok(requestResponse.ok(), "Alice's contact request should be accepted");
  const connectionRequest = await requestResponse.json();
  assert.equal(connectionRequest.status, "pending");
  await directoryDialog.getByRole("button", { name: "Close" }).click();

  const acceptance = await fetch(
    `${apiBaseUrl}/connections/${encodeURIComponent(connectionRequest.id)}/accept`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionB.appAccessToken}`,
      },
    },
  );
  assert.ok(acceptance.ok, "Bob should accept Alice's contact request");
  const acceptedConnection = await acceptance.json();
  assert.equal(acceptedConnection.status, "accepted");

  await Promise.all([
    page.evaluate(() => window.dispatchEvent(new Event("focus"))),
    pageB.evaluate(() => window.dispatchEvent(new Event("focus"))),
  ]);
  const roomRow = page
    .locator(".conversation-row")
    .filter({ hasText: accountB.displayName });
  await roomRow.waitFor({ state: "visible", timeout: 30_000 });
  await roomRow.click();
  await page.getByLabel("Write a message").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const roomPath = new URL(page.url()).pathname.split("/").at(-1);
  assert.ok(roomPath);
  const roomId = decodeURIComponent(roomPath);
  assert.ok(roomId.startsWith("!"));
  await joinInvitedRoom(sessionB.matrix, roomId);
  const bobRoomRow = pageB
    .locator(".conversation-row")
    .filter({ hasText: accountA.displayName });
  await bobRoomRow.waitFor({ state: "visible", timeout: 45_000 });
  await bobRoomRow.click();
  await pageB.getByLabel("Write a message").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await verifyPeerInBrowser(page, pageB, sessionB.matrix.device_id);

  const aliceBody = `e2ee-browser-alice-to-bob-${runId}`;
  await pageB.evaluate(() => {
    window.history.pushState({}, "", "/chat");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await pageB.getByRole("button", { name: "Start a new chat" }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.getByLabel("Write a message").fill(aliceBody);
  await page.getByRole("button", { name: "Send message" }).click();
  const aliceRow = page
    .locator(".message-row")
    .filter({ hasText: aliceBody });
  await aliceRow.waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(
    async () =>
      (await aliceRow.getAttribute("data-event-type")) === "m.room.encrypted",
    "Alice's React event to reflect its encrypted wire type",
  );
  const aliceEventId = await waitForServerEventId(
    aliceRow,
    "Alice's message to be acknowledged by Synapse",
  );
  assert.equal(
    await aliceRow.getAttribute("data-event-type"),
    "m.room.encrypted",
  );
  const aliceWireEvent = await serverEvent(
    sessionA,
    roomId,
    aliceEventId,
    aliceBody,
  );
  const readReceiptPromise = pageB.waitForResponse(
    (response) =>
      response.url().includes("/receipt/") &&
      response.url().includes("m.read"),
    { timeout: 25_000 },
  );
  await bobRoomRow.click();
  await pageB.getByLabel("Write a message").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const readReceipt = await readReceiptPromise;
  assert.ok(readReceipt.ok(), "Bob's read receipt should reach Synapse");
  const aliceRowOnBob = pageB.locator(
    `.message-row[data-event-id="${aliceEventId}"]`,
  );
  await aliceRowOnBob.getByText(aliceBody, { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  assert.equal(await aliceRowOnBob.getAttribute("data-event-type"), "m.room.encrypted");
  assert.equal(await aliceRowOnBob.getAttribute("data-sender-id"), sessionA.user_id);
  console.log(
    `PASS Alice's React composer sent encrypted event ${aliceWireEvent.event_id}; Bob decrypted it and sent a read receipt`,
  );

  await sendTyping(sessionB.matrix, roomId, true);
  await page
    .locator(".typing-row")
    .filter({ hasText: accountB.displayName })
    .waitFor({ state: "visible", timeout: 20_000 });
  await sendTyping(sessionB.matrix, roomId, false);
  await page
    .locator(".typing-row")
    .filter({ hasText: accountB.displayName })
    .waitFor({ state: "hidden", timeout: 20_000 });
  console.log("PASS Alice's active chat displayed and cleared Bob's Matrix typing indicator");

  const bobBody = `e2ee-browser-bob-to-alice-${runId}`;
  await pageB.getByLabel("Write a message").fill(bobBody);
  await pageB.getByRole("button", { name: "Send message" }).click();
  const bobRow = pageB.locator(".message-row").filter({ hasText: bobBody });
  await bobRow.waitFor({ state: "visible", timeout: 30_000 });
  const bobEventId = await waitForServerEventId(
    bobRow,
    "Bob's message to be acknowledged by Synapse",
  );
  await waitFor(
    async () =>
      (await bobRow.getAttribute("data-event-type")) === "m.room.encrypted",
    "Bob's React event to reflect its encrypted wire type",
  );
  const bobWireEvent = await serverEvent(
    sessionB.matrix,
    roomId,
    bobEventId,
    bobBody,
  );
  const bobRowOnAlice = page.locator(
    `.message-row[data-event-id="${bobEventId}"]`,
  );
  await bobRowOnAlice.getByText(bobBody, { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  assert.equal(await bobRowOnAlice.getAttribute("data-event-type"), "m.room.encrypted");
  assert.equal(await bobRowOnAlice.getAttribute("data-sender-id"), sessionB.matrix.user_id);
  for (const row of [aliceRow, aliceRowOnBob, bobRow, bobRowOnAlice]) {
    const timestamp = await row.locator("time").getAttribute("datetime");
    assert.ok(timestamp && Number.isFinite(Date.parse(timestamp)));
  }
  console.log(
    `PASS Bob's React composer sent encrypted event ${bobWireEvent.event_id}; Alice decrypted it; message timestamps are present`,
  );

  browserOffline = true;
  await browserContext.setOffline(true);
  const offlineTriggerBody = `e2ee-browser-offline-trigger-${runId}`;
  await pageB.getByLabel("Write a message").fill(offlineTriggerBody);
  await pageB.getByRole("button", { name: "Send message" }).click();
  const offlineTriggerRow = pageB
    .locator(".message-row")
    .filter({ hasText: offlineTriggerBody });
  await offlineTriggerRow.waitFor({ state: "visible", timeout: 30_000 });
  const offlineTriggerId = await waitForServerEventId(
    offlineTriggerRow,
    "Bob's offline trigger message to be acknowledged by Synapse",
  );
  await serverEvent(
    sessionB.matrix,
    roomId,
    offlineTriggerId,
    offlineTriggerBody,
  );
  await page.getByRole("status").filter({ hasText: "Reconnecting to Matrix" }).first().waitFor({
    state: "visible",
    timeout: 45_000,
  });
  const missedBody = `e2ee-browser-reconnect-${runId}`;
  await pageB.getByLabel("Write a message").fill(missedBody);
  await pageB.getByRole("button", { name: "Send message" }).click();
  const missedRowOnBob = pageB
    .locator(".message-row")
    .filter({ hasText: missedBody });
  await missedRowOnBob.waitFor({ state: "visible", timeout: 30_000 });
  const missedEventId = await waitForServerEventId(
    missedRowOnBob,
    "Bob's reconnect message to be acknowledged by Synapse",
  );
  const missedWireEvent = await serverEvent(
    sessionB.matrix,
    roomId,
    missedEventId,
    missedBody,
  );
  await browserContext.setOffline(false);
  browserOffline = false;
  const recoveredRow = page.locator(
    `.message-row[data-event-id="${missedEventId}"]`,
  );
  await recoveredRow.waitFor({ state: "visible", timeout: 60_000 });
  await recoveredRow.getByText(missedBody, { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  assert.equal(await recoveredRow.count(), 1);
  await page.getByRole("status").filter({ hasText: "Encrypted chat ready" }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  console.log(
    `PASS browser recovered and decrypted offline event ${missedWireEvent.event_id} without a refresh`,
  );

  const originalBobDeviceId = sessionB.matrix.device_id;
  await assertNoServerBackup(sessionB.matrix);
  browserContextC = await browser.newContext({
    viewport: { width: 1365, height: 900 },
  });
  pageC = await browserContextC.newPage();
  monitorPage(pageC);
  const sessionC = await loginThroughUi(accountB, pageC);
  assert.notEqual(
    sessionC.matrix.device_id,
    originalBobDeviceId,
    "A new login should receive a distinct Matrix device for history recovery",
  );
  const devicesResponse = await fetch(
    `${matrixUrl}/_matrix/client/v3/devices`,
    { headers: { Authorization: `Bearer ${sessionC.matrix.access_token}` } },
  );
  assert.equal(devicesResponse.status, 200);
  const deviceList = await devicesResponse.json();
  assert.ok(
    deviceList.devices.some(
      (device) => device.device_id === originalBobDeviceId,
    ) &&
      deviceList.devices.some(
        (device) => device.device_id === sessionC.matrix.device_id,
      ),
    "The original Matrix device identity should remain registered",
  );
  const recoveryWarning = pageC.getByRole("dialog", {
    name: "Encryption setup needs attention",
  });
  await recoveryWarning.waitFor({ state: "visible", timeout: 45_000 });
  await recoveryWarning
    .getByText(/No replacement identity or recovery backup was created/)
    .waitFor({ state: "visible", timeout: 20_000 });
  await recoveryWarning.locator(".security-pill.is-not_configured").waitFor({
    state: "visible",
    timeout: 20_000,
  });
  assert.equal(
    await recoveryWarning.getByRole("button", {
      name: "Generate recovery key",
      exact: true,
    }).count(),
    0,
  );
  await recoveryWarning
    .getByRole("button", { name: "Close security settings" })
    .click();
  const bobRoomOnNewDevice = pageC
    .locator(".conversation-row")
    .filter({ hasText: accountA.displayName });
  await bobRoomOnNewDevice.waitFor({ state: "visible", timeout: 45_000 });
  await bobRoomOnNewDevice.click();
  await pageC.getByLabel("Write a message").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  console.log(
    `PASS unconfigured new device ${sessionC.matrix.device_id} preserved Bob's existing identity and was blocked pending recovery; original device ${originalBobDeviceId} remains registered`,
  );
  assert.equal(
    await pageC.getByLabel("Write a message").isDisabled(),
    true,
    "The composer must remain disabled until the existing identity is recovered",
  );
  assert.equal(
    await pageC.getByRole("button", { name: "Send message" }).isDisabled(),
    true,
    "A device without the existing cross-signing keys must not send",
  );

  assert.deepEqual(browserErrors, []);
  assert.equal(unauthenticatedRestoreResponses, 3);
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
  if (pageC) await signOutThroughUi(pageC).catch(() => undefined);
  if (pageB) await signOutThroughUi(pageB).catch(() => undefined);
  if (page) await signOutThroughUi(page).catch(() => undefined);
  if (page) await page.close().catch(() => undefined);
  if (pageB) await pageB.close().catch(() => undefined);
  if (pageC) await pageC.close().catch(() => undefined);
  if (browserContextC) await browserContextC.close().catch(() => undefined);
  if (browserContextB) await browserContextB.close().catch(() => undefined);
  if (browserContext) await browserContext.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
}

// This one-shot browser harness exits after awaited client cleanup finishes.
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(0);
