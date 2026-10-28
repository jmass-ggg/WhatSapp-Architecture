import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const apiUrl = (process.env.LUMACHAT_TEST_API_URL || "http://localhost:8000/api/v1").replace(/\/+$/, "");
const webUrl = (process.env.LUMACHAT_WEB_URL || "http://localhost:5173").replace(/\/+$/, "");
const matrixUrl = (process.env.LUMACHAT_MATRIX_HOMESERVER_URL || "http://localhost:8008").replace(/\/+$/, "");
const cachePath = "/tmp/lumachat-step08-isolated-accounts.json";
let cached = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : null;
const runId = cached?.runId || randomUUID().slice(0, 8);
const password = cached?.password || `Step08-${randomUUID()}!`;
let browser;
let contextA;
let contextB;
const statePath = (label) => `/tmp/lumachat-step08-${runId}-${label}-browser.json`;

function saveCache() {
  writeFileSync(cachePath, JSON.stringify(cached), { mode: 0o600 });
}

function recoveryKeyPath(label) {
  return `/tmp/lumachat-step08-${runId}-${label}-recovery.txt`;
}

async function refreshCachedAccessToken(account) {
  const label = account.username === cached?.alice?.username
    ? "alice"
    : account.username === cached?.bob?.username
      ? "bob"
      : null;
  if (!label) return null;

  const browserStatePath = statePath(label);
  if (!existsSync(browserStatePath)) return null;
  const state = JSON.parse(readFileSync(browserStatePath, "utf8"));
  const refreshCookie = state.cookies?.find(
    (cookie) => cookie.name === "app_refresh",
  );
  if (!refreshCookie?.value) return null;

  const response = await fetch(`${apiUrl}/auth/refresh`, {
    method: "POST",
    headers: { Cookie: `app_refresh=${refreshCookie.value}` },
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const replacementCookie = response.headers
    .get("set-cookie")
    ?.match(/^app_refresh=([^;]+)/)?.[1];
  if (
    typeof payload.access_token !== "string" ||
    !replacementCookie
  ) return null;

  refreshCookie.value = replacementCookie;
  const maxAge = Number(
    response.headers.get("set-cookie")?.match(/max-age=(\d+)/i)?.[1],
  );
  if (Number.isFinite(maxAge) && maxAge > 0) {
    refreshCookie.expires = Math.floor(Date.now() / 1000) + maxAge;
  }
  fsWriteBrowserState(browserStatePath, state);
  cached.sessions[account.username].access_token = payload.access_token;
  saveCache();
  return payload.access_token;
}

function fsWriteBrowserState(path, state) {
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function reusableSession(account) {
  const payload = cached?.sessions?.[account.username];
  if (!payload?.access_token || !payload?.matrix?.access_token) return null;
  const matrix = await fetch(`${matrixUrl}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${payload.matrix.access_token}` },
  });
  if (!matrix.ok) return null;

  let app = await fetch(`${apiUrl}/users/me`, {
    headers: { Authorization: `Bearer ${payload.access_token}` },
  });
  if (!app.ok) {
    const refreshedToken = await refreshCachedAccessToken(account);
    if (!refreshedToken) return null;
    payload.access_token = refreshedToken;
    app = await fetch(`${apiUrl}/users/me`, {
      headers: { Authorization: `Bearer ${payload.access_token}` },
    });
  }
  return app.ok ? payload : null;
}

async function register(label) {
  const username = `step08_${label}_${runId}`;
  const response = await fetch(`${apiUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${username}@example.com`, username, password,
      display_name: `Step 08 ${label} ${runId}`,
    }),
  });
  assert.equal(response.status, 201, `Register ${label}: HTTP ${response.status}`);
  return { username, profile: await response.json() };
}

