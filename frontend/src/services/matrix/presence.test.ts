import { UserEvent, type MatrixClient, type User } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import type { PresenceState } from "../../types";
import { isOnline, presenceFromValue, PresenceTracker } from "./presence";

type Listener = (event: undefined, user: User) => void;

function fakeClient(getPresence: (id: string) => Promise<{ presence?: string }>) {
  const listeners = new Set<Listener>();
  const client = {
    on: vi.fn((event: string, listener: Listener) => {
      expect(event).toBe(UserEvent.Presence);
      listeners.add(listener);
    }),
    removeListener: vi.fn((_event: string, listener: Listener) => listeners.delete(listener)),
    getPresence: vi.fn(getPresence),
  };
  const emit = (userId: string, presence: unknown) =>
    listeners.forEach((l) => l(undefined, { userId, presence } as unknown as User));
  return { client: client as unknown as Pick<MatrixClient, "on" | "removeListener" | "getPresence">, mock: client, listeners, emit };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const alice = "@alice:localhost";

describe("presenceFromValue", () => {
  it.each([
    ["online", "online"],
    ["unavailable", "unavailable"],
    ["offline", "offline"],
    [undefined, "unknown"],
    [null, "unknown"],
    ["", "unknown"],
    ["ONLINE", "unknown"],
    [1, "unknown"],
  ])("maps %j to %s", (input, expected) => {
    expect(presenceFromValue(input)).toBe(expected);
  });

  it("treats only online as online", () => {
    expect(isOnline("online")).toBe(true);
    for (const state of ["unavailable", "offline", "unknown", undefined] as const) {
      expect(isOnline(state)).toBe(false);
    }
  });
});

describe("PresenceTracker", () => {
  it("applies sync presence events and ignores unknown values as offline", () => {
    const { client, emit } = fakeClient(async () => ({}));
    const seen: Record<string, PresenceState>[] = [];
    const tracker = new PresenceTracker(client, (s) => seen.push(s));
    tracker.attach();

    emit(alice, "online");
    expect(tracker.snapshot[alice]).toBe("online");
    emit(alice, "unavailable");
    expect(tracker.snapshot[alice]).toBe("unavailable");
    emit(alice, undefined);
    expect(tracker.snapshot[alice]).toBe("unknown");
    emit(alice, "offline");
    expect(tracker.snapshot[alice]).toBe("offline");
    expect(seen).toHaveLength(4);
  });

  it("does not re-render when the state is unchanged", () => {
    const { client, emit } = fakeClient(async () => ({}));
    const onChange = vi.fn();
    const tracker = new PresenceTracker(client, onChange);
    tracker.attach();
    emit(alice, "online");
    emit(alice, "online");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("fetches initial presence once per user", async () => {
    const { client, mock } = fakeClient(async () => ({ presence: "online" }));
    const tracker = new PresenceTracker(client, () => undefined);
    tracker.ensure([alice, alice]);
    tracker.ensure([alice]);
    await tick();
    expect(mock.getPresence).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot[alice]).toBe("online");
  });

  it("reports unknown, not offline, when presence is forbidden or fails", async () => {
    const { client } = fakeClient(async () => { throw Object.assign(new Error("no"), { httpStatus: 403 }); });
    const tracker = new PresenceTracker(client, () => undefined);
    tracker.ensure([alice]);
    await tick();
    expect(tracker.snapshot[alice]).toBe("unknown");
  });

  it("does not let a late initial read overwrite a newer sync event", async () => {
    let resolve!: (value: { presence: string }) => void;
    const { client, emit } = fakeClient(() => new Promise((r) => { resolve = r; }));
    const tracker = new PresenceTracker(client, () => undefined);
    tracker.attach();
    tracker.ensure([alice]);
    emit(alice, "online");
    resolve({ presence: "offline" });
    await tick();
    expect(tracker.snapshot[alice]).toBe("online");
  });

  it("clears stale state on reset and re-reads afterwards", async () => {
    const { client, mock } = fakeClient(async () => ({ presence: "online" }));
    const tracker = new PresenceTracker(client, () => undefined);
    tracker.ensure([alice]);
    await tick();
    tracker.reset();
    expect(tracker.snapshot).toEqual({});
    tracker.ensure([alice]);
    await tick();
    expect(mock.getPresence).toHaveBeenCalledTimes(2);
  });

  it("subscribes once and removes its listener on detach and dispose", () => {
    const { client, mock, listeners, emit } = fakeClient(async () => ({}));
    const onChange = vi.fn();
    const tracker = new PresenceTracker(client, onChange);
    tracker.attach();
    tracker.attach();
    expect(mock.on).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);

    tracker.dispose();
    expect(listeners.size).toBe(0);
    emit(alice, "online");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a read that resolves after dispose", async () => {
    let resolve!: (value: { presence: string }) => void;
    const { client } = fakeClient(() => new Promise((r) => { resolve = r; }));
    const onChange = vi.fn();
    const tracker = new PresenceTracker(client, onChange);
    tracker.ensure([alice]);
    tracker.dispose();
    resolve({ presence: "online" });
    await tick();
    expect(onChange).not.toHaveBeenCalled();
  });
});
