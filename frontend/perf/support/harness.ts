import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, EventType, MatrixEvent, MemoryStore, Room, type MatrixClient } from "matrix-js-sdk";

export const OWN_USER_ID = "@self:localhost";
export const PEER_USER_ID = "@peer:localhost";
export const THIRD_USER_ID = "@third:localhost";

/** A real SDK client that is never started; rooms need it for membership/thread helpers. */
export function offlineClient(): MatrixClient {
  return createClient({
    baseUrl: "http://localhost:8008",
    userId: OWN_USER_ID,
    accessToken: "perf-not-a-real-token",
    deviceId: "PERFDEVICE",
    store: new MemoryStore(),
    timelineSupport: true,
  });
}

let eventCounter = 0;

export function textEvent(roomId: string, sender: string, index: number, baseTs = 1_700_000_000_000): MatrixEvent {
  eventCounter += 1;
  return new MatrixEvent({
    event_id: `$evt${eventCounter}-${index}:localhost`,
    room_id: roomId,
    sender,
    type: EventType.RoomMessage,
    origin_server_ts: baseTs + index * 1000,
    content: { msgtype: "m.text", body: `message ${index} ${"lorem ipsum ".repeat(index % 5)}` },
    unsigned: { age: 1 },
  });
}

function memberEvent(roomId: string, userId: string, name: string): MatrixEvent {
  return new MatrixEvent({
    event_id: `$member-${userId}:localhost`,
    room_id: roomId,
    sender: userId,
    state_key: userId,
    type: EventType.RoomMember,
    origin_server_ts: 1_600_000_000_000,
    content: { membership: "join", displayname: name },
  });
}

export interface BuiltRoom {
  room: Room;
  client: MatrixClient;
}

/** Builds a joined room whose live timeline holds `count` text messages alternating sender. */
export async function buildRoom(
  client: MatrixClient,
  roomId: string,
  count: number,
  options: { group?: boolean; name?: string } = {},
): Promise<Room> {
  const room = new Room(roomId, client, OWN_USER_ID, { timelineSupport: true });
  if (options.name) room.name = options.name;
  const members = [
    memberEvent(roomId, OWN_USER_ID, "Self"),
    memberEvent(roomId, PEER_USER_ID, "Peer"),
    ...(options.group ? [memberEvent(roomId, THIRD_USER_ID, "Third")] : []),
  ];
  const senders = options.group ? [OWN_USER_ID, PEER_USER_ID, THIRD_USER_ID] : [OWN_USER_ID, PEER_USER_ID];
  const messages = Array.from({ length: count }, (_, index) => textEvent(roomId, senders[index % senders.length], index));
  room.updateMyMembership("join");
  await room.addLiveEvents(members, { addToState: true });
  await room.addLiveEvents(messages, { addToState: false });
  client.store.storeRoom(room);
  return room;
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function summarize(samples: number[]) {
  return {
    n: samples.length,
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    p99: round(percentile(samples, 99)),
    max: round(Math.max(...samples)),
    mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
  };
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Times `fn` `runs` times (after `warmup` discarded runs) and returns ms samples. */
export function timeSync(fn: () => void, runs = 10, warmup = 2): number[] {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return samples;
}

const reportsDir = join(process.cwd(), "..", "scripts", "benchmark", "reports");

export function writeReport(name: string, data: unknown): string {
  mkdirSync(reportsDir, { recursive: true });
  const label = process.env.PERF_LABEL || "run";
  const file = join(reportsDir, `${name}.${label}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}
