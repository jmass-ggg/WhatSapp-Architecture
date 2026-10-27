import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  createClient,
  MemoryStore,
  Preset,
  Visibility,
} from "matrix-js-sdk";
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
const password = `Step06-test-${randomUUID()}!`;

let browser;
let page;
let clientA;
let clientB;
let browserErrors = [];
let browserConsoleErrors = [];
let browserHttpErrors = [];
let unsupportedRtcTransportResponses = 0;
let expectedOfflinePageErrors = 0;
let expectedOfflineNetworkErrors = 0;
let browserOfflineForReconnect = false;
let accountAWasLoggedOut = false;

function ensureMatrixSession(session, expectedUserId) {
  assert.equal(typeof session?.access_token, "string");
  assert.ok(session.access_token.length > 0);
  assert.equal(session.user_id, expectedUserId);
  assert.equal(typeof session.device_id, "string");
  assert.ok(session.device_id.length > 0);
}

function expectedMatrixUserId(appUserId) {
  const localpart = `u_${appUserId.replaceAll("-", "").toLowerCase()}`;
  return `@${localpart}:${matrixServerName}`;
}

async function registerUser(label) {
  const username = `step06_${label}_${runId}`;
  const registration = await fetch(`${apiBaseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${username}@example.com`,
      username,
      password,
      display_name: `Step 06 ${label.toUpperCase()} ${runId}`,
    }),
  });
  if (registration.status !== 201) {
    throw new Error(
      `Synthetic test-user registration failed with HTTP ${registration.status}.`,
    );
  }

  const profile = await registration.json();
  assert.equal(typeof profile?.id, "string");
  return {
    id: profile.id,
    username,
    displayName: profile.profile?.display_name || `Step 06 ${label.toUpperCase()} ${runId}`,
  };
}

