import { expect, it } from "vitest";

import type { Message } from "../../types";
import { extractSharedContent, extractUrls } from "./sharedContent";

const msg = (id: string, over: Partial<Message>): Message => ({
  id, sender: "them", text: "", delivery: "sent", sentAt: new Date(Number(id.slice(1)) * 1000),
  matrix: { eventId: id, roomId: "!r", eventType: "m.room.message", senderId: "@a:localhost" }, ...over,
});

it("extracts URLs and trims trailing punctuation", () => {
  expect(extractUrls("see https://example.com/a, and (http://x.org/p?q=1).")).toEqual([
    "https://example.com/a",
    "http://x.org/p?q=1",
  ]);
  expect(extractUrls("javascript:alert(1) ftp://x.org no links")).toEqual([]);
});

it("splits images, files and de-duplicated links newest first, ignoring failed sends", () => {
  const content = extractSharedContent([
    msg("$1", { attachment: { name: "a.png", kind: "image", mediaUri: "mxc://s/a" } }),
    msg("$2", { attachment: { name: "b.pdf", kind: "file", size: 10 }, text: "https://one.test" }),
    msg("$3", { text: "again https://one.test and https://two.test" }),
    msg("$4", { attachment: { name: "c.png", kind: "image" }, delivery: "failed" }),
    { ...msg("$5", { attachment: { name: "local.png", kind: "image" } }), matrix: undefined },
  ]);
  expect(content.images.map((i) => i.attachment.name)).toEqual(["a.png"]);
  expect(content.files.map((f) => f.attachment.name)).toEqual(["b.pdf"]);
  expect(content.links.map((l) => l.url)).toEqual(["https://one.test/", "https://two.test/"]);
  expect(content.links[0].eventId).toBe("$3");
});

it("returns empty collections when nothing is shared", () => {
  expect(extractSharedContent([msg("$1", { text: "hello" })])).toEqual({ images: [], files: [], links: [] });
});
