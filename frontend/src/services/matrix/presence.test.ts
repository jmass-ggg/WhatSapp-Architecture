import { UserEvent, type MatrixClient, type User } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PresenceState } from "../../types";
import { isOnline, presenceFromValue, presenceLabel, PresenceTracker } from "./presence";

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

describe("presenceLabel", () => {
  it("names only definite states; unknown shows nothing", () => {
    expect(presenceLabel("online")).toBe("Online");
    expect(presenceLabel("unavailable")).toBe("Away");
    expect(presenceLabel("offline")).toBe("Offline");
    expect(presenceLabel("unknown")).toBeUndefined();
    expect(presenceLabel(undefined)).toBeUndefined();
  });
});

describe("PresenceTracker recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
  const fast = { retryDelaysMs: [100, 300], revalidateIntervalMs: 10_000 };

  it("retries a failed initial read with backoff and takes the answer that finally arrives", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { client, mock } = fakeClient(async () => {
      calls += 1;
      if (calls < 3) throw new Error("network");
      return { presence: "online" };
    });
    const onChange = vi.fn();
    const tracker = new PresenceTracker(client, onChange, fast);
    tracker.attach();
    tracker.ensure([alice]);
    await flush();
    expect(tracker.snapshot[alice]).toBe("unknown");
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.getPresence).toHaveBeenCalledTimes(2);
    expect(tracker.snapshot[alice]).toBe("unknown");
    await vi.advanceTimersByTimeAsync(300);
    expect(mock.getPresence).toHaveBeenCalledTimes(3);
    expect(tracker.snapshot[alice]).toBe("online");
    // unknown once, then online: no re-render for the repeated unknown.
    expect(onChange).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });

  it("stops retrying after the last delay until the next revalidation", async () => {
    vi.useFakeTimers();
    const { client, mock } = fakeClient(async () => { throw Object.assign(new Error("forbidden"), { httpStatus: 403 }); });
    const tracker = new PresenceTracker(client, () => undefined, fast);
    tracker.attach();
    tracker.ensure([alice]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.getPresence).toHaveBeenCalledTimes(3);
    expect(tracker.snapshot[alice]).toBe("unknown");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.getPresence).toHaveBeenCalledTimes(4);
    tracker.dispose();
  });

  it("drops a pending retry when a sync event answers first", async () => {
    vi.useFakeTimers();
    const { client, mock, emit } = fakeClient(async () => { throw new Error("network"); });
    const tracker = new PresenceTracker(client, () => undefined, fast);
    tracker.attach();
    tracker.ensure([alice]);
    await flush();
    emit(alice, "online");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.getPresence).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot[alice]).toBe("online");
    tracker.dispose();
  });

  it("revalidates tracked users on the interval and recovers a missed offline event", async () => {
    vi.useFakeTimers();
    let server = "online";
    const { client, mock } = fakeClient(async () => ({ presence: server }));
    const tracker = new PresenceTracker(client, () => undefined, fast);
    tracker.attach();
    tracker.ensure([alice]);
    await flush();
    expect(tracker.snapshot[alice]).toBe("online");
    server = "offline"; // the m.presence event for this never reached us
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.getPresence).toHaveBeenCalledTimes(2);
    expect(tracker.snapshot[alice]).toBe("offline");
    tracker.dispose();
  });

  it("keeps the last known state when a revalidation read fails", async () => {
    vi.useFakeTimers();
    let fail = false;
    const { client } = fakeClient(async () => { if (fail) throw new Error("network"); return { presence: "online" }; });
    const tracker = new PresenceTracker(client, () => undefined, fast);
    tracker.attach();
    tracker.ensure([alice]);
    await flush();
    fail = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tracker.snapshot[alice]).toBe("online");
    tracker.dispose();
  });

  it("does not let a slow revalidation read overwrite a newer sync event", async () => {
    vi.useFakeTimers();
    let resolveSecond!: (value: { presence: string }) => void;
    let calls = 0;
    const { client, emit } = fakeClient(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ presence: "online" }) : new Promise((r) => { resolveSecond = r; });
    });
    const tracker = new PresenceTracker(client, () => undefined, fast);
    tracker.attach();
    tracker.ensure([alice]);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    emit(alice, "unavailable");
    resolveSecond({ presence: "online" });
    await flush();
    expect(tracker.snapshot[alice]).toBe("unavailable");
    tracker.dispose();
  });

  it("neither polls nor changes anyone's state while the tab is hidden", async () => {
    vi.useFakeTimers();
    const { client, mock } = fakeClient(async () => ({ presence: "online" }));
    const tracker = new PresenceTracker(client, () => undefined, fast);
    tracker.attach();
    tracker.ensure([alice]);
    await flush();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mock.getPresence).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot[alice]).toBe("online");
    visibility.mockReturnValue("visible");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.getPresence).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
    tracker.dispose();
  });

  it("stops the interval and pending retries on detach, reset and dispose", async () => {
    vi.useFakeTimers();
    const { client, mock } = fakeClient(async () => { throw new Error("network"); });
    const tracker = new PresenceTracker(client, () => undefined, fast);
    tracker.attach();
    tracker.ensure([alice]);
    await flush();
    tracker.reset();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.getPresence).toHaveBeenCalledTimes(1);
    tracker.ensure([alice]);
    await flush();
    expect(mock.getPresence).toHaveBeenCalledTimes(2);
    tracker.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.getPresence).toHaveBeenCalledTimes(2);
  });

  it("follows the server through a second session closing: offline then online stays online", () => {
    const { client, emit } = fakeClient(async () => ({}));
    const tracker = new PresenceTracker(client, () => undefined, fast);
    tracker.attach();
    emit(alice, "online");
    // Synapse re-evaluates when one of two devices stops syncing and sends offline, then online.
    emit(alice, "offline");
    emit(alice, "online");
    expect(tracker.snapshot[alice]).toBe("online");
    // Idle on every session: away. Last session gone: offline.
    emit(alice, "unavailable");
    expect(presenceLabel(tracker.snapshot[alice])).toBe("Away");
    emit(alice, "offline");
    expect(presenceLabel(tracker.snapshot[alice])).toBe("Offline");
    tracker.dispose();
  });

  it("tracks the signed-in user like any other, so their own status can be shown", async () => {
    const { client, mock, emit } = fakeClient(async () => ({ presence: "online" }));
    const self = "@self:localhost";
    const tracker = new PresenceTracker(client, () => undefined, fast);
    tracker.attach();
    tracker.ensure([self, alice]);
    await tick();
    expect(mock.getPresence).toHaveBeenCalledWith(self);
    expect(tracker.snapshot[self]).toBe("online");
    emit(self, "unavailable");
    expect(tracker.snapshot[self]).toBe("unavailable");
    tracker.dispose();
  });
});
