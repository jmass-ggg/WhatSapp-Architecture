import { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";

import { messageFromMatrixEvent } from "./events";
import { adjustMentions, filterMentionCandidates, findMentionTrigger, parseMentionSegments, type MentionEntity } from "./mentions";

const members = [
  { userId: "@james:x", name: "James Gurung" },
  { userId: "@james_smith:x", name: "James Smith" },
  { userId: "@alex:x", name: "Alex Smith" },
  { userId: "@me:x", name: "Me" },
];

describe("findMentionTrigger", () => {
  it("opens for @ at start, mid-sentence, with partial text and spaces", () => {
    expect(findMentionTrigger("@", 1)).toEqual({ start: 0, query: "" });
    expect(findMentionTrigger("Hello @jam", 10)).toEqual({ start: 6, query: "jam" });
    expect(findMentionTrigger("Hello @James Gu", 15)).toEqual({ start: 6, query: "James Gu" });
    expect(findMentionTrigger("Hi @ja there", 6)).toEqual({ start: 3, query: "ja" });
  });
  it("ignores emails and text across lines", () => {
    expect(findMentionTrigger("mail me@example.com", 19)).toBeNull();
    expect(findMentionTrigger("@ja\nhello", 9)).toBeNull();
  });
});

describe("filterMentionCandidates", () => {
  it("matches names and usernames case-insensitively, keeps same-name users distinct, excludes self", () => {
    expect(filterMentionCandidates(members, "JA", "@me:x").map((m) => m.userId)).toEqual(["@james:x", "@james_smith:x"]);
    expect(filterMentionCandidates(members, "smith").map((m) => m.userId)).toEqual(["@alex:x", "@james_smith:x"]);
    expect(filterMentionCandidates(members, "zzz")).toEqual([]);
    const twins = [{ userId: "@a:x", name: "Sam" }, { userId: "@b:x", name: "Sam" }];
    expect(filterMentionCandidates(twins, "sam").map((m) => m.userId)).toEqual(["@a:x", "@b:x"]);
    expect(filterMentionCandidates(members, "", "@me:x")).toHaveLength(3);
  });
});

describe("adjustMentions", () => {
  const entity: MentionEntity = { userId: "@james:x", label: "@James", start: 3, end: 9 };
  it("shifts for typing or pasting before, keeps for typing after, drops when touched", () => {
    expect(adjustMentions([entity], "Hi @James!", "Oh, Hi @James!")[0]).toMatchObject({ start: 7, end: 13 });
    expect(adjustMentions([entity], "Hi @James!", "Hi @James!!")[0]).toMatchObject({ start: 3, end: 9 });
    expect(adjustMentions([entity], "Hi @James!", "Hi @Jame!")).toEqual([]);
    expect(adjustMentions([entity], "Hi @James!", "Hi @Jaxmes!")).toEqual([]);
    expect(adjustMentions([entity], "Hi @James!", "Hi !")).toEqual([]);
    expect(adjustMentions([entity], "Hi @James!", "Hi ")).toEqual([]);
  });
});

describe("parseMentionSegments / event conversion", () => {
  const content = {
    msgtype: "m.text",
    body: "Hi @James, <x>\nbye",
    format: "org.matrix.custom.html",
    formatted_body: 'Hi <a href="https://matrix.to/#/@james:x">@James</a>, &lt;x&gt;<br>bye <a href="https://matrix.to/#/@mallory:x">@Mallory</a>',
    "m.mentions": { user_ids: ["@james:x", "@me:x"] },
  };
  it("returns structured segments for listed mentions only, with text and line breaks preserved", () => {
    expect(parseMentionSegments(content)).toEqual([
      { text: "Hi " }, { text: "@James", userId: "@james:x" }, { text: ", <x>\nbye @Mallory" },
    ]);
    expect(parseMentionSegments({ ...content, "m.mentions": {} })).toBeUndefined();
    expect(parseMentionSegments({ body: "@James" })).toBeUndefined();
  });
  it("survives history/refresh and flags messages that mention me", () => {
    const ev = new MatrixEvent({ event_id: "$e", room_id: "!r:x", sender: "@alex:x", type: "m.room.message", origin_server_ts: 1, content });
    const msg = messageFromMatrixEvent(ev, "!r:x", "@me:x")!;
    expect(msg.mentionsMe).toBe(true);
    expect(msg.segments?.find((s) => s.userId)?.userId).toBe("@james:x");
    expect(messageFromMatrixEvent(ev, "!r:x", "@other:x")!.mentionsMe).toBeUndefined();
  });
});
