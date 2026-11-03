import type { ReactNode } from "react";

import { extractUrls } from "../../services/matrix/sharedContent";

const LIST_PREFIX = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** Inline formatting: **bold** and auto-linked http(s) URLs. Everything is plain React nodes. */
export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const urls = new Set(extractUrls(text));
  const pattern = /\*\*([^*\n]+)\*\*|https?:\/\/[^\s<>"']+/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const raw = match[0];
    if (match[1]) {
      nodes.push(<strong key={`${keyPrefix}-b${index++}`}>{match[1]}</strong>);
    } else {
      const trimmed = raw.replace(/[).,;:!?\]]+$/, "");
      const trailing = raw.slice(trimmed.length);
      if (urls.has(trimmed) || urls.has(`${trimmed}/`)) {
        nodes.push(
          <a key={`${keyPrefix}-l${index++}`} href={trimmed} target="_blank" rel="noopener noreferrer nofollow">
            {trimmed}
          </a>,
        );
      } else {
        nodes.push(trimmed);
      }
      if (trailing) nodes.push(trailing);
    }
    last = start + raw.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Renders announcement text as paragraphs and bullet lists without ever interpreting HTML.
 * Supported: blank-line paragraphs, lines starting with "-", "*", "•" or "1." as list items,
 * **bold**, and http(s) links.
 */
export function renderAnnouncementBody(text: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const lines = paragraph.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) return;
    // Consecutive list lines form one list; the surrounding lines form paragraphs, so a
    // sentence followed by bullet lines renders as text plus a list.
    let run: { list: boolean; lines: string[] } | null = null;
    const runs: { list: boolean; lines: string[] }[] = [];
    for (const line of lines) {
      const list = LIST_PREFIX.test(line);
      if (!run || run.list !== list) {
        run = { list, lines: [] };
        runs.push(run);
      }
      run.lines.push(line);
    }
    runs.forEach((group, runIndex) => {
      const key = `p${paragraphIndex}-${runIndex}`;
      if (group.list) {
        blocks.push(
          <ul key={key} className="announcement-list">
            {group.lines.map((line, lineIndex) => (
              <li key={`${key}-${lineIndex}`}>{renderInline(line.replace(LIST_PREFIX, ""), `${key}-${lineIndex}`)}</li>
            ))}
          </ul>,
        );
        return;
      }
      blocks.push(
        <p key={key}>
          {group.lines.map((line, lineIndex) => (
            <span key={`${key}-${lineIndex}`}>
              {lineIndex > 0 && <br />}
              {renderInline(line, `${key}-${lineIndex}`)}
            </span>
          ))}
        </p>,
      );
    });
  });
  return blocks;
}
