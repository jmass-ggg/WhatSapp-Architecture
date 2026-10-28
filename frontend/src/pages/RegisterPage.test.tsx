import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerMock, signInMock } = vi.hoisted(() => ({
  registerMock: vi.fn(),
  signInMock: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    register: registerMock,
    signIn: signInMock,
  }),
}));

import { RegisterPage } from "./RegisterPage";

function renderRegistrationPage() {
  return render(
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/chat" element={<p>Chat dashboard</p>} />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function completeRegistrationForm() {
  fireEvent.change(screen.getByLabelText("Full name"), {
    target: { value: "Alice Example" },
  });
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "alice@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: "alice_example" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "A sufficiently long password 47" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "A sufficiently long password 47" },
  });
  fireEvent.click(screen.getByLabelText(/I agree to the/));
  fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
}

describe("registration sign-in flow", () => {
  beforeEach(() => {
    registerMock.mockReset();
    signInMock.mockReset();
    registerMock.mockResolvedValue({});
    window.localStorage.clear();
  });

  it("signs the new account in automatically and opens chat", async () => {
    signInMock.mockResolvedValue(undefined);
    renderRegistrationPage();

    completeRegistrationForm();

    await screen.findByText("Chat dashboard");
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith({
      email: "alice@example.test",
      username: "alice_example",
      password: "A sufficiently long password 47",
      display_name: "Alice Example",
    });
    expect(signInMock).toHaveBeenCalledWith({
      login: "alice@example.test",
      password: "A sufficiently long password 47",
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("offers login retry without registering the account again", async () => {
    signInMock
      .mockRejectedValueOnce(new Error("temporary login failure"))
      .mockResolvedValueOnce(undefined);
    renderRegistrationPage();

    completeRegistrationForm();
    const retry = await screen.findByRole("button", { name: "Retry sign in" });
    expect(screen.getByText(/Your account was created/)).toBeTruthy();

    fireEvent.click(retry);
    await screen.findByText("Chat dashboard");

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(signInMock).toHaveBeenCalledTimes(2);
    expect(window.localStorage.length).toBe(0);
  });
});
