import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioMessagePlayer, clearAudioCache } from "./AudioMessagePlayer";
import * as media from "../../services/matrix/media";

const attachment = { name: "Voice message", kind: "audio" as const, mediaUri: "mxc://x/y", mimeType: "audio/webm", durationMs: 12_000 };

beforeEach(() => {
  clearAudioCache();
  vi.spyOn(media, "fetchMatrixMedia").mockResolvedValue(new Blob(["a"], { type: "audio/webm" }));
  URL.createObjectURL = vi.fn(() => "blob:audio");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("play")); return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
});
afterEach(cleanup);

describe("AudioMessagePlayer", () => {
  it("fetches authenticated media, plays, pauses, and shows sender duration", async () => {
    render(<AudioMessagePlayer attachment={attachment} matrixToken="tok" />);
    expect(screen.getByText("0:12")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Play voice message") as HTMLButtonElement).disabled).toBe(false));
    expect(media.fetchMatrixMedia).toHaveBeenCalledWith("tok", "mxc://x/y", expect.any(Number));
    fireEvent.click(screen.getByLabelText("Play voice message"));
    await waitFor(() => screen.getByLabelText("Pause voice message"));
    fireEvent.click(screen.getByLabelText("Pause voice message"));
    await waitFor(() => screen.getByLabelText("Play voice message"));
  });

  it("seeks and reports progress", async () => {
    const { container } = render(<AudioMessagePlayer attachment={attachment} matrixToken="tok" />);
    await waitFor(() => expect((screen.getByLabelText("Seek voice message") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Seek voice message"), { target: { value: "5" } });
    expect(container.querySelector("audio")!.currentTime).toBe(5);
    expect(screen.getByText("0:05 / 0:12")).toBeTruthy();
  });

  it("shows an error with retry when the download fails, and cycles speed", async () => {
    vi.spyOn(media, "fetchMatrixMedia").mockRejectedValueOnce(new Error("boom"));
    render(<AudioMessagePlayer attachment={attachment} matrixToken="tok" />);
    await waitFor(() => screen.getByText("Voice message unavailable"));
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => screen.getByLabelText("Playback speed 1×"));
    fireEvent.click(screen.getByLabelText("Playback speed 1×"));
    expect(screen.getByLabelText("Playback speed 1.5×")).toBeTruthy();
  });

  it("revokes the object URL on unmount", async () => {
    const view = render(<AudioMessagePlayer attachment={attachment} matrixToken="tok" />);
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:audio");
  });

  it("does not download again when the same message remounts", async () => {
    const first = render(<AudioMessagePlayer attachment={attachment} matrixToken="tok" />);
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    first.unmount();
    render(<AudioMessagePlayer attachment={attachment} matrixToken="tok" />);
    await waitFor(() => expect((screen.getByLabelText("Play voice message") as HTMLButtonElement).disabled).toBe(false));
    expect(media.fetchMatrixMedia).toHaveBeenCalledTimes(1);
  });

  it("never shows NaN or Infinity when the container reports an unknown duration", async () => {
    const { container } = render(<AudioMessagePlayer attachment={{ ...attachment, durationMs: undefined }} matrixToken="tok" />);
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, value: Infinity });
    fireEvent(audio, new Event("durationchange"));
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.getByText("0:00")).toBeTruthy();
  });

  it("replays from the start after the message ended", async () => {
    const { container } = render(<AudioMessagePlayer attachment={attachment} matrixToken="tok" />);
    await waitFor(() => expect((screen.getByLabelText("Play voice message") as HTMLButtonElement).disabled).toBe(false));
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "paused", { configurable: true, value: true });
    audio.currentTime = 12;
    fireEvent.click(screen.getByLabelText("Play voice message"));
    expect(audio.currentTime).toBe(0);
  });
});