async function loginUser(account) {
  const login = await fetch(`${apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: account.username, password }),
  });
  if (!login.ok) {
    throw new Error(`Synthetic test-user login failed with HTTP ${login.status}.`);
  }
  const payload = await login.json();
  ensureMatrixSession(payload.matrix, expectedMatrixUserId(account.id));
  return { ...account, matrix: payload.matrix };
}

async function registerAndLogin(label) {
  return loginUser(await registerUser(label));
}

function matrixClient(session) {
  return createClient({
    baseUrl: matrixUrl,
    accessToken: session.access_token,
    userId: session.user_id,
    deviceId: session.device_id,
    store: new MemoryStore(),
  });
}

async function waitForBrowserMatrixStatus(text, timeout = 30_000) {
  await page.getByRole("status").filter({ hasText: text }).first().waitFor({
    state: "visible",
    timeout,
  });
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
  const loginResponse = await loginResponsePromise;
  assert.equal(loginResponse.status(), 200);
  const payload = await loginResponse.json();
  ensureMatrixSession(payload.matrix, expectedMatrixUserId(account.id));
  await page.waitForURL("**/chat", { timeout: 20_000 });
  await waitForBrowserMatrixStatus("Connected to Matrix");
  return payload.matrix;
}

async function signOutThroughUi() {
  if (!page) return false;
  try {
    browserOfflineForReconnect = false;
    await page.context().setOffline(false);
    await page.getByRole("button", { name: "Sign out" }).click({ timeout: 3_000 });
    await page.getByLabel("Email or username").waitFor({
      state: "visible",
      timeout: 8_000,
    });
    return true;
  } catch {
    // The browser may not have completed login if an earlier assertion failed.
    return false;
  }
}

async function makeRoom(client, name, invite = []) {
  const response = await client.createRoom({
    visibility: Visibility.Private,
    preset: Preset.TrustedPrivateChat,
    is_direct: invite.length > 0,
    invite,
    name,
  });
  return response.room_id;
}

try {
  const accountA = await registerUser("a");
  const accountB = await registerAndLogin("b");
  clientB = matrixClient(accountB.matrix);

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
  });
  page = await context.newPage();
  page.on("pageerror", (error) => {
    if (
      browserOfflineForReconnect &&
      /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|failed to fetch|networkerror/i.test(
        error.message,
      )
    ) {
      expectedOfflinePageErrors += 1;
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
    if (response.status() >= 400) {
      browserHttpErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (
      browserOfflineForReconnect &&
      /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_FAILED|failed to fetch|networkerror/i.test(
        text,
      )
    ) {
      expectedOfflineNetworkErrors += 1;
      return;
    }
    browserConsoleErrors.push(text);
  });

  const matrixSessionA = await signInThroughUi(accountA);
  assert.notEqual(matrixSessionA.user_id, accountB.matrix.user_id);
  clientA = matrixClient(matrixSessionA);
  const [whoamiA, whoamiB] = await Promise.all([
    clientA.whoami(),
    clientB.whoami(),
  ]);
  assert.equal(whoamiA.user_id, matrixSessionA.user_id);
  assert.equal(whoamiB.user_id, accountB.matrix.user_id);
  assert.equal(new URL(page.url()).pathname, "/chat");
  console.log("PASS FastAPI login and SDK whoami identity verification");
  console.log("PASS initial Matrix synchronization reached PREPARED");

  const roomName = `Step 06 shared ${runId}`;
  const roomId = await makeRoom(clientA, roomName, [accountB.matrix.user_id]);
  const roomRow = page.locator(".conversation-row").filter({ hasText: roomName });
  await roomRow.waitFor({ state: "visible", timeout: 30_000 });
  await roomRow.click();
  await clientB.joinRoom(roomId);
  assert.equal(
    await page.getByLabel("Write a message").isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Send message" }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Attach a file" }).isDisabled(),
    true,
  );
  console.log("PASS live Matrix composer and upload controls remain disabled");

  const messageText = `Live Matrix event ${runId}`;
  const sent = await clientB.sendTextMessage(roomId, messageText);
  const eventSelector = `.message-row[data-event-id="${sent.event_id}"]`;
  const receivedMessage = page.locator(eventSelector);
  await receivedMessage.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await receivedMessage.getAttribute("data-room-id"), roomId);
  assert.equal(
    await receivedMessage.getAttribute("data-event-type"),
    "m.room.message",
  );
  assert.equal(
    await receivedMessage.getAttribute("data-sender-id"),
    accountB.matrix.user_id,
  );
  assert.equal(await receivedMessage.count(), 1);
  assert.equal(
    await receivedMessage.getByText(messageText, { exact: true }).count(),
    1,
  );
  console.log(
    `PASS live event room=${roomId} event=${sent.event_id} sender=${accountB.matrix.user_id} type=m.room.message`,
  );
  console.log("PASS event reached the running React UI once without a refresh");

  browserOfflineForReconnect = true;
  await page.context().setOffline(true);
  await clientB.sendTextMessage(roomId, `Offline trigger ${runId}`);
  await waitForBrowserMatrixStatus("Reconnecting to Matrix", 25_000);

  const missedText = `Recovered Matrix event ${runId}`;
  const missed = await clientB.sendTextMessage(roomId, missedText);
  await page.context().setOffline(false);
  browserOfflineForReconnect = false;
  const recoveredMessage = page.locator(
    `.message-row[data-event-id="${missed.event_id}"]`,
  );
  await recoveredMessage.waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(await recoveredMessage.getAttribute("data-room-id"), roomId);
  assert.equal(
    await recoveredMessage.getAttribute("data-sender-id"),
    accountB.matrix.user_id,
  );
  await waitForBrowserMatrixStatus("Connected to Matrix", 30_000);
  console.log("PASS browser-only network interruption recovered and caught up");

  const privateRoomName = `Step 06 private A ${runId}`;
  await makeRoom(clientA, privateRoomName);
  await page
    .locator(".conversation-row")
    .filter({ hasText: privateRoomName })
    .waitFor({ state: "visible", timeout: 30_000 });

  accountAWasLoggedOut = await signOutThroughUi();
  assert.equal(accountAWasLoggedOut, true, "User A should log out successfully");
  await signInThroughUi(accountB);
  assert.equal(
    await page
      .locator(".conversation-row")
      .filter({ hasText: privateRoomName })
      .count(),
    0,
  );
  assert.ok(
    await page.getByText(accountB.displayName, { exact: true }).count(),
  );
  console.log("PASS logout cleanup and account switching kept private rooms isolated");
  assert.equal(
    await signOutThroughUi(),
    true,
    "User B should log out successfully",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.ok(
    dimensions.document <= dimensions.viewport,
    `Mobile layout overflows horizontally: ${dimensions.document}px > ${dimensions.viewport}px`,
  );
  console.log("PASS mobile chat layout has no horizontal overflow");

  await page.goto(`${webUrl}/register`);
  await page.getByRole("heading", { name: "Create your account" }).waitFor({
    state: "visible",
  });
  await page.getByRole("link", { name: /log in/i }).click();
  await page.getByRole("heading", { name: "Welcome back" }).waitFor({
    state: "visible",
  });
  console.log("PASS registration route and navigation back to login");

  const expectedRtc404Message =
    "Failed to load resource: the server responded with a status of 404 (Not Found)";
  const rtcConsoleErrors = browserConsoleErrors.filter(
    (message) => message === expectedRtc404Message,
  );
  const unexpectedConsoleErrors = browserConsoleErrors.filter(
    (message) => message !== expectedRtc404Message,
  );
  if (
    browserErrors.length ||
    unexpectedConsoleErrors.length ||
    browserHttpErrors.length
  ) {
    console.log(`Browser uncaught errors: ${JSON.stringify(browserErrors)}`);
    console.log(
      `Unexpected browser console errors: ${JSON.stringify(unexpectedConsoleErrors)}`,
    );
    console.log(`Browser HTTP error responses: ${JSON.stringify(browserHttpErrors)}`);
  }
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(unexpectedConsoleErrors, []);
  assert.deepEqual(browserHttpErrors, []);
  assert.equal(rtcConsoleErrors.length, unsupportedRtcTransportResponses);
  console.log("PASS browser JavaScript exceptions and unexpected console errors: 0");
  console.log(
    `PASS SDK's unsupported optional RTC probe produced ${unsupportedRtcTransportResponses} expected 404 response(s)`,
  );
  console.log(
    `PASS intentional offline interruption produced ${expectedOfflineNetworkErrors} browser network error(s)`,
  );
  console.log(
    `PASS intentional offline interruption produced ${expectedOfflinePageErrors} recoverable SDK page error(s)`,
  );
} finally {
  if (await signOutThroughUi()) accountAWasLoggedOut = true;
  if (page) await page.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (clientA) {
    clientA.stopClient();
    if (!accountAWasLoggedOut) await clientA.logout().catch(() => undefined);
  }
  if (clientB) {
    clientB.stopClient();
    await clientB.logout().catch(() => undefined);
  }
}
