import { UserEvent, type MatrixClient, type MatrixEvent, type User } from "matrix-js-sdk";

import type { PresenceState } from "../../types";

/**
 * Maps a raw Matrix `presence` value to our state. Anything that is not exactly
 * a known value (missing, null, malformed) is "unknown" - never "offline", since
 * a missing answer is not proof that the user closed their browser.
 */
export function presenceFromValue(value: unknown): PresenceState {
  return value === "online" || value === "unavailable" || value === "offline"
    ? value
    : "unknown";
}

export const isOnline = (state: PresenceState | undefined): boolean => state === "online";

/** Human label for a definite state; "unknown" (and no state) has no label and shows nothing. */
export function presenceLabel(state: PresenceState | undefined): "Online" | "Away" | "Offline" | undefined {
  switch (state) {
    case "online": return "Online";
    case "unavailable": return "Away";
    case "offline": return "Offline";
    default: return undefined;
  }
}

type PresenceListener = (event: MatrixEvent | undefined, user: User) => void;

export interface PresenceTrackerOptions {
  /** Delays between retries of a failed read; after the last one the user waits for revalidation. */
  retryDelaysMs?: number[];
  /** How often every tracked user is re-read to recover from a missed sync event; 0 disables. */
  revalidateIntervalMs?: number;
}

export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
export const DEFAULT_REVALIDATE_INTERVAL_MS = 120_000;

/**
 * Tracks presence for a set of Matrix users using the existing client:
 * `m.presence` events delivered by /sync (UserEvent.Presence) are the primary source; one
 * `getPresence` read per user supplies the initial value, is retried with bounded backoff when
 * it fails, and is repeated at a slow fixed interval so a missed sync event cannot leave a user
 * stale indefinitely. A sync event always wins over an older in-flight read.
 *
 * It never writes presence; Synapse derives it from this client's /sync polling, so closing the
 * last session goes offline server-side while other sessions keep the user online. Nothing here
 * infers offline from tab visibility or a local timer.
 */
export class PresenceTracker {
  private states: Record<string, PresenceState> = {};
  private readonly requested = new Set<string>();
  private readonly eventVersion = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private revalidateTimer: ReturnType<typeof setInterval> | null = null;
  private readonly retryDelaysMs: number[];
  private readonly revalidateIntervalMs: number;
  private attached = false;
  private disposed = false;

  constructor(
    private readonly client: Pick<MatrixClient, "on" | "removeListener" | "getPresence">,
    private readonly onChange: (states: Record<string, PresenceState>) => void,
    options: PresenceTrackerOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.revalidateIntervalMs = options.revalidateIntervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS;
  }

  private readonly onPresence: PresenceListener = (_event, user) => {
    if (this.disposed || !user?.userId) return;
    this.eventVersion.set(user.userId, (this.eventVersion.get(user.userId) ?? 0) + 1);
    // The server just told us; a scheduled retry of an older failed read is moot.
    this.clearRetry(user.userId);
    this.set(user.userId, presenceFromValue(user.presence));
  };

  get snapshot(): Record<string, PresenceState> {
    return this.states;
  }

  attach(): void {
    if (this.attached || this.disposed) return;
    this.attached = true;
    this.client.on(UserEvent.Presence, this.onPresence);
    if (this.revalidateIntervalMs > 0) {
      this.revalidateTimer = setInterval(() => this.revalidate(), this.revalidateIntervalMs);
    }
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.client.removeListener(UserEvent.Presence, this.onPresence);
    if (this.revalidateTimer !== null) {
      clearInterval(this.revalidateTimer);
      this.revalidateTimer = null;
    }
  }

  /** Fetches the initial presence once for each user not yet requested (retrying failures). */
  ensure(userIds: Iterable<string>): void {
    if (this.disposed) return;
    for (const userId of userIds) {
      if (this.requested.has(userId)) continue;
      this.requested.add(userId);
      this.read(userId, 0);
    }
  }

  /**
   * Re-reads every tracked user that has no read or retry pending. Bounded: one request per
   * tracked user per interval, skipped while the tab is hidden (nobody is looking, and a hidden
   * tab is no evidence about anyone's presence).
   */
  revalidate(): void {
    if (this.disposed) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    for (const userId of this.requested) {
      if (this.inFlight.has(userId) || this.retryTimers.has(userId)) continue;
      // No retry ladder here: a failed revalidation simply waits for the next interval.
      this.read(userId, this.retryDelaysMs.length);
    }
  }

  /** Forget everything, e.g. while our own connection is down and values are stale. */
  reset(): void {
    this.requested.clear();
    this.eventVersion.clear();
    this.inFlight.clear();
    this.clearAllRetries();
    if (Object.keys(this.states).length === 0) return;
    this.states = {};
    this.emit();
  }

  dispose(): void {
    this.detach();
    this.disposed = true;
    this.requested.clear();
    this.eventVersion.clear();
    this.inFlight.clear();
    this.clearAllRetries();
    this.states = {};
  }

  private read(userId: string, attempt: number): void {
    const versionAtStart = this.eventVersion.get(userId) ?? 0;
    this.inFlight.add(userId);
    const stale = () =>
      this.disposed || !this.requested.has(userId) || (this.eventVersion.get(userId) ?? 0) !== versionAtStart;
    void this.client.getPresence(userId).then(
      (response) => {
        this.inFlight.delete(userId);
        // A newer sync event (or a reset) is more recent than this read.
        if (stale()) return;
        this.set(userId, presenceFromValue(response?.presence));
      },
      () => {
        this.inFlight.delete(userId);
        if (stale()) return;
        // Forbidden (no shared room), disabled presence or a network error. A failure is not
        // proof of anything: first answer is "unknown", a later one keeps the last known state.
        if (!(userId in this.states)) this.set(userId, "unknown");
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) return;
        this.retryTimers.set(userId, setTimeout(() => {
          this.retryTimers.delete(userId);
          if (!this.disposed && this.requested.has(userId)) this.read(userId, attempt + 1);
        }, delay));
      },
    );
  }

  private clearRetry(userId: string): void {
    const timer = this.retryTimers.get(userId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.retryTimers.delete(userId);
  }

  private clearAllRetries(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private set(userId: string, state: PresenceState): void {
    if (this.disposed || this.states[userId] === state) return;
    this.states = { ...this.states, [userId]: state };
    this.emit();
  }

  private emit(): void {
    if (!this.disposed) this.onChange(this.states);
  }
}
