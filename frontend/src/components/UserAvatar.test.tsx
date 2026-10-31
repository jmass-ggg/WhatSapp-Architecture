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

it.each(["unavailable", "unknown", undefined] as const)("shows no dot for %s", (state) => {
  const { container } = renderAvatar(state);
  expect(container.querySelector(".avatar-presence")).toBeNull();
  expect(screen.queryByText("Offline")).toBeNull();
});

it("announces offline to assistive tech without a visible dot", () => {
  const { container } = renderAvatar("offline");
  expect(container.querySelector(".avatar-presence")).toBeNull();
  expect(screen.getByText("Offline").className).toContain("sr-only");
});
