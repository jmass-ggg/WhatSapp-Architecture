import { LoaderCircle, Pause, Play, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { analyzeAudio, type AudioAnalysis } from "../../services/audio/waveform";
import { MAX_ATTACHMENT_BYTES, baseMimeType } from "../../services/matrix/attachments";
import { fetchMatrixMedia } from "../../services/matrix/media";
import type { Attachment } from "../../types";
import { AudioWaveform, formatClock } from "./AudioWaveform";

export { formatClock };

const SPEEDS = [1, 1.5, 2];
const CACHE_LIMIT = 16;
let activeAudio: HTMLAudioElement | null = null;

// Re-mounting a bubble (scrolling, re-render) must not trigger another authenticated download.
const blobCache = new Map<string, Promise<Blob>>();
const analysisCache = new Map<string, Promise<AudioAnalysis | null>>();
export function clearAudioCache() { blobCache.clear(); analysisCache.clear(); }

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key);
  if (!hit) {
    hit = load();
    cache.set(key, hit);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

interface AudioMessagePlayerProps {
  attachment: Attachment;
  matrixToken?: string | null;
}

export function AudioMessagePlayer({ attachment, matrixToken }: AudioMessagePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [source, setSource] = useState<string | null>(attachment.url ?? null);
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(Boolean(attachment.mediaUri && matrixToken));
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFailed(false);
    setPlaying(false);
    setCurrent(0);
    setAnalysis(null);
    if (!attachment.mediaUri || !matrixToken) {
      setSource(attachment.url ?? null);
      setLoading(false);
      if (!attachment.url) return;
      // Already-local audio (e.g. a blob URL): still derive a real waveform from it.
      let live = true;
      fetch(attachment.url).then((r) => r.blob()).then((blob) => analyzeAudio(blob)).then((result) => { if (live) setAnalysis(result); }).catch(() => {});
      return () => { live = false; };
    }
    const uri = attachment.mediaUri;
    let active = true;
    let objectUrl: string | null = null;
    setLoading(true);
    setSource(null);
    if (attempt > 0) { blobCache.delete(uri); analysisCache.delete(uri); }
    cached(blobCache, uri, () => fetchMatrixMedia(matrixToken, uri, MAX_ATTACHMENT_BYTES))
      .then((blob) => {
        if (!active) return;
        // Keep the real container type from the event; never invent one.
        const type = baseMimeType(attachment.mimeType || blob.type);
        objectUrl = URL.createObjectURL(new Blob([blob], type ? { type } : undefined));
        setSource(objectUrl);
        void cached(analysisCache, uri, () => analyzeAudio(blob)).then((result) => { if (active) setAnalysis(result); });
      })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        if (activeAudio === audio) activeAudio = null;
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.mediaUri, attachment.mimeType, attachment.url, matrixToken, attempt]);

  // Decoded duration is authoritative: MediaRecorder WebM often reports Infinity or 0.
  const duration = [analysis?.duration, mediaDuration, (attachment.durationMs ?? 0) / 1000]
    .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0) ?? 0;
  const speed = SPEEDS[speedIndex];

  async function toggle() {
    const audio = audioRef.current;
    if (!audio || !source) return;
    if (!audio.paused) { audio.pause(); return; }
    if (activeAudio && activeAudio !== audio) activeAudio.pause();
    activeAudio = audio;
    audio.playbackRate = speed;
    if (duration && audio.currentTime >= duration - 0.05) audio.currentTime = 0; // replay after completion
    try { await audio.play(); } catch { setFailed(true); }
  }

  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrent(value);
  }

  function cycleSpeed() {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  }

  if (failed) {
    return (
      <div className="audio-player is-failed" role="alert">
        <TriangleAlert size={18} />
        <span>Voice message unavailable</span>
        {attachment.mediaUri && <button type="button" className="audio-speed" onClick={() => setAttempt((n) => n + 1)}>Retry</button>}
      </div>
    );
  }

  const started = playing || current > 0;
  return (
    <div className="audio-player" role="group" aria-label="Voice message">
      <audio
        ref={audioRef}
        src={source ?? undefined}
        preload="metadata"
        onLoadedMetadata={(event) => setMediaDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setMediaDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onSeeked={(event) => setCurrent(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
        onError={() => { if (source) setFailed(true); }}
      />
      <button
        type="button"
        className="audio-play"
        onClick={() => void toggle()}
        disabled={!source}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
      >
        {loading ? <LoaderCircle size={18} className="spin" /> : playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <div className="audio-main">
        <AudioWaveform peaks={analysis?.peaks ?? null} current={current} duration={duration} disabled={!source} label="Seek voice message" onSeek={seek} />
        <span className="audio-time">{started && duration ? `${formatClock(current)} / ${formatClock(duration)}` : formatClock(started ? current : duration)}</span>
      </div>
      <button type="button" className="audio-speed" onClick={cycleSpeed} aria-label={`Playback speed ${speed}×`}>{speed}×</button>
    </div>
  );
}
