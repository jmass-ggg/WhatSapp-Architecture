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

type PresenceListener = (event: MatrixEvent | undefined, user: User) => void;

/**
 * Tracks presence for a set of Matrix users using the existing client:
 * `m.presence` events delivered by /sync (UserEvent.Presence) plus one
 * `getPresence` read per user for the initial value. It never writes presence;
 * Synapse derives it from the client's /sync polling, so closing the last
 * session goes offline server-side and other sessions keep the user online.
 */
export class PresenceTracker {
  private states: Record<string, PresenceState> = {};
  private readonly requested = new Set<string>();
  private readonly eventVersion = new Map<string, number>();
  private attached = false;
  private disposed = false;

  constructor(
    private readonly client: Pick<MatrixClient, "on" | "removeListener" | "getPresence">,
    private readonly onChange: (states: Record<string, PresenceState>) => void,
  ) {}

  private readonly onPresence: PresenceListener = (_event, user) => {
    if (this.disposed || !user?.userId) return;
    this.eventVersion.set(user.userId, (this.eventVersion.get(user.userId) ?? 0) + 1);
    this.set(user.userId, presenceFromValue(user.presence));
  };

  get snapshot(): Record<string, PresenceState> {
    return this.states;
  }

  attach(): void {
    if (this.attached || this.disposed) return;
    this.attached = true;
    this.client.on(UserEvent.Presence, this.onPresence);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.client.removeListener(UserEvent.Presence, this.onPresence);
  }

  /** Fetches the initial presence once for each user not yet requested. */
  ensure(userIds: Iterable<string>): void {
    if (this.disposed) return;
    for (const userId of userIds) {
      if (this.requested.has(userId)) continue;
      this.requested.add(userId);
      const versionAtStart = this.eventVersion.get(userId) ?? 0;
      void this.client.getPresence(userId).then(
        (response) => {
          // A newer sync event is more recent than this read.
          if ((this.eventVersion.get(userId) ?? 0) !== versionAtStart) return;
          this.set(userId, presenceFromValue(response?.presence));
        },
        () => {
          // Forbidden (no shared room), disabled presence or a network error.
          if ((this.eventVersion.get(userId) ?? 0) !== versionAtStart) return;
          this.set(userId, "unknown");
        },
      );
    }
  }

  /** Forget everything, e.g. while our own connection is down and values are stale. */
  reset(): void {
    this.requested.clear();
    this.eventVersion.clear();
    if (Object.keys(this.states).length === 0) return;
    this.states = {};
    this.emit();
  }

  dispose(): void {
    this.detach();
    this.disposed = true;
    this.requested.clear();
    this.eventVersion.clear();
    this.states = {};
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