async function login(page, account, reused) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${webUrl}/login`);
  if (reused) {
    await page.route("**/auth/login", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(reused),
    }));
  }
  await page.getByLabel("Email or username").fill(account.username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/auth/login") &&
    response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Log In" }).click();
  const response = await responsePromise;
  if (response.status() !== 200) {
    throw new Error(`Login ${account.username}: HTTP ${response.status()} ${await response.text()}`);
  }
  const payload = await response.json();
  if (!reused) {
    cached.sessions = { ...(cached.sessions || {}), [account.username]: payload };
    saveCache();
  }
  await page.waitForURL("**/chat", { timeout: 20_000 });
  try {
    await page.getByRole("status").filter({ hasText: "Connected to Matrix" }).first().waitFor({ timeout: 30_000 });
  } catch (cause) {
    throw new Error(`Matrix did not connect for ${account.username}. Page: ${(await page.locator("body").innerText()).slice(0, 1800)}. Errors: ${pageErrors.join(" | ")}`, { cause });
  }
  return payload;
}

async function wireEvent(session, roomId, eventId, forbiddenText) {
  const response = await fetch(
    `${matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${session.access_token}` } },
  );
  assert.equal(response.status, 200);
  const event = await response.json();
  assert.equal(event.type, "m.room.encrypted");
  assert.equal(JSON.stringify(event).includes(forbiddenText), false);
  return event;
}

function assertDisplayedText(actual, expected, label) {
  assert.ok(
    actual === expected,
    `${label} content mismatch; expected and actual content redacted`,
  );
}

async function assertTimestampMatchesEvent(message, event, label) {
  const dateTime = await message.locator("time").getAttribute("datetime");
  const renderedTimestamp = Date.parse(dateTime ?? "");
  assert.ok(
    Number.isFinite(renderedTimestamp) &&
      renderedTimestamp === event.origin_server_ts,
    `${label} timestamp must match the server event timestamp`,
  );
}

async function sendAndGetEventId(page, text) {
  const sendRequests = [];
  const sendResponses = [];
  const failedRequests = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/send/")) {
      sendRequests.push(`${request.method()} ${url.pathname}`);
    }
  };
  const onResponse = (response) => {
    if (response.url().includes("/send/")) sendResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
  };
  const onRequestFailed = (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/send/")) {
      failedRequests.push(
        `${request.method()} ${url.pathname}: ${request.failure()?.errorText ?? "unknown network error"}`,
      );
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "PUT" &&
    new URL(response.url()).pathname.includes("/send/m.room.encrypted/"),
  );
  await page.getByLabel("Write a message").fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  let response;
  try {
    response = await responsePromise;
  } catch (cause) {
    const composerErrors = (await page.locator(".composer-error").allInnerTexts())
      .map((error) => error.split(text).join("[redacted]"));
    throw new Error(
      `Encrypted send response missing. Composer errors: ${composerErrors.join(" | ") || "none"}. ` +
      `Send requests: ${sendRequests.join(" | ") || "none"}. ` +
      `Send responses: ${sendResponses.join(" | ") || "none"}. ` +
      `Failed requests: ${failedRequests.join(" | ") || "none"}`,
      { cause },
    );
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }
  assert.equal(response.status(), 200, "Encrypted Matrix send response");
  const payload = await response.json();
  assert.ok(payload.event_id);
  return payload.event_id;
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function prepareCrossSigning(page, label) {
  const securityDialog = page.getByRole("dialog");
  if (!(await securityDialog.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Encryption and devices" }).click();
  }
  const dialog = page.getByRole("dialog");
  const identitySection = dialog
    .locator(".security-section")
    .filter({ hasText: "Identity and cross-signing" });
  const identityStatus = identitySection.locator("p").first();
  const readyText = "Cross-signing is ready on this device.";

  await waitFor(async () => {
    const status = await identityStatus.innerText().catch(() => "");
    return status === readyText ||
      status === "This device identity has not been cross-signed.";
  }, `${label} cross-signing status`);

  if ((await identityStatus.innerText()) !== readyText) {
    const restoreInput = dialog.locator("#matrix-recovery-key");
    const keyPath = recoveryKeyPath(label);
    assert.ok(
      existsSync(keyPath) && await restoreInput.isVisible(),
      `${label} cross-signing is not ready and no existing recovery key is available; refusing to create a replacement identity`,
    );
    await restoreInput.fill(readFileSync(keyPath, "utf8").trim());
    await dialog.getByRole("button", { name: "Restore encryption" }).click();
    await dialog.getByText(/^Recovery finished:/).waitFor({
      state: "visible",
      timeout: 60_000,
    });

    await dialog.getByText(readyText, { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
  }

  assert.equal(
    await dialog.getByRole("button", {
      name: "Generate recovery key",
      exact: true,
    }).count(),
    0,
    `${label} must not receive a recovery-key generation button`,
  );
  await dialog
    .getByRole("button", { name: "Close security settings" })
    .click();
  console.log(`PASS ${label} cross-signing readiness`);
}

async function verifyPeerDevices(pageA, pageB, sessionA, sessionB) {
  await Promise.all([
    pageA.getByRole("button", { name: "Encryption and devices" }).click(),
    pageB.getByRole("button", { name: "Encryption and devices" }).click(),
  ]);
  const dialogA = pageA.getByRole("dialog", {
    name: "Encryption and devices",
  });
  const dialogB = pageB.getByRole("dialog", {
    name: "Encryption and devices",
  });
  const bobDevice = dialogA
    .locator(".security-device")
    .filter({ hasText: sessionB.device_id });
  const aliceDevice = dialogB
    .locator(".security-device")
    .filter({ hasText: sessionA.device_id });

  await waitFor(async () =>
    (await bobDevice.count()) > 0 && (await aliceDevice.count()) > 0,
  "both Matrix peer devices to appear in security settings");
  const trustLabel = async (device) =>
    device.locator("small").innerText().catch(() => "");
  let aliceTrust = await trustLabel(bobDevice);
  let bobTrust = await trustLabel(aliceDevice);

  if (
    !aliceTrust.startsWith("Verified ·") ||
    !bobTrust.startsWith("Verified ·")
  ) {
    const initiatorPage = aliceTrust.startsWith("Verified ·")
      ? pageB
      : pageA;
    const responderPage = initiatorPage === pageA ? pageB : pageA;
    const initiatorDialog = initiatorPage === pageA ? dialogA : dialogB;
    const responderDialog = responderPage === pageA ? dialogA : dialogB;
    const targetDevice = initiatorPage === pageA ? bobDevice : aliceDevice;
    await targetDevice.getByRole("button", { name: "Verify" }).click();
    await responderDialog
      .getByRole("button", { name: "Accept verification" })
      .waitFor({ state: "visible", timeout: 20_000 });
    await responderDialog
      .getByRole("button", { name: "Accept verification" })
      .click();
    await initiatorDialog
      .getByRole("button", { name: "Start emoji verification" })
      .waitFor({ state: "visible", timeout: 20_000 });
    await initiatorDialog
      .getByRole("button", { name: "Start emoji verification" })
      .click();

    const sasA = dialogA.locator(".verification-emojis span");
    const sasB = dialogB.locator(".verification-emojis span");
    await waitFor(async () =>
      (await sasA.count()) > 0 && (await sasB.count()) > 0,
    "both browsers to display SAS emoji");
    const emojiA = await sasA.allTextContents();
    const emojiB = await sasB.allTextContents();
    assert.ok(emojiA.length > 0, "SAS comparison must contain emojis");
    assert.deepEqual(emojiA, emojiB, "Both browsers must display matching SAS");
    await Promise.all([
      dialogA.getByRole("button", { name: "The emojis match" }).click(),
      dialogB.getByRole("button", { name: "The emojis match" }).click(),
    ]);
    await waitFor(async () => {
      aliceTrust = await trustLabel(bobDevice);
      bobTrust = await trustLabel(aliceDevice);
      return aliceTrust.startsWith("Verified ·") &&
        bobTrust.startsWith("Verified ·");
    }, "both browsers to trust the verified peer device");
  }

  await Promise.all([
    dialogA.getByRole("button", { name: "Close security settings" }).click(),
    dialogB.getByRole("button", { name: "Close security settings" }).click(),
  ]);
  console.log("PASS Alice and Bob completed interactive SAS verification");
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let alice = cached?.alice;
  let bob = cached?.bob;
  if (!alice || !bob) {
    [alice, bob] = await Promise.all([register("alice"), register("bob")]);
    cached = { runId, password, alice, bob };
    saveCache();
  }
  // Refresh before creating the context so its final storageState cannot overwrite the rotated cookie.
  const reusableAlice = await reusableSession(alice);
  contextA = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    ...(existsSync(statePath("alice")) ? { storageState: statePath("alice") } : {}),
  });
  const pageA = await contextA.newPage();
  const loginA = await login(pageA, alice, reusableAlice);
  const sessionA = loginA.matrix;
  const directoryResponse = await fetch(
    `${apiUrl}/users/search?q=${encodeURIComponent(bob.username)}&limit=20`,
    { headers: { Authorization: `Bearer ${loginA.access_token}` } },
  );
  assert.equal(directoryResponse.status, 200, "Alice directory request");
  const directoryPage = await directoryResponse.json();
  assert.ok(directoryPage.items.some((user) => user.id === bob.profile.id), "Bob must be visible in global username search");
  assert.ok(!directoryPage.items.some((user) => user.id === alice.profile.id), "Alice must not see herself in search");
  console.log("PASS authenticated global username lookup and self-exclusion");
  const aliceDisplayName = alice.profile.profile?.display_name ?? alice.username;
  const bobDisplayName = bob.profile.profile?.display_name ?? bob.username;
  // Synapse's default rc_login.address refill is 0.003 requests/second.
  const reusableBob = await reusableSession(bob);
  if (!reusableBob) await new Promise((resolve) => setTimeout(resolve, 340_000));
  contextB = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    ...(existsSync(statePath("bob")) ? { storageState: statePath("bob") } : {}),
  });
  const pageB = await contextB.newPage();
  const bobPageErrors = [];
  pageB.on("pageerror", (error) => bobPageErrors.push(error.message));
  const loginB = await login(pageB, bob, reusableBob);
  const sessionB = loginB.matrix;
  assert.notEqual(sessionA.user_id, sessionB.user_id);
  await prepareCrossSigning(pageA, "alice");
  await prepareCrossSigning(pageB, "bob");

  await pageA.getByRole("button", { name: "Start a new chat" }).click();
  await pageA.getByPlaceholder("Search username").fill(bob.username);
  const dialog = pageA.getByRole("dialog", { name: "Start a conversation" });
  try {
    await dialog.getByRole("button", { name: "Add Contact" }).click({ timeout: 10_000 });
  } catch (cause) {
    throw new Error(`Bob was unavailable in username search: ${await dialog.innerText()}`, { cause });
  }
  await dialog.getByRole("button", { name: "Request Sent" }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const outgoingResponse = await fetch(`${apiUrl}/connections/requests/outgoing`, {
    headers: { Authorization: `Bearer ${loginA.access_token}` },
  });
  assert.equal(outgoingResponse.status, 200);
  const outgoingRequests = await outgoingResponse.json();
  const request = outgoingRequests.find((item) => item.other_user.id === bob.profile.id);
  assert.equal(request?.status, "pending");
  const requestCard = pageB.locator(".connection-request-card").filter({
    hasText: alice.username,
  });
  await requestCard.getByRole("button", { name: "Accept" }).waitFor({
    state: "visible",
    timeout: 45_000,
  });
  await requestCard.getByRole("button", { name: "Accept" }).click();
  await waitFor(async () => {
    const [aliceResponse, bobResponse] = await Promise.all([
      fetch(`${apiUrl}/connections`, {
        headers: { Authorization: `Bearer ${loginA.access_token}` },
      }),
      fetch(`${apiUrl}/connections`, {
        headers: { Authorization: `Bearer ${loginB.access_token}` },
      }),
    ]);
    if (!aliceResponse.ok || !bobResponse.ok) return false;
    const [aliceConnections, bobConnections] = await Promise.all([
      aliceResponse.json(),
      bobResponse.json(),
    ]);
    return (
      aliceConnections.some((item) => item.other_user.id === bob.profile.id) &&
      bobConnections.some((item) => item.other_user.id === alice.profile.id)
    );
  }, "the accepted connection to appear for both users");
  await dialog.getByRole("button", { name: "Close" }).click().catch(() => undefined);

  let inviteRooms = [];
  await waitFor(async () => {
    const syncResponse = await fetch(
      `${matrixUrl}/_matrix/client/v3/sync?timeout=0`,
      { headers: { Authorization: `Bearer ${sessionB.access_token}` } },
    );
    if (!syncResponse.ok) return false;
    const sync = await syncResponse.json();
    inviteRooms = Object.entries(sync.rooms?.invite || {})
      .filter(([, room]) =>
        JSON.stringify(room).includes(sessionA.user_id),
      )
      .map(([invitedRoomId]) => invitedRoomId);
    return inviteRooms.length > 0;
  }, "the encrypted Matrix room invitation");
  const roomId = inviteRooms[0];
  assert.ok(roomId.startsWith("!"));
  const aliceContact = pageA.locator(".conversation-row").filter({
    hasText: bobDisplayName,
  });
  await aliceContact.waitFor({ state: "visible", timeout: 30_000 });
  await aliceContact.click();
  await waitFor(
    () => new URL(pageA.url()).pathname.startsWith("/chat/"),
    "Alice room route",
  );
  assert.equal(decodeURIComponent(new URL(pageA.url()).pathname.slice(6)), roomId);
  try {
    await pageB.locator(".conversation-row").filter({
      hasText: aliceDisplayName,
    }).waitFor({ timeout: 30_000 });
  } catch (cause) {
    throw new Error(
      `Bob invite did not appear. Route: ${pageB.url()}. ` +
      `Invite rooms in Synapse: ${inviteRooms.join(",")}. ` +
      `Sidebar: ${await pageB.locator(".conversation-sidebar").innerText()}. ` +
      `Page errors: ${bobPageErrors.join(" | ")}`,
      { cause },
    );
  }
  const bobContact = pageB.locator(".conversation-row").filter({
    hasText: aliceDisplayName,
  });
  await waitFor(async () => {
    await bobContact.click();
    await pageB.waitForTimeout(500);
    return decodeURIComponent(new URL(pageB.url()).pathname.slice(6)) === roomId;
  }, "Bob's synced room route");
  const acceptButton = pageB.getByRole("button", { name: "Accept invitation" });
  if (await acceptButton.count()) await acceptButton.click();
  await pageB.getByLabel("Write a message").waitFor({ state: "visible", timeout: 30_000 });
  try {
    await waitFor(() => pageB.getByLabel("Write a message").isEnabled(), "Bob encrypted composer");
  } catch (cause) {
    const composer = pageB.getByLabel("Write a message");
    const placeholder = await composer.getAttribute("placeholder");
    const hint = await pageB.locator(".composer-hint").innerText().catch(() => "");
    await pageB.getByRole("button", { name: "Encryption and devices" }).click();
    const securityDialog = pageB.getByRole("dialog", {
      name: "Encryption and devices",
    });
    const rustCrypto = await securityDialog
      .locator(".security-status-card strong")
      .innerText()
      .catch(() => "unavailable");
    const crossSigning = await securityDialog
      .locator(".security-section")
      .filter({ hasText: "Identity and cross-signing" })
      .locator("p")
      .first()
      .innerText()
      .catch(() => "unavailable");
    throw new Error(
      `Bob composer unavailable: disabled=${await composer.isDisabled()}, ` +
      `placeholder=${placeholder}, hint=${hint}, rustCrypto=${rustCrypto}, ` +
      `crossSigning=${crossSigning}, route=${new URL(pageB.url()).pathname}`,
      { cause },
    );
  }
  await verifyPeerDevices(pageA, pageB, sessionA, sessionB);

  await pageB.goBack();
  await pageB.waitForURL(`${webUrl}/chat`);
  const aliceEventId = await sendAndGetEventId(pageA, "Hello Bob");
  const aliceMessage = pageA.locator(`.message-row[data-event-id="${aliceEventId}"]`);
  await aliceMessage.waitFor({ timeout: 30_000 });
  assertDisplayedText(
    await aliceMessage.locator(".message-text").innerText(),
    "Hello Bob",
    "Alice outgoing bubble",
  );
  const aliceWireEvent = await wireEvent(
    sessionA,
    roomId,
    aliceEventId,
    "Hello Bob",
  );
  await assertTimestampMatchesEvent(aliceMessage, aliceWireEvent, "Alice outgoing bubble");
  const bobRow = pageB.locator(".conversation-row").filter({ hasText: "Hello Bob" });
  await bobRow.waitFor({ timeout: 30_000 });
  const bobUnreadBadge = bobRow.getByLabel(/unread messages/);
  await bobUnreadBadge.waitFor({ timeout: 30_000 });
  assert.equal(
    await bobUnreadBadge.getAttribute("aria-label"),
    "1 unread messages",
  );
  assertDisplayedText(
    await bobRow.locator(".conversation-preview").innerText(),
    "Hello Bob",
    "Bob conversation preview",
  );
  await bobRow.click();
  const bobMessage = pageB.locator(`.message-row[data-event-id="${aliceEventId}"]`);
  await bobMessage.waitFor({ timeout: 30_000 });
  assertDisplayedText(
    await bobMessage.locator(".message-text").innerText(),
    "Hello Bob",
    "Bob decrypted bubble",
  );
  await assertTimestampMatchesEvent(bobMessage, aliceWireEvent, "Bob decrypted bubble");
  assert.equal(await bobMessage.locator("time").count(), 1);
  assert.equal(await bobMessage.count(), 1);
  assert.equal(await bobMessage.getAttribute("data-event-type"), "m.room.encrypted");
  await waitFor(() => bobRow.getByLabel(/unread messages/).count().then((count) => count === 0), "read receipt clearing unread");

  const bobEventId = await sendAndGetEventId(pageB, "Hello Alice");
  const bobReply = pageB.locator(`.message-row[data-event-id="${bobEventId}"]`);
  await bobReply.waitFor({ timeout: 30_000 });
  assertDisplayedText(
    await bobReply.locator(".message-text").innerText(),
    "Hello Alice",
    "Bob outgoing bubble",
  );
  const bobWireEvent = await wireEvent(
    sessionB,
    roomId,
    bobEventId,
    "Hello Alice",
  );
  await assertTimestampMatchesEvent(bobReply, bobWireEvent, "Bob outgoing bubble");
  const aliceReply = pageA.locator(`.message-row[data-event-id="${bobEventId}"]`);
  await aliceReply.waitFor({ timeout: 30_000 });
  assertDisplayedText(
    await aliceReply.locator(".message-text").innerText(),
    "Hello Alice",
    "Alice decrypted reply",
  );
  await assertTimestampMatchesEvent(aliceReply, bobWireEvent, "Alice decrypted reply");
  assert.equal(await aliceReply.locator("time").count(), 1);
  assert.equal(await aliceReply.count(), 1);
  assert.equal(await aliceReply.getAttribute("data-event-type"), "m.room.encrypted");
  const aliceRow = pageA
    .locator(".conversation-row")
    .filter({ hasText: "Hello Alice" });
  await aliceRow.waitFor({ timeout: 30_000 });
  assertDisplayedText(
    await aliceRow.locator(".conversation-preview").innerText(),
    "Hello Alice",
    "Alice conversation preview",
  );

  await pageB.goBack();
  await pageB.waitForURL(`${webUrl}/chat`);
  const rejectMatrixSync = (route) => route.abort("internetdisconnected");
  await pageB.route("**/_matrix/client/v3/sync*", rejectMatrixSync);
  await contextB.setOffline(true);
  try {
    await waitFor(
      () => pageB.locator(".matrix-connection-status.is-reconnecting").count()
        .then((count) => count > 0),
      "Bob Matrix client to enter reconnecting state",
      45_000,
    );
  } catch (cause) {
    const status = pageB.locator(".matrix-connection-status");
    throw new Error(
      `Bob reconnect state was not observed: status=${await status.innerText().catch(() => "unavailable")}, ` +
      `class=${await status.getAttribute("class").catch(() => "unavailable")}, ` +
      `browserOffline=${!(await pageB.evaluate(() => navigator.onLine))}`,
      { cause },
    );
  }
  const recoveredEventId = await sendAndGetEventId(
    pageA,
    "Hello Bob after reconnect",
  );
  const recoveredAliceMessage = pageA.locator(
    `.message-row[data-event-id="${recoveredEventId}"]`,
  );
  await recoveredAliceMessage.waitFor({ timeout: 30_000 });
  const recoveredWireEvent = await wireEvent(
    sessionA,
    roomId,
    recoveredEventId,
    "Hello Bob after reconnect",
  );
  await assertTimestampMatchesEvent(
    recoveredAliceMessage,
    recoveredWireEvent,
    "Alice message sent during Bob's outage",
  );
  await pageB.unroute("**/_matrix/client/v3/sync*", rejectMatrixSync);
  await contextB.setOffline(false);
  await waitFor(
    () => pageB.locator(".matrix-connection-status.is-connected").count()
      .then((count) => count > 0),
    "Bob Matrix client to reconnect",
    30_000,
  );
  const recoveredBobRow = pageB
    .locator(".conversation-row")
    .filter({ hasText: "Hello Bob after reconnect" });
  await recoveredBobRow.waitFor({ timeout: 30_000 });
  const recoveredUnreadBadge = recoveredBobRow.getByLabel(/unread messages/);
  await recoveredUnreadBadge.waitFor({ timeout: 30_000 });
  assert.equal(
    await recoveredUnreadBadge.getAttribute("aria-label"),
    "1 unread messages",
  );
  await recoveredBobRow.click();
  const recoveredBobMessage = pageB.locator(
    `.message-row[data-event-id="${recoveredEventId}"]`,
  );
  await recoveredBobMessage.waitFor({ timeout: 30_000 });
  assertDisplayedText(
    await recoveredBobMessage.locator(".message-text").innerText(),
    "Hello Bob after reconnect",
    "Bob recovered decrypted bubble",
  );
  await assertTimestampMatchesEvent(
    recoveredBobMessage,
    recoveredWireEvent,
    "Bob recovered decrypted bubble",
  );
  assert.equal(await recoveredBobMessage.count(), 1);
  assert.equal(
    await recoveredBobMessage.getAttribute("data-event-type"),
    "m.room.encrypted",
  );
  await waitFor(
    () => recoveredBobRow
      .getByLabel(/unread messages/)
      .count()
      .then((count) => count === 0),
    "read receipt clearing the recovered message's unread count",
  );
  console.log(`PASS two-browser encrypted exchange, room ${roomId}`);
  console.log("PASS unread badge, read receipt, previews, bubbles, timestamps, and event deduplication");
  console.log("PASS Bob reconnects and decrypts a message sent during the outage");
} finally {
  for (const [context, label] of [[contextA, "alice"], [contextB, "bob"]]) {
    if (!context) continue;
    await context.storageState({ path: statePath(label), indexedDB: true });
    chmodSync(statePath(label), 0o600);
  }
  await browser?.close();
}
