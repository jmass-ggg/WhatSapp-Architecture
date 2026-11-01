import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ChannelsView } from "./ChannelsView";

afterEach(cleanup);

it("shows an honest empty state with no fabricated channels, counts or admin-only notices", () => {
  render(<ChannelsView />);
  expect(screen.getByText("No organization channels are available to you.")).toBeTruthy();
  expect(screen.queryByText(/Engineering|Finance|subscribers|Only channel admins/i)).toBeNull();
});
