import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { PresenceState } from "../types";
import { UserAvatar } from "./UserAvatar";

afterEach(cleanup);

const renderAvatar = (presence?: PresenceState) =>
  render(<UserAvatar name="Alice" initials="A" presence={presence} />);

it("shows an accessible green dot only for online", () => {
  renderAvatar("online");
  expect(screen.getByRole("img", { name: "Online" }).className).toContain("is-online");
});

it("shows an amber Away dot for unavailable (idle)", () => {
  renderAvatar("unavailable");
  expect(screen.getByRole("img", { name: "Away" }).className).toContain("is-away");
});

it("shows a grey Offline dot for offline", () => {
  renderAvatar("offline");
  expect(screen.getByRole("img", { name: "Offline" }).className).toContain("is-offline");
});

it.each(["unknown", undefined] as const)("shows no dot at all for %s: not knowing is not offline", (state) => {
  const { container } = renderAvatar(state);
  expect(container.querySelector(".avatar-presence")).toBeNull();
  expect(screen.queryByRole("img", { name: /Online|Away|Offline/ })).toBeNull();
});
