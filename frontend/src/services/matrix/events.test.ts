import { MatrixEvent } from "matrix-js-sdk";
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
