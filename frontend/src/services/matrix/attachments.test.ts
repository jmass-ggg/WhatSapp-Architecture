import type { MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { sendAttachment, sendVoiceMessage, validateAttachment, validateVoiceRecording, type VoiceRecording } from "./attachments";

describe("Matrix media attachments", () => {
  it("rejects unsupported, oversized and mismatched files", async () => {
    await expect(validateAttachment(new File(["x"], "run.exe"))).rejects.toThrow();
    await expect(validateAttachment(new File([new Uint8Array(21 * 1024 * 1024)], "large.txt", { type: "text/plain" }))).rejects.toThrow();
    await expect(validateAttachment(new File(["bad"], "fake.pdf", { type: "application/pdf" }))).rejects.toThrow();
  });

  it("uploads the original bytes and sends a standard image event with progress", async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], "photo.png", { type: "image/png" });
    const uploadContent = vi.fn(async (_file: File, options: { progressHandler: (value: { loaded: number; total: number }) => void }) => {
      options.progressHandler({ loaded: png.size, total: png.size });
      return { content_uri: "mxc://example.org/photo" };
    });
    const sendMessage = vi.fn(async () => ({ event_id: "$file" }));
    const progress = vi.fn();
    await sendAttachment({ uploadContent, sendMessage } as unknown as MatrixClient, "!room:example.org", png, "$original", progress);
    expect(uploadContent.mock.calls[0][0]).toBe(png);
    expect(sendMessage).toHaveBeenCalledWith("!room:example.org", expect.objectContaining({
      msgtype: "m.image", url: "mxc://example.org/photo", body: "photo.png",
      "m.relates_to": { "m.in_reply_to": { event_id: "$original" } },
    }));
    expect(progress).toHaveBeenCalledWith("Uploading: 100%");
  });
});

const webm = (n = 8) => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(n).fill(1)])], { type: "audio/webm;codecs=opus" });
const voice = (over: Partial<VoiceRecording> = {}): VoiceRecording => ({ blob: webm(), mimeType: "audio/webm;codecs=opus", durationMs: 18_000, ...over });

describe("Matrix voice messages", () => {
  function fakeClient(sendMessage = vi.fn(async () => ({ event_id: "$v" }))) {
    const uploadContent = vi.fn(async (_f: File, o: { progressHandler: (v: { loaded: number; total: number }) => void }) => {
      o.progressHandler({ loaded: 1, total: 4 });
      return { content_uri: "mxc://example.org/voice" };
    });
    return { uploadContent, sendMessage, client: { uploadContent, sendMessage } as unknown as MatrixClient };
  }

  it("uploads audio and sends m.audio with mimetype, size, duration and reply relation", async () => {
    const { client, uploadContent, sendMessage } = fakeClient();
    const progress = vi.fn();
    const rec = voice();
    await sendVoiceMessage(client, "!r:example.org", rec, "$orig", progress);
    const file = uploadContent.mock.calls[0][0] as File;
    expect(file.type).toBe("audio/webm");
    expect(file.name).toBe("voice-message.webm");
    expect(sendMessage).toHaveBeenCalledWith("!r:example.org", {
      msgtype: "m.audio", body: "Voice message", url: "mxc://example.org/voice",
      info: { mimetype: "audio/webm", size: rec.blob.size, duration: 18000 },
      "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } },
    }, expect.stringMatching(/^lumachat-voice-/));
    expect(progress.mock.calls.map((c) => c[0])).toEqual(["Preparing audio", "Uploading: 0%", "Uploading: 25%", "Sending message", "Sent"]);
  });

  it("omits the reply relation when not replying", async () => {
    const { client, sendMessage } = fakeClient();
    await sendVoiceMessage(client, "!r:x", voice());
    expect((sendMessage.mock.calls[0] as unknown[])[1]).not.toHaveProperty("m.relates_to");
  });

  it("retries reuse the uploaded media and the same transaction id", async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue({ event_id: "$v" });
    const { client, uploadContent } = fakeClient(sendMessage);
    const attempt = {};
    const rec = voice();
    await expect(sendVoiceMessage(client, "!r:x", rec, undefined, undefined, attempt)).rejects.toThrow("network");
    await sendVoiceMessage(client, "!r:x", rec, undefined, undefined, attempt);
    expect(uploadContent).toHaveBeenCalledTimes(1);
    expect((sendMessage.mock.calls[0] as unknown[])[2]).toBe((sendMessage.mock.calls[1] as unknown[])[2]);
  });

  it("rejects empty, oversized, over-long, wrong-format and mismatched recordings", async () => {
    await expect(validateVoiceRecording(voice({ blob: new Blob([], { type: "audio/webm" }) }))).rejects.toThrow("empty");
    await expect(validateVoiceRecording(voice({ blob: new Blob([new Uint8Array(21 * 1024 * 1024)]) }))).rejects.toThrow("20 MiB");
    await expect(validateVoiceRecording(voice({ durationMs: 200_000 }))).rejects.toThrow("duration");
    await expect(validateVoiceRecording(voice({ mimeType: "video/x-flv" }))).rejects.toThrow("unsupported");
    await expect(validateVoiceRecording(voice({ blob: new Blob([new Uint8Array(20)]) }))).rejects.toThrow("does not match");
  });
});
