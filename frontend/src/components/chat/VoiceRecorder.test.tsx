import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageComposer } from "./MessageComposer";
import { VoiceRecorder } from "./VoiceRecorder";

const HEADER = [0x1a, 0x45, 0xdf, 0xa3];
const track = { stop: vi.fn() };
let recorders: FakeRecorder[] = [];
let events: string[] = [];

class FakeRecorder {
  static isTypeSupported = vi.fn((t: string) => t === "audio/webm;codecs=opus");
  state = "inactive"; mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null; onerror: (() => void) | null = null;
  emit = true; chunkSize = 16;
  constructor(_s: unknown, o?: { mimeType?: string }) { this.mimeType = o?.mimeType ?? ""; recorders.push(this); }
  start() { this.state = "recording"; }
  pause() { this.state = "paused"; events.push("pause"); }
  resume() { this.state = "recording"; events.push("resume"); }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    // Real MediaRecorder delivers the final chunk before 'stop'; the mic must stay live until then.
    if (this.emit) this.ondataavailable?.({ data: new Blob([new Uint8Array([...HEADER, ...new Array(Math.max(0, this.chunkSize - 4)).fill(1)])]) });
    events.push(`stop:tracksStopped=${track.stop.mock.calls.length}`);
    this.onstop?.();
  }
}

function mockMic(impl?: () => Promise<unknown>) {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(impl ?? (async () => ({ getTracks: () => [track] }))) } });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const mount = (props = {}) => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const view = render(<VoiceRecorder onSend={onSend} onClose={onClose} {...props} />);
  return { onSend, onClose, ...view };
};
async function review() {
  await waitFor(() => screen.getByLabelText("Pause recording"));
  fireEvent.click(screen.getByLabelText("Pause recording"));
  fireEvent.click(screen.getByLabelText("Stop and review recording"));
  await waitFor(() => screen.getByLabelText("Play preview"));
}

