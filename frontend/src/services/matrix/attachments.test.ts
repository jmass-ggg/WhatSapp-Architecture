import type { MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { sendAttachment, validateAttachment } from "./attachments";

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
