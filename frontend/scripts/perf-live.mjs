// Live two-account performance benchmark against the local dev stack.
//
//   LUMACHAT_TEST_API_URL=http://localhost:8000/api/v1 PERF_LABEL=before node scripts/perf-live.mjs
//
// Account A (sender) talks to Synapse directly over the client API so send -> ack latency and
// 429 rate limiting are measured exactly. Account B is a Node SDK client (captures origin_server_ts
// and sync arrival) AND a headless Chromium session running the real UI, where a MutationObserver
// timestamps each message's DOM insertion. All clocks are the same host's Date.now(), so
// cross-process latencies are comparable; no performance.now() is compared across processes.
// Creates disposable accounts and one room; deletes nothing. Never logs tokens or bodies.
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, MemoryStore, RoomEvent } from "matrix-js-sdk";
import { chromium } from "playwright-core";

const apiBaseUrl = (process.env.LUMACHAT_TEST_API_URL || "http://localhost:8000/api/v1").replace(/\/+$/, "");
const webUrl = (process.env.LUMACHAT_WEB_URL || "http://localhost:5173").replace(/\/+$/, "");
const matrixUrl = (process.env.LUMACHAT_MATRIX_HOMESERVER_URL || "http://localhost:8008").replace(/\/+$/, "");
const chromiumPath = process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium-browser";
const label = process.env.PERF_LABEL || "run";
const SEED = Number(process.env.PERF_SEED || 30);
const SCENARIOS = [
  { name: "10_sequential", count: 10, sequential: true },
  { name: "30_rapid", count: 30, sequential: false },
  { name: "50_rapid", count: 50, sequential: false },
];
const COMPOSER_COUNT = Number(process.env.PERF_COMPOSER || 20);
const runId = randomUUID().replaceAll("-", "").slice(0, 10);
const password = `Perf-${randomUUID()}!`;
const reportsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "benchmark", "reports");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : null });

async function api(path, body) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`);
  return response.json();
}

async function registerAndLogin(tag) {
  const username = `perf_${tag}_${runId}`;
  const profile = await api("/auth/register", {
    email: `${username}@example.com`, username, password, display_name: `Perf ${tag.toUpperCase()} ${runId}`,
  });
  const login = await api("/auth/login", { login: username, password });
  if (!login.matrix?.access_token) throw new Error("login response lacks a Matrix session");
  return { id: profile.id, username, matrix: login.matrix };
}

const silentLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return silentLogger; } };

function sdkClient(session) {
  return createClient({
    baseUrl: matrixUrl, accessToken: session.access_token, userId: session.user_id,
    deviceId: session.device_id, store: new MemoryStore(), timelineSupport: true, logger: silentLogger,
  });
}

/** Sends one text event with exact timing; retries the same txn on 429 after retry_after_ms. */
async function sendText(session, roomId, body) {
  const txnId = `perf-${runId}-${randomUUID()}`;
  const url = `${matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
  const started = Date.now();
  let rateLimited = 0;
  for (;;) {
    const response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "m.text", body }),
    });
    if (response.status === 429) {
      rateLimited += 1;
      const payload = await response.json().catch(() => ({}));
      await sleep(Math.min(5000, payload.retry_after_ms ?? 500));
      continue;
    }
    if (!response.ok) throw new Error(`send failed with HTTP ${response.status}`);
    const { event_id: eventId } = await response.json();
    return { eventId, body, sentAt: started, ackAt: Date.now(), rateLimited };
  }
}

const OBSERVER = `(() => {
  if (window.__perf) return;
  const perf = { dom: [], longtasks: [], echo: [] };
  window.__perf = perf;
  const record = (article) => {
    perf.dom.push({ id: article.dataset.eventId, body: article.querySelector('.message-text')?.textContent ?? '', t: Date.now(), p: performance.now() });
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('article[data-event-id]')) record(node);
        else node.querySelectorAll?.('article[data-event-id]').forEach(record);
      }
      if (mutation.type === 'attributes' && mutation.target.matches?.('article[data-event-id]')) {
        perf.dom.push({ id: mutation.target.dataset.eventId, body: mutation.target.querySelector('.message-text')?.textContent ?? '', t: Date.now(), p: performance.now(), retargeted: true });
      }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-event-id'] });
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.longtasks.push({ d: Math.round(e.duration), t: Date.now() }); }).observe({ entryTypes: ['longtask'] });
  } catch {}
})();`;