beforeEach(() => {
  recorders = []; events = []; track.stop.mockClear();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  FakeRecorder.isTypeSupported.mockImplementation((t: string) => t === "audio/webm;codecs=opus");
  mockMic();
  URL.createObjectURL = vi.fn(() => "blob:p"); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("VoiceRecorder", () => {
  it("requests mono voice audio and records with the preferred supported format", async () => {
    mount();
    await waitFor(() => expect(recorders.length).toBe(1));
    expect(recorders[0].mimeType).toBe("audio/webm;codecs=opus");
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ channelCount: 1, echoCancellation: true }) });
  });

  it("shows the timer, previews, and sends the finalized recording", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { onSend, onClose } = mount();
    await flush();
    act(() => { vi.advanceTimersByTime(3100); });
    expect(screen.getByLabelText("Recording time").textContent).toBe("0:03");
    fireEvent.click(screen.getByLabelText("Pause recording"));
    fireEvent.click(screen.getByLabelText("Stop and review recording"));
    await flush();
    expect(screen.getByLabelText("Play preview")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByLabelText("Send voice message")); });
    const [rec] = onSend.mock.calls[0];
    expect(rec.durationMs).toBe(3100);
    expect(rec.blob.size).toBe(16);
    expect(onClose).toHaveBeenCalled();
  });

  it("collects the final chunk before the microphone is released", async () => {
    mount();
    await review();
    expect(events.at(-1)).toBe("stop:tracksStopped=0");
    expect(track.stop).toHaveBeenCalled();
  });

  it("pause freezes the timer, resume continues it, and paused time is excluded from duration", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { onSend } = mount();
    await flush();
    act(() => { vi.advanceTimersByTime(2000); });
    fireEvent.click(screen.getByLabelText("Pause recording"));
    expect(recorders[0].state).toBe("paused");
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByLabelText("Recording time").textContent).toBe("0:02");
    fireEvent.click(screen.getByLabelText("Resume recording"));
    expect(recorders[0].state).toBe("recording");
    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.click(screen.getByLabelText("Send voice message")); // stop, finalize, then send
    await flush();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].durationMs).toBe(3000);
  });

  it("explains denied permission and unavailable microphone", async () => {
    mockMic(async () => { throw new DOMException("no", "NotAllowedError"); });
    mount();
    await waitFor(() => screen.getByText(/Microphone access was denied/));
    cleanup();
    mockMic(async () => { throw new DOMException("no", "NotFoundError"); });
    mount();
    await waitFor(() => screen.getByText(/No microphone was found/));
  });

  it("shows a clear message when MediaRecorder is unsupported", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    mount();
    await waitFor(() => screen.getByText(/not supported in this browser/));
  });

  it("falls back to the browser default format when no preferred type is supported", async () => {
    FakeRecorder.isTypeSupported.mockReturnValue(false);
    mount();
    await waitFor(() => expect(recorders.length).toBe(1));
    expect(recorders[0].mimeType).toBe("");
  });

  it("discard releases the microphone, closes, and never sends", async () => {
    const { onSend, onClose } = mount();
    await waitFor(() => screen.getByLabelText("Pause recording"));
    fireEvent.click(screen.getByLabelText("Discard recording"));
    expect(track.stop).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("unmounting stops the recorder and releases the microphone", async () => {
    const view = mount();
    await waitFor(() => screen.getByLabelText("Pause recording"));
    view.unmount();
    expect(recorders[0].state).toBe("inactive");
    expect(track.stop).toHaveBeenCalled();
  });

  it("rejects zero-byte recordings", async () => {
    mount();
    await waitFor(() => screen.getByLabelText("Pause recording"));
    recorders[0].emit = false;
    fireEvent.click(screen.getByLabelText("Pause recording"));
    fireEvent.click(screen.getByLabelText("Stop and review recording"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Nothing was recorded/));
  });

  it("rejects data that is not valid audio for its declared format", async () => {
    mount();
    await waitFor(() => screen.getByLabelText("Pause recording"));
    recorders[0].emit = false;
    act(() => { recorders[0].ondataavailable?.({ data: new Blob([new Uint8Array(20)]) }); });
    fireEvent.click(screen.getByLabelText("Pause recording"));
    fireEvent.click(screen.getByLabelText("Stop and review recording"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/does not match/));
  });

  it("record again starts a fresh recording and revokes the old preview URL", async () => {
    mount();
    await review();
    fireEvent.click(screen.getByLabelText("Record again"));
    await waitFor(() => expect(recorders.length).toBe(2));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:p");
    await waitFor(() => screen.getByLabelText("Pause recording"));
  });

  it("stops automatically at the maximum duration", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    mount({ maxDurationMs: 2000 });
    await flush();
    act(() => { vi.advanceTimersByTime(2300); });
    await flush();
    expect(screen.getByLabelText("Play preview")).toBeTruthy();
    expect(screen.getByText("Maximum recording length reached.")).toBeTruthy();
  });

  it("stops automatically near the maximum size", async () => {
    mount({ maxBytes: 40 });
    await waitFor(() => screen.getByLabelText("Pause recording"));
    recorders[0].chunkSize = 4;
    act(() => { recorders[0].ondataavailable?.({ data: new Blob([new Uint8Array([...HEADER, ...new Array(32).fill(1)])]) }); });
    await waitFor(() => screen.getByText("Maximum recording size reached."));
  });

  it("keeps the recording after a failed send, blocks duplicate sends, and allows retry", async () => {
    let reject!: (e: Error) => void;
    const onSend = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_, r) => { reject = r; }))
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<VoiceRecorder onSend={onSend} onClose={onClose} />);
    await review();
    const send = screen.getByLabelText("Send voice message");
    fireEvent.click(send); fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error("Upload failed")); });
    expect(screen.getByRole("alert").textContent).toMatch(/Upload failed/);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Play preview")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByLabelText("Retry sending voice message")); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[0][1]).toBe(onSend.mock.calls[1][1]); // same attempt state
    expect(onClose).toHaveBeenCalled();
  });
});

describe("MessageComposer voice integration", () => {
  it("hides the mic without a voice handler and disables it without permission", () => {
    const { rerender } = render(<MessageComposer onSend={vi.fn()} />);
    expect(screen.queryByLabelText("Record a voice message")).toBeNull();
    rerender(<MessageComposer onSend={vi.fn()} onSendVoice={vi.fn()} disabled />);
    expect((screen.getByLabelText("Record a voice message") as HTMLButtonElement).disabled).toBe(true);
  });

  it("swaps the composer for the recording bar, preserves the draft, and restores it on discard", async () => {
    render(<MessageComposer onSend={vi.fn()} onSendVoice={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Write a message"), { target: { value: "draft" } });
    fireEvent.click(screen.getByLabelText("Record a voice message"));
    await waitFor(() => screen.getByLabelText("Pause recording"));
    expect(screen.queryByLabelText("Write a message")).toBeNull(); // no duplicate composer under the bar
    fireEvent.click(screen.getByLabelText("Discard recording"));
    expect((screen.getByLabelText("Write a message") as HTMLTextAreaElement).value).toBe("draft");
  });
});
