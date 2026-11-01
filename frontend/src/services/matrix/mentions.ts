export const MATRIX_TO_PREFIX = "https://matrix.to/#/";
const MAX_QUERY = 40;

/** A confirmed mention: a range of the draft that the user picked from the room's member list. */
export interface MentionEntity {
  userId: string;
  label: string;
  start: number;
  end: number;
}

export interface MentionCandidate {
  userId: string;
  name: string;
  avatarUrl?: string | null;
}

export interface MentionTrigger {
  /** Index of the "@" character. */
  start: number;
  query: string;
}

/** Finds an in-progress "@query" ending at the caret; "@" must start the text or follow whitespace (so emails don't trigger). */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const limit = Math.max(0, caret - MAX_QUERY - 1);
  for (let i = caret - 1; i >= limit; i--) {
    const ch = text[i];
    if (ch === "\n") return null;
    if (ch === "@") {
      if (i > 0 && !/\s/.test(text[i - 1])) return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
  }
  return null;
}

export function usernameOf(userId: string): string {
  return userId.replace(/^@/, "").split(":")[0];
}

/** Case-insensitive match on display name or username; prefix matches rank first. */
export function filterMentionCandidates<T extends MentionCandidate>(members: T[], query: string, ownUserId?: string): T[] {
  const q = query.trim().toLowerCase();
  const rank = (m: T): number => {
    if (!q) return 0;
    const name = m.name.toLowerCase();
    const user = usernameOf(m.userId).toLowerCase();
    if (name.startsWith(q) || user.startsWith(q)) return 0;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    return name.includes(q) || user.includes(q) ? 2 : -1;
  };
  return members
    .filter((m) => m.userId !== ownUserId)
    .map((m) => ({ m, r: rank(m) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.m.name.localeCompare(b.m.name))
    .map((x) => x.m);
}

/** Keeps entity positions valid after an edit; entities touched by the edit are dropped. */
export function adjustMentions(mentions: MentionEntity[], oldText: string, newText: string): MentionEntity[] {
  if (!mentions.length || oldText === newText) return mentions;
  const maxPrefix = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (suffix < maxPrefix - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
  const changedEnd = oldText.length - suffix;
  const delta = newText.length - oldText.length;
  const out: MentionEntity[] = [];
  for (const m of mentions) {
    if (m.end <= prefix) out.push(m);
    else if (m.start >= changedEnd) out.push({ ...m, start: m.start + delta, end: m.end + delta });
  }
  return out;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface MentionContent {
  body: string;
  format?: "org.matrix.custom.html";
  formatted_body?: string;
  "m.mentions"?: { user_ids: string[] };
}

/**
 * Builds message content. Only entities whose text still equals the chosen label, that are non-overlapping,
 * and whose user is eligible become mentions; everything else stays plain text.
 */
export function buildMentionContent(
  text: string,
  entities: MentionEntity[],
  eligible: (userId: string) => boolean,
  ownUserId?: string,
): MentionContent {
  const valid: MentionEntity[] = [];
  let cursor = 0;
  for (const e of [...entities].sort((a, b) => a.start - b.start)) {
    if (e.start < cursor || e.end <= e.start || e.end > text.length) continue;
    if (text.slice(e.start, e.end) !== e.label || !eligible(e.userId)) continue;
    valid.push(e);
    cursor = e.end;
  }
  if (!valid.length) return { body: text };
  const plain = (s: string) => escapeHtml(s).replace(/\r?\n/g, "<br>");
  let html = "";
  let pos = 0;
  for (const e of valid) {
    html += plain(text.slice(pos, e.start));
    html += `<a href="${MATRIX_TO_PREFIX}${escapeHtml(e.userId)}">${escapeHtml(e.label)}</a>`;
    pos = e.end;
  }
  html += plain(text.slice(pos));
  const userIds = [...new Set(valid.map((e) => e.userId))].filter((id) => id !== ownUserId);
  return { body: text, format: "org.matrix.custom.html", formatted_body: html, "m.mentions": { user_ids: userIds } };
}

export interface MessageSegment {
  text: string;
  /** Present only for a confirmed mention. */
  userId?: string;
}

/** Structured mention rendering data from an event; never returns HTML. Links only count when also listed in m.mentions. */
export function parseMentionSegments(content: Record<string, unknown>): MessageSegment[] | undefined {
  const mentions = content["m.mentions"] as { user_ids?: unknown } | undefined;
  const ids = Array.isArray(mentions?.user_ids) ? mentions.user_ids.filter((x): x is string => typeof x === "string") : [];
  const html = content.formatted_body;
  if (content.format !== "org.matrix.custom.html" || typeof html !== "string" || typeof DOMParser === "undefined") return undefined;
  const root = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const segments: MessageSegment[] = [];
  const push = (text: string, userId?: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last && !last.userId && !userId) last.text += text;
    else segments.push(userId ? { text, userId } : { text });
  };
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) push(child.textContent ?? "");
      else if (child.nodeType === 1) {
        const el = child as HTMLElement;
        const tag = el.tagName.toLowerCase();
        if (tag === "br") return push("\n");
        const href = tag === "a" ? el.getAttribute("href") ?? "" : "";
        if (href.startsWith(MATRIX_TO_PREFIX)) {
          let userId = "";
          try { userId = decodeURIComponent(href.slice(MATRIX_TO_PREFIX.length).split("?")[0]); } catch { /* malformed link stays plain */ }
          if (userId.startsWith("@") && ids.includes(userId)) return push(el.textContent ?? "", userId);
        }
        walk(el);
      }
    });
  };
  walk(root);
  return segments.some((s) => s.userId) ? segments : undefined;
}
