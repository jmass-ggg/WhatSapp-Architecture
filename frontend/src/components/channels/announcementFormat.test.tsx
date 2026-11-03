import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { renderAnnouncementBody } from "./announcementFormat";

afterEach(cleanup);

it("renders paragraphs, bullet lists, bold and links without interpreting HTML", () => {
  const text = "Deployed **v2.4** to prod <script>alert(1)</script>\n\n- Faster\n- Safer\n\nNotes: https://example.com/notes.";
  const { container } = render(<div>{renderAnnouncementBody(text)}</div>);
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("<script>alert(1)</script>");
  expect(container.querySelector("strong")?.textContent).toBe("v2.4");
  expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Faster", "Safer"]);
  const link = container.querySelector("a");
  expect(link?.getAttribute("href")).toBe("https://example.com/notes");
  expect(link?.getAttribute("rel")).toContain("noopener");
  expect(container.querySelectorAll("p")).toHaveLength(2);
});

it("splits a sentence followed by bullet lines into a paragraph and a list", () => {
  const { container } = render(<div>{renderAnnouncementBody("Key updates:\n- ✅ Faster\n- ✅ Safer\nThanks all")}</div>);
  expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Key updates:", "Thanks all"]);
  expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["✅ Faster", "✅ Safer"]);
});

it("never links javascript: or unknown schemes", () => {
  const { container } = render(<div>{renderAnnouncementBody("javascript:alert(1) and ftp://x.y/z")}</div>);
  expect(container.querySelector("a")).toBeNull();
});
