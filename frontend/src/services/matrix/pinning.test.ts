import { EventType, MatrixEvent, type MatrixClient, type Room } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  canManagePinnedMessages,
  getPinnedEventIds,
  MAX_PINNED_MESSAGES,
  updatePinnedEvent,
} from "./pinning";

function setup(initial: string[] = [], maySend = true) {
  let serverPinned = [...initial];
  let stateExists = initial.length > 0;
  const currentState = {
    getStateEvents: vi.fn(() => stateExists
      ? new MatrixEvent({
          type: EventType.RoomPinnedEvents,
          state_key: "",
          content: { pinned: serverPinned },
        })
      : null),
    maySendStateEvent: vi.fn(() => maySend),
  };
  const room = {
    roomId: "!room:localhost",
    getMyMembership: () => "join",
    currentState,
  } as unknown as Room;
  const getStateEvent = vi.fn(async () => {
    if (!stateExists) throw { httpStatus: 404, errcode: "M_NOT_FOUND" };
    return { pinned: [...serverPinned] };
  });
  const sendStateEvent = vi.fn(async (
    roomId: string,
    eventType: string,
    content: { pinned: string[] },
    stateKey: string,
  ) => {
    expect(roomId).toBe(room.roomId);
    expect(eventType).toBe(EventType.RoomPinnedEvents);
    expect(stateKey).toBe("");
    serverPinned = [...content.pinned];
    stateExists = true;
    return { event_id: "$state:localhost" };
  });
  const client = { getStateEvent, sendStateEvent } as unknown as MatrixClient;
  return {
    client,
    room,
    getStateEvent,
    sendStateEvent,
    serverPinned: () => serverPinned,
  };
}

describe("Matrix pinned messages", () => {
  it("pins event references in standard room state and unpins them", async () => {
    const fixture = setup();
    await expect(updatePinnedEvent(
      fixture.client, fixture.room, "@self:localhost", "$message:localhost", "pin",
    )).resolves.toEqual(["$message:localhost"]);
    expect(fixture.sendStateEvent).toHaveBeenCalledWith(
      "!room:localhost",
      EventType.RoomPinnedEvents,
      { pinned: ["$message:localhost"] },
      "",
    );

    await expect(updatePinnedEvent(
      fixture.client, fixture.room, "@self:localhost", "$message:localhost", "unpin",
    )).resolves.toEqual([]);
    expect(fixture.serverPinned()).toEqual([]);
  });

  it("does not duplicate an existing pin and reads the latest server list before writing", async () => {
    const fixture = setup(["$existing:localhost"]);
    await updatePinnedEvent(
      fixture.client, fixture.room, "@self:localhost", "$existing:localhost", "pin",
    );
    expect(fixture.getStateEvent).toHaveBeenCalledTimes(1);
    expect(fixture.sendStateEvent).not.toHaveBeenCalled();

    fixture.serverPinned().push("$newer-from-another-device:localhost");
    await updatePinnedEvent(
      fixture.client, fixture.room, "@self:localhost", "$ours:localhost", "pin",
    );
    expect(fixture.serverPinned()).toEqual([
      "$existing:localhost",
      "$newer-from-another-device:localhost",
      "$ours:localhost",
    ]);
  });

  it("enforces three pins without changing state when the room is full", async () => {
    const existing = ["$one", "$two", "$three"];
    const fixture = setup(existing);
    await expect(updatePinnedEvent(
      fixture.client, fixture.room, "@self:localhost", "$four", "pin",
    )).rejects.toThrow(/up to three pinned messages/i);
    expect(fixture.sendStateEvent).not.toHaveBeenCalled();
    expect(fixture.serverPinned()).toEqual(existing);
    expect(MAX_PINNED_MESSAGES).toBe(3);
  });

  it("respects room membership and state-event power-level permission", async () => {
    const denied = setup([], false);
    expect(canManagePinnedMessages(denied.room, "@self:localhost")).toBe(false);
    await expect(updatePinnedEvent(
      denied.client, denied.room, "@self:localhost", "$message", "pin",
    )).rejects.toThrow(/permission/i);
    expect(denied.sendStateEvent).not.toHaveBeenCalled();

    const allowed = setup();
    expect(canManagePinnedMessages(allowed.room, "@self:localhost")).toBe(true);

    const invitedRoom = {
      roomId: "!invited:localhost",
      getMyMembership: () => "invite",
      currentState: { maySendStateEvent: () => true },
    } as unknown as Room;
    expect(canManagePinnedMessages(invitedRoom, "@self:localhost")).toBe(false);
    await expect(updatePinnedEvent(
      denied.client, invitedRoom, "@self:localhost", "$message", "pin",
    )).rejects.toThrow(/join this conversation/i);
  });

  it("serializes concurrent local pin updates and preserves both references", async () => {
    const fixture = setup();
    await Promise.all([
      updatePinnedEvent(fixture.client, fixture.room, "@self:localhost", "$first", "pin"),
      updatePinnedEvent(fixture.client, fixture.room, "@self:localhost", "$second", "pin"),
    ]);
    expect(fixture.serverPinned()).toEqual(["$first", "$second"]);
  });

  it("rebases and retries when a competing room-state update wins the first write", async () => {
    const fixture = setup();
    fixture.getStateEvent
      .mockRejectedValueOnce({ httpStatus: 404, errcode: "M_NOT_FOUND" })
      .mockResolvedValueOnce({ pinned: ["$from-another-device"] });
    fixture.sendStateEvent.mockImplementationOnce(async () => {
      fixture.serverPinned().splice(0, fixture.serverPinned().length, "$from-another-device");
      return { event_id: "$competing-state" };
    });

    await updatePinnedEvent(
      fixture.client, fixture.room, "@self:localhost", "$ours", "pin",
    );

    expect(fixture.sendStateEvent).toHaveBeenCalledTimes(2);
    expect(fixture.serverPinned()).toEqual(["$from-another-device", "$ours"]);
  });

  it("restores pins from Matrix room state after a new room mapping", () => {
    const pinned = ["$persisted"];
    const room = {
      currentState: {
        getStateEvents: () => new MatrixEvent({
          type: EventType.RoomPinnedEvents,
          state_key: "",
          content: { pinned },
        }),
      },
    } as unknown as Room;
    expect(getPinnedEventIds(room)).toEqual(pinned);
  });
});
