import { EventStatus, MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";

import { messageFromMatrixEvent } from "./events";

function event(
  type: string,
  content: Record<string, unknown>,
  eventId = "$event:localhost",
) {
  return new MatrixEvent({
    event_id: eventId,
    room_id: "!room:localhost",
    sender: "@other:localhost",
    type,
    origin_server_ts: 1_750_000_000_000,
    content,
  });
}

describe("Matrix event conversion", () => {
  it("derives outgoing transmission states from SDK local echoes and server echoes", () => {
    const outgoing = new MatrixEvent({
      event_id: "~local", room_id: "!room:localhost", sender: "@self:localhost",
      type: "m.room.message", content: { msgtype: "m.text", body: "Secret" },
    });
    for (const status of [EventStatus.ENCRYPTING, EventStatus.QUEUED, EventStatus.SENDING]) {
      outgoing.setStatus(status);
      expect(messageFromMatrixEvent(outgoing, "!room:localhost", "@self:localhost")?.delivery).toBe("sending");
    }
    outgoing.setStatus(EventStatus.NOT_SENT);
    expect(messageFromMatrixEvent(outgoing, "!room:localhost", "@self:localhost")?.delivery).toBe("failed");
    outgoing.setStatus(EventStatus.CANCELLED);
    expect(messageFromMatrixEvent(outgoing, "!room:localhost", "@self:localhost")?.delivery).toBe("cancelled");
    outgoing.replaceLocalEventId("$server:localhost");
    outgoing.setStatus(EventStatus.SENT);
    expect(messageFromMatrixEvent(outgoing, "!room:localhost", "@self:localhost")).toMatchObject({
      id: "$server:localhost", delivery: "sent",
    });
    outgoing.setStatus(null);
    expect(messageFromMatrixEvent(outgoing, "!room:localhost", "@self:localhost")?.delivery).toBe("sent");
    expect(messageFromMatrixEvent(outgoing, "!room:localhost", "@other:localhost")?.delivery).toBe("sent");
  });

  it("uses the original event timestamp, provisional local echo time and safe unavailable fallback", () => {
    const timestamped = event("m.room.message", {
      msgtype: "m.text",
      body: "Server time",
    });
    const serverTime = timestamped.getTs();
    expect(messageFromMatrixEvent(timestamped, "!room:localhost", "@self:localhost")?.sentAt?.getTime())
      .toBe(serverTime);

    const epoch = new MatrixEvent({
      event_id: "$epoch",
      room_id: "!room:localhost",
      sender: "@other:localhost",
      type: "m.room.message",
      origin_server_ts: 0,
      content: { msgtype: "m.text", body: "At epoch" },
    });
    expect(messageFromMatrixEvent(epoch, "!room:localhost", "@self:localhost")?.sentAt?.getTime())
      .toBe(0);

    const pending = new MatrixEvent({
      event_id: "~pending",
      room_id: "!room:localhost",
      sender: "@self:localhost",
      type: "m.room.message",
      content: { msgtype: "m.text", body: "Pending" },
    });
    pending.localTimestamp = 1_793_304_720_000;
    expect(messageFromMatrixEvent(pending, "!room:localhost", "@self:localhost")?.sentAt?.getTime())
      .toBe(1_793_304_720_000);

    const malformed = new MatrixEvent({
      event_id: "$bad-time",
      room_id: "!room:localhost",
      sender: "@other:localhost",
      type: "m.room.message",
      origin_server_ts: Number.NaN,
      content: { msgtype: "m.text", body: "No valid time" },
    });
    expect(messageFromMatrixEvent(malformed, "!room:localhost", "@self:localhost")?.sentAt)
      .toBeUndefined();
  });

  it("keeps an encrypted outgoing local echo readable without exposing ciphertext", () => {
    const outgoing = new MatrixEvent({
      event_id: "~encrypted", room_id: "!room:localhost", sender: "@self:localhost",
      type: "m.room.message", content: { msgtype: "m.text", body: "Secret" },
    });
    outgoing.setStatus(EventStatus.ENCRYPTING);
    outgoing.makeEncrypted("m.room.encrypted", { ciphertext: "ciphertext" }, "curve", "ed");
    const message = messageFromMatrixEvent(outgoing, "!room:localhost", "@self:localhost");
    expect(message?.text).toBe("Secret");
    expect(message?.delivery).toBe("sending");
    expect(message?.matrix?.eventType).toBe("m.room.encrypted");
  });
  it("keeps plain text as text and ignores untrusted formatted HTML", () => {
    const message = messageFromMatrixEvent(
      event("m.room.message", {
        msgtype: "m.text",
        body: "Readable text",
        format: "org.matrix.custom.html",
        formatted_body: "<img src=x onerror=alert(1)>",
      }),
      "!room:localhost",
      "@self:localhost",
    );

    expect(message?.text).toBe("Readable text");
    expect(message?.matrix).toMatchObject({
      eventId: "$event:localhost",
      roomId: "!room:localhost",
      eventType: "m.room.message",
      senderId: "@other:localhost",
    });
  });

  it("does not interpret ciphertext as plaintext when crypto is not enabled", () => {
    const message = messageFromMatrixEvent(
      event("m.room.encrypted", {
        ciphertext: "untrusted encrypted payload",
        algorithm: "m.megolm.v1.aes-sha2",
      }),
      "!room:localhost",
      "@self:localhost",
    );

    expect(message?.text).toContain("waiting for a room key");
    expect(message?.text).not.toContain("untrusted encrypted payload");
    expect(message?.matrix?.eventType).toBe("m.room.encrypted");
    expect(message?.matrix?.encryptionStatus).toBe("pending");
  });

  it("shows a sanitized failure when the SDK supplies its m.bad.encrypted clear event", () => {
    const failedEvent = {
      getWireType: () => "m.room.encrypted",
      getType: () => "m.room.message",
      getSender: () => "@other:localhost",
      getDate: () => new Date(1_750_000_000_000),
      getTs: () => 1_750_000_000_000,
      getId: () => "$failed:localhost",
      isEncrypted: () => true,
      isDecryptionFailure: () => true,
      getClearContent: () => ({
        msgtype: "m.bad.encrypted",
        body: "** Unable to decrypt: sensitive crypto details **",
      }),
    } as unknown as MatrixEvent;

    const message = messageFromMatrixEvent(
      failedEvent,
      "!room:localhost",
      "@self:localhost",
    );

    expect(message?.text).toBe("Unable to decrypt this encrypted message.");
    expect(message?.text).not.toContain("sensitive crypto details");
    expect(message?.matrix?.encryptionStatus).toBe("failed");
  });

  it("ignores unsupported and malformed room events", () => {
    expect(
      messageFromMatrixEvent(
        event("m.room.member", { membership: "join" }),
        "!room:localhost",
        "@self:localhost",
      ),
    ).toBeNull();
    expect(
      messageFromMatrixEvent(
        event("m.room.message", { msgtype: "m.text", body: 3 }),
        "!room:localhost",
        "@self:localhost",
      ),
    ).toBeNull();
  });
});
