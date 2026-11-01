export interface AudioAnalysis {
  /** Normalised 0–1 amplitude per bar, derived from the decoded samples. */
  peaks: number[];
  /** Decoded duration in seconds (reliable even when the container reports Infinity). */
  duration: number;
  /** Largest raw sample magnitude (0–1); ~0 means the recording is silent. */
  maxAmplitude: number;
}

type AudioContextCtor = typeof AudioContext;
const contextCtor = (): AudioContextCtor | undefined =>
  typeof window === "undefined" ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;

/** Decodes real audio to measure its amplitude. Returns null when decoding is unavailable or fails. */
export async function analyzeAudio(blob: Blob, bars = 48): Promise<AudioAnalysis | null> {
  const Ctx = contextCtor();
  if (!Ctx || !blob.size) return null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctx();
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buffer.getChannelData(0);
    const block = Math.max(1, Math.floor(data.length / bars));
    const raw: number[] = [];
    let maxAmplitude = 0;
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      for (let j = i * block; j < Math.min(data.length, (i + 1) * block); j++) peak = Math.max(peak, Math.abs(data[j]));
      raw.push(peak);
      maxAmplitude = Math.max(maxAmplitude, peak);
    }
    const scale = maxAmplitude > 0 ? 1 / maxAmplitude : 0;
    return { peaks: raw.map((v) => v * scale), duration: buffer.duration, maxAmplitude };
  } catch {
    return null;
  } finally {
    void ctx?.close().catch(() => {});
  }
}
