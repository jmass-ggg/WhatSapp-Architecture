import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeAudio } from "./waveform";

afterEach(() => vi.unstubAllGlobals());

function stubContext(samples: Float32Array, duration: number, fail = false) {
  const close = vi.fn(async () => {});
  vi.stubGlobal("AudioContext", class {
    decodeAudioData = vi.fn(async () => { if (fail) throw new Error("bad"); return { duration, getChannelData: () => samples }; });
    close = close;
  });
  return close;
}

describe("analyzeAudio", () => {
  it("derives normalised peaks and the decoded duration from real samples", async () => {
    const samples = new Float32Array(480).map((_, i) => (i < 240 ? 0.1 : 0.5));
    const close = stubContext(samples, 4.2);
    const result = await analyzeAudio(new Blob([new Uint8Array(8)]), 4);
    expect(result?.duration).toBe(4.2);
    expect(result?.maxAmplitude).toBeCloseTo(0.5);
    expect(result?.peaks.map((v) => Math.round(v * 10) / 10)).toEqual([0.2, 0.2, 1, 1]);
    expect(close).toHaveBeenCalled();
  });

  it("reports silence and returns null for undecodable or unsupported audio", async () => {
    stubContext(new Float32Array(100), 1);
    expect((await analyzeAudio(new Blob([new Uint8Array(8)])))?.maxAmplitude).toBe(0);
    stubContext(new Float32Array(1), 1, true);
    expect(await analyzeAudio(new Blob([new Uint8Array(8)]))).toBeNull();
    vi.stubGlobal("AudioContext", undefined);
    expect(await analyzeAudio(new Blob([new Uint8Array(8)]))).toBeNull();
  });
});