async function main() {
  console.log(`[perf-live] label=${label} api=${apiBaseUrl} web=${webUrl}`);
  const sender = await registerAndLogin("a");
  const recipient = await registerAndLogin("b");

  const clientA = sdkClient(sender.matrix);
  const { room_id: roomId } = await clientA.createRoom({
    visibility: "private", preset: "private_chat", is_direct: false, name: `Perf ${runId}`,
    invite: [recipient.matrix.user_id],
    initial_state: [{ type: "org.recruitable.chat.group", state_key: "", content: { version: 1 } }],
  });
  const clientB = sdkClient(recipient.matrix);
  const arrivals = new Map(); // eventId -> { ots, t }
  clientB.on(RoomEvent.Timeline, (event, room, toStart) => {
    if (toStart || room?.roomId !== roomId || event.getType() !== "m.room.message") return;
    arrivals.set(event.getId(), { ots: event.getTs(), t: Date.now() });
  });
  await clientB.startClient({ initialSyncLimit: 10 });
  await clientB.joinRoom(roomId);
  console.log("[perf-live] room created and joined; seeding history");
  for (let i = 0; i < SEED; i++) await sendText(sender.matrix, roomId, `seed ${i}`);

  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--enable-precise-memory-info"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const ackResponses = [];
  page.on("response", (response) => {
    if (/\/send\/m\.room\.message\//.test(response.url())) ackResponses.push({ t: Date.now(), status: response.status() });
  });
  await page.goto(`${webUrl}/login`);
  await page.getByLabel("Email or username").fill(recipient.username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log In" }).click();
  await page.waitForURL("**/chat", { timeout: 30_000 });
  await page.goto(`${webUrl}/chat/${encodeURIComponent(roomId)}`);
  const composer = page.locator('textarea[aria-label="Write a message"]');
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("article[data-event-id]").first().waitFor({ timeout: 30_000 });
  await page.evaluate(OBSERVER);
  const heapStart = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  console.log("[perf-live] recipient UI ready");

  const report = { label, at: new Date().toISOString(), seed: SEED, scenarios: {}, notes: [] };
  const domSeen = async () => page.evaluate(() => window.__perf.dom);
  const longtasksSince = async (t) => (await page.evaluate(() => window.__perf.longtasks)).filter((x) => x.t >= t);

  for (const scenario of SCENARIOS) {
    const startedAt = Date.now();
    const bodies = Array.from({ length: scenario.count }, (_, i) => `${scenario.name} ${i}`);
    let results;
    if (scenario.sequential) {
      results = [];
      for (const body of bodies) results.push(await sendText(sender.matrix, roomId, body));
    } else {
      results = await Promise.all(bodies.map((body) => sendText(sender.matrix, roomId, body)));
    }
    const ids = new Set(results.map((r) => r.eventId));
    const deadline = Date.now() + 90_000;
    let dom = [];
    while (Date.now() < deadline) {
      dom = await domSeen();
      const rendered = new Set(dom.filter((d) => ids.has(d.id)).map((d) => d.id));
      if (rendered.size === ids.size && [...ids].every((id) => arrivals.has(id))) break;
      await sleep(100);
    }
    const firstDom = new Map();
    for (const d of dom) if (ids.has(d.id) && !firstDom.has(d.id)) firstDom.set(d.id, d.t);
    const ack = results.map((r) => r.ackAt - r.sentAt);
    const serverToNode = results.map((r) => arrivals.get(r.eventId)).filter(Boolean).map((a) => a.t - a.ots);
    const serverToDom = results.filter((r) => firstDom.has(r.eventId) && arrivals.has(r.eventId)).map((r) => firstDom.get(r.eventId) - arrivals.get(r.eventId).ots);
    const sendToDom = results.filter((r) => firstDom.has(r.eventId)).map((r) => firstDom.get(r.eventId) - r.sentAt);
    const domOrder = await page.evaluate((prefix) =>
      [...document.querySelectorAll("article[data-event-id] .message-text")].map((e) => e.textContent).filter((t) => t.startsWith(prefix)), `${scenario.name} `);
    // Parallel raw sends may be accepted out of submission order (429 retries); the UI must match server order.
    const serverOrder = results
      .filter((r) => arrivals.has(r.eventId))
      .sort((a, b) => arrivals.get(a.eventId).ots - arrivals.get(b.eventId).ots)
      .map((r) => r.body);
    const counts = await page.evaluate(() => {
      const map = {};
      for (const a of document.querySelectorAll("article[data-event-id]")) map[a.dataset.eventId] = (map[a.dataset.eventId] ?? 0) + 1;
      return Object.values(map).filter((n) => n > 1).length;
    });
    const longtasks = await longtasksSince(startedAt);
    report.scenarios[scenario.name] = {
      sent: results.length,
      rendered: firstDom.size,
      received_by_node_client: serverToNode.length,
      rate_limited_429_retries: results.reduce((a, r) => a + r.rateLimited, 0),
      wall_ms: Date.now() - startedAt,
      send_to_ack_ms: stats(ack),
      server_ts_to_node_sync_ms: stats(serverToNode),
      server_ts_to_recipient_dom_ms: stats(serverToDom),
      send_to_recipient_dom_ms: stats(sendToDom),
      ordered_in_dom: JSON.stringify(domOrder) === JSON.stringify(serverOrder),
      submission_order_kept_by_server: JSON.stringify(serverOrder) === JSON.stringify(bodies),
      duplicate_event_ids_in_dom: counts,
      longtasks: { count: longtasks.length, max_ms: longtasks.length ? Math.max(...longtasks.map((l) => l.d)) : 0, total_ms: longtasks.reduce((a, l) => a + l.d, 0) },
    };
    console.log(`[perf-live] ${scenario.name}: ${JSON.stringify(report.scenarios[scenario.name])}`);
  }

  // Composer: recipient types COMPOSER_COUNT messages back-to-back; measures Enter -> local echo in-page.
  const composerStart = Date.now();
  const echo = await page.evaluate(async ({ count, runId }) => {
    const textarea = document.querySelector('textarea[aria-label="Write a message"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    const results = [];
    const bodies = [];
    for (let i = 0; i < count; i++) {
      const body = `composer ${runId} ${i}`;
      bodies.push(body);
      textarea.focus();
      setter.call(textarea, body);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      const pressed = performance.now();
      const disabledBefore = textarea.disabled;
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
      results.push({ body, pressed, disabledAfter: textarea.disabled, disabledBefore, valueAfter: textarea.value });
    }
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      const seen = new Set(window.__perf.dom.filter((d) => d.body && bodies.includes(d.body)).map((d) => d.body));
      if (seen.size === bodies.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 3000)); // let acks land so remounts can be counted
    return results.map((r) => {
      const entries = window.__perf.dom.filter((d) => d.body === r.body);
      const first = entries[0];
      // A second *inserted* article for the same body means the bubble was unmounted and remounted
      // when the local echo id was replaced by the server event id.
      const remounted = entries.filter((d) => !d.retargeted).length > 1;
      return { echo_ms: first ? first.p - r.pressed : null, disabledAfter: r.disabledAfter, cleared: r.valueAfter === "", remounted };
    });
  }, { count: COMPOSER_COUNT, runId });
  await sleep(1500);
  const composerAcks = ackResponses.filter((a) => a.t >= composerStart);
  report.composer = {
    messages: COMPOSER_COUNT,
    enter_to_local_echo_ms: stats(echo.map((e) => e.echo_ms).filter((x) => x !== null)),
    echoed: echo.filter((e) => e.echo_ms !== null).length,
    composer_disabled_after_enter: echo.filter((e) => e.disabledAfter).length,
    cleared_immediately: echo.filter((e) => e.cleared).length,
    remounted_on_ack: echo.filter((e) => e.remounted).length,
    acks_observed: composerAcks.length,
    ack_status_429: composerAcks.filter((a) => a.status === 429).length,
    longtasks: (await longtasksSince(composerStart)).length,
  };
  console.log(`[perf-live] composer: ${JSON.stringify(report.composer)}`);

  // Scroll: programmatic scroll through the loaded list, counting animation frames.
  report.scroll = await page.evaluate(async () => {
    const scroller = document.querySelector(".messages-scroll");
    const start = performance.now();
    const before = window.__perf.longtasks.length;
    let frames = 0;
    let longest = 0;
    let last = start;
    await new Promise((resolve) => {
      const step = () => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
        frames += 1;
        const progress = (now - start) / 2000;
        scroller.scrollTop = scroller.scrollHeight * (progress < 1 ? 1 - progress : 0);
        if (now - start < 2000) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    const elapsed = performance.now() - start;
    return { frames, fps: Math.round((frames / elapsed) * 1000), longest_frame_ms: Math.round(longest), longtasks: window.__perf.longtasks.length - before, articles: document.querySelectorAll("article[data-event-id]").length };
  });
  const heapEnd = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  report.heap_mb = { start: heapStart && Math.round(heapStart / 1048576), end: heapEnd && Math.round(heapEnd / 1048576) };
  report.notes.push("Headless Chromium on the dev server; frame rate and long tasks are indicative only.");
  report.notes.push(`Synapse rc_message applies (burst 25 then 2/s); 429 retries are counted per scenario.`);
  console.log(`[perf-live] scroll: ${JSON.stringify(report.scroll)} heap: ${JSON.stringify(report.heap_mb)}`);

  mkdirSync(reportsDir, { recursive: true });
  const file = join(reportsDir, `live.${label}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`[perf-live] report -> ${file}`);

  await browser.close();
  clientB.stopClient();
  clientA.stopClient();
}

main().catch((error) => {
  console.error(`[perf-live] failed: ${error?.message ?? error}`);
  process.exit(1);
});
