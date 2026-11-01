import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { RoomSearchBar } from "./RoomSearchBar";

afterEach(cleanup);

const setup = (over: Partial<Parameters<typeof RoomSearchBar>[0]> = {}) => {
  const props = {
    value: "", onChange: vi.fn(), onClose: vi.fn(), canLoadOlder: true, loadingOlder: false, onLoadOlder: vi.fn(), ...over,
  };
  render(<RoomSearchBar {...props} />);
  return props;
};

it("reports typed text, states it only searches loaded messages, and closes on Escape", () => {
  const props = setup();
  const input = screen.getByLabelText("Search messages in this conversation");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "budget" } });
  expect(props.onChange).toHaveBeenCalledWith("budget");
  expect(screen.getByText("Searches loaded messages only.")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(props.onClose).toHaveBeenCalled();
});

it("offers older history only when more exists and disables it while loading", () => {
  const props = setup();
  fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
  expect(props.onLoadOlder).toHaveBeenCalled();
  cleanup();
  setup({ canLoadOlder: false });
  expect(screen.queryByRole("button", { name: /older/ })).toBeNull();
  cleanup();
  setup({ loadingOlder: true });
  expect((screen.getByRole("button", { name: "Loading…" }) as HTMLButtonElement).disabled).toBe(true);
});
