import { MatrixEvent, type EventTimeline, type MatrixClient, type Room } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  loadMatrixMessage,
  loadMatrixMessagePreview,
} from "./messageNavigation";

const ROOM_ID = "!room:localhost";

function event(
  eventId: string,
  type = "m.room.message",
  content: Record<string, unknown> = { msgtype: "m.text", body: "Original content" },
) {
  return new MatrixEvent({
    event_id: eventId,
    room_id: ROOM_ID,
    sender: "@kelly:localhost",
    type,
    origin_server_ts: 1_793_304_720_000,
    content,
  });
}

function setup(target?: MatrixEvent) {
  let found = target;
  let token: string | null = "batch-0";
  const timelineSet = {
    getTimelines: () => [timeline],
  };
  const timeline = {
    getPaginationToken: () => token,
    getEvents: () => found ? [found] : [],
  } as unknown as EventTimeline;
  const room = {
    roomId: ROOM_ID,
    getLiveTimeline: () => timeline,
    getUnfilteredTimelineSet: () => timelineSet,
    findEventById: (id: string) => found?.getId() === id ? found : undefined,
    getMembers: () => [{
      userId: "@kelly:localhost",
      name: "Kelly Boyle",
    }],
  } as unknown as Room;
  const client = {
    getUserId: () => "@self:localhost",
    fetchRoomEvent: vi.fn(async () => target?.event ?? {}),
    getEventMapper: vi.fn(() => (raw: Record<string, unknown>) =>
      target ?? new MatrixEvent(raw as never)),
    paginateEventTimeline: vi.fn(async () => {
      found = target;
      token = "batch-1";
      return true;
    }),
    getEventTimeline: vi.fn(async () => target
      ? ({ getEvents: () => [target] } as unknown as EventTimeline)
      : null),
  } as unknown as MatrixClient;
  return {
    client,
    room,
    timelineSet,
    target,
    setFound: (message?: MatrixEvent) => { found = message; },
  };
}

describe("Matrix message navigation", () => {
  it("resolves pinned preview metadata without adding an old event to the visible timeline", async () => {
    const target = event("$preview");
    const fixture = setup(target);
    fixture.setFound(undefined);

    const message = await loadMatrixMessagePreview(
      fixture.client, fixture.room, "$preview", "Kelly Boyle",
    );

    expect(fixture.client.fetchRoomEvent).toHaveBeenCalledWith(ROOM_ID, "$preview");
    expect(fixture.client.getEventTimeline).not.toHaveBeenCalled();
    expect(message.senderName).toBe("Kelly Boyle");
    expect(message.text).toBe("Original content");
  });

  it("paginates backward until the exact event is found and resolves a friendly sender", async () => {
    const target = event("$old-message");
    const fixture = setup(target);
    fixture.setFound(undefined);

    const message = await loadMatrixMessage(
      fixture.client, fixture.room, "$old-message", "A direct contact", true,
    );

    expect(fixture.client.paginateEventTimeline).toHaveBeenCalledTimes(1);
    expect(fixture.client.getEventTimeline).not.toHaveBeenCalled();
    expect(message).toMatchObject({
      matrix: { eventId: "$old-message", roomId: ROOM_ID },
      senderName: "Kelly Boyle",
      text: "Original content",
    });
  });

  it("uses Matrix event context when the bounded pagination window does not contain the target", async () => {
    const target = event("$context-message");
    const fixture = setup(target);
    fixture.setFound(undefined);
    vi.mocked(fixture.client.paginateEventTimeline).mockResolvedValue(false);

    const message = await loadMatrixMessage(
      fixture.client, fixture.room, "$context-message", "A direct contact", true,
    );

    expect(fixture.client.getEventTimeline).toHaveBeenCalledWith(
      fixture.timelineSet,
      "$context-message",
    );
    expect(message.matrix?.eventId).toBe("$context-message");
  });

  it("fails clearly instead of jumping to an unrelated event when the target is unavailable", async () => {
    const fixture = setup();
    await expect(loadMatrixMessage(
      fixture.client, fixture.room, "$missing", "A direct contact", false,
    )).rejects.toThrow(/unavailable|access/i);
  });

  it("shows an unavailable message when Matrix reports a redacted event", async () => {
    const deleted = event("$deleted");
    vi.spyOn(deleted, "isRedacted").mockReturnValue(true);
    const fixture = setup(deleted);
    await expect(loadMatrixMessage(
      fixture.client, fixture.room, "$deleted", "A direct contact", false,
    )).rejects.toThrow(/deleted or redacted/i);
  });

  it("does not expose ciphertext from a retired encrypted event", async () => {
    const encrypted = event("$encrypted", "m.room.encrypted", {
      algorithm: "m.megolm.v1.aes-sha2",
      ciphertext: "ciphertext-must-not-be-rendered",
    });
    const fixture = setup(encrypted);
    await expect(loadMatrixMessage(
      fixture.client, fixture.room, "$encrypted", "A direct contact", false,
    )).rejects.toThrow(/not an available message/i);
  });
});
