import type { MatrixClient } from "matrix-js-sdk";

export const STARRED_EVENT_TYPE = "com.recruitable.starred_messages";
const MAX_STARRED = 500;

export interface StarredRef {
  roomId: string;
  eventId: string;
}

/** Normalizes untrusted account-data content into a list of valid references. */
export function parseStarred(content: unknown): StarredRef[] {
  const raw = (content as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: StarredRef[] = [];
  for (const item of raw) {
    const { roomId, eventId } = (item ?? {}) as Partial<StarredRef>;
    if (typeof roomId !== "string" || typeof eventId !== "string" || !roomId || !eventId) continue;
    const key = `${roomId}|${eventId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ roomId, eventId });
  }
  return result;
}

export function toggleStarred(current: StarredRef[], ref: StarredRef): StarredRef[] {
  const exists = current.some((item) => item.roomId === ref.roomId && item.eventId === ref.eventId);
  if (exists) return current.filter((item) => !(item.roomId === ref.roomId && item.eventId === ref.eventId));
  return [...current, ref].slice(-MAX_STARRED);
}

export function readStarred(client: Pick<MatrixClient, "getAccountData">): StarredRef[] {
  return parseStarred(client.getAccountData(STARRED_EVENT_TYPE as never)?.getContent());
}

export async function writeStarred(
  client: Pick<MatrixClient, "setAccountData">,
  refs: StarredRef[],
): Promise<void> {
  await client.setAccountData(STARRED_EVENT_TYPE as never, { messages: refs } as never);
}
