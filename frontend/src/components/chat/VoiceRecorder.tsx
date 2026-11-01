import { LoaderCircle, Mic, Pause, Play, RotateCcw, SendHorizontal, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { analyzeAudio, type AudioAnalysis } from "../../services/audio/waveform";
import {
  MAX_ATTACHMENT_BYTES, MAX_VOICE_DURATION_MS, VOICE_RECORDING_TYPES, validateVoiceRecording,
  type VoiceRecording, type VoiceSendAttempt,
} from "../../services/matrix/attachments";
import { AudioWaveform, formatClock } from "./AudioWaveform";

type Phase = "starting" | "recording" | "paused" | "processing" | "ready" | "error";

export function pickRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return VOICE_RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
}

export function voiceRecordingSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

interface VoiceRecorderProps {
  /** Resolves when Synapse acknowledged the message; rejects to keep the recording for a retry. */
  onSend: (recording: VoiceRecording, attempt: VoiceSendAttempt) => Promise<void>;
  onClose: () => void;
  status?: string;
  maxDurationMs?: number;
  maxBytes?: number;
}

function permissionMessage(cause: unknown): string {
  const name = (cause as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied. Allow it in your browser settings and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this device.";
  if (name === "NotReadableError") return "The microphone is in use by another application.";
  return "The microphone could not be started.";
}

const BAR = 3;
const GAP = 2;

export function VoiceRecorder({ onSend, onClose, status, maxDurationMs = MAX_VOICE_DURATION_MS, maxBytes = MAX_ATTACHMENT_BYTES }: VoiceRecorderProps) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [sending, setSending] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  // Elapsed time excludes paused periods: banked time + the running segment.
  const bankedMs = useRef(0);
  const segmentStart = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const barsRef = useRef<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cancelledRef = useRef(false);
  // Bumped on every start() and on unmount; async work from an older session must never touch shared state.
  const sessionRef = useRef(0);
  const stopReasonRef = useRef("");
  const sendAfterStopRef = useRef(false);
  const sendingRef = useRef(false);
  const attemptRef = useRef<VoiceSendAttempt>({});
  const audioRef = useRef<HTMLAudioElement>(null);
  const sendRef = useRef<(rec: VoiceRecording) => Promise<void>>(async () => {});

  const elapsedMs = () => bankedMs.current + (segmentStart.current === null ? 0 : Date.now() - segmentStart.current);
  const bankElapsed = () => {
    if (segmentStart.current !== null) bankedMs.current += Date.now() - segmentStart.current;
    segmentStart.current = null;
  };

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx2d = canvas?.getContext?.("2d");
    if (!canvas || !ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, width, height);
    const fits = Math.max(1, Math.floor(width / (BAR + GAP)));
    const bars = barsRef.current.slice(-fits);
    const accent = getComputedStyle(canvas).getPropertyValue("--blue").trim() || "#2457f5";
    for (let i = 0; i < fits; i++) {
      const value = bars[bars.length - fits + i]; // newest bar on the right
      const h = Math.max(3, (value ?? 0) * height);
      ctx2d.fillStyle = value === undefined ? "rgba(36, 87, 245, 0.18)" : accent;
      ctx2d.beginPath();
      ctx2d.roundRect ? ctx2d.roundRect(i * (BAR + GAP), (height - h) / 2, BAR, h, 1.5) : ctx2d.rect(i * (BAR + GAP), (height - h) / 2, BAR, h);
      ctx2d.fill();
    }
  }, []);

  // Real microphone amplitude via AnalyserNode; drawn straight to a canvas so React never rerenders per frame.
  const startLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser || rafRef.current !== null) return;
    const data = new Uint8Array(analyser.fftSize);
    let last = 0;
    const frame = (now: number) => {
      if (now - last >= 50) {
        last = now;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        barsRef.current.push(Math.min(1, Math.sqrt(sum / data.length) * 3));
        if (barsRef.current.length > 400) barsRef.current.splice(0, 200);
        draw();
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [draw]);

  const releaseMic = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    stopLoop();
    analyserRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [stopLoop]);

  const finalize = useCallback(async (blob: Blob, type: string, fallbackMs: number) => {
    const analyzed = await analyzeAudio(blob);
    if (cancelledRef.current) return;
    const durationMs = analyzed && analyzed.duration > 0 ? Math.round(analyzed.duration * 1000) : fallbackMs;
    const rec: VoiceRecording = { blob, mimeType: type, durationMs: Math.max(1, Math.min(durationMs, maxDurationMs + 1000)) };
    try {
      await validateVoiceRecording(rec);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The recording is invalid.");
      setPhase("error");
      return;
    }
    if (analyzed && analyzed.maxAmplitude < 0.005) setNotice("This recording sounds silent. Check that the right microphone is selected and unmuted.");
    setAnalysis(analyzed);
    setRecording(rec);
    setPhase("ready");
    if (sendAfterStopRef.current) { sendAfterStopRef.current = false; void sendRef.current(rec); }
  }, [maxDurationMs]);

  const start = useCallback(async () => {
    const session = ++sessionRef.current;
    const stale = () => sessionRef.current !== session || cancelledRef.current;
    cancelledRef.current = false;
    stopReasonRef.current = "";
    sendAfterStopRef.current = false;
    chunksRef.current = [];
    bytesRef.current = 0;
    bankedMs.current = 0;
    segmentStart.current = null;
    barsRef.current = [];
    attemptRef.current = {};
    setError(""); setNotice(""); setElapsedSec(0); setRecording(null); setAnalysis(null);
    setPhase("starting");
    if (!voiceRecordingSupported()) {
      setError("Voice messages are not supported in this browser. Try a current version of Chrome, Edge, Firefox or Safari over HTTPS.");
      setPhase("error");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (cause) {
      if (stale()) return;
      setError(permissionMessage(cause));
      setPhase("error");
      return;
    }
    if (stale()) { stream.getTracks().forEach((track) => track.stop()); return; }
    streamRef.current = stream;

    let recorder: MediaRecorder;
    try {
      const mimeType = pickRecordingMimeType();
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      releaseMic();
      setError("This browser could not start an audio recorder.");
      setPhase("error");
      return;
    }
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (sessionRef.current !== session || !event.data.size) return;
      chunksRef.current.push(event.data);
      bytesRef.current += event.data.size;
      // Stop with headroom: the final chunk delivered by stop() must still fit under the limit.
      if (bytesRef.current >= maxBytes * 0.9 && recorder.state !== "inactive") {
        stopReasonRef.current = "size";
        recorder.stop();
      }
    };
    recorder.onerror = () => {
      if (sessionRef.current !== session) return;
      stopReasonRef.current = "error";
      releaseMic();
      setError("Recording failed. Please try again.");
      setPhase("error");
    };
    // 'stop' fires only after the final dataavailable, so the microphone is released here, not before.
    recorder.onstop = () => {
      if (sessionRef.current !== session) { stream.getTracks().forEach((track) => track.stop()); return; }
      const reason = stopReasonRef.current;
      bankElapsed();
      const fallbackMs = Math.min(bankedMs.current, maxDurationMs);
      releaseMic();
      if (cancelledRef.current || reason === "error") return;
      const type = recorder.mimeType || pickRecordingMimeType() || "";
      const blob = new Blob(chunksRef.current, type ? { type } : undefined);
      chunksRef.current = [];
      if (!blob.size) { setError("Nothing was recorded. Check your microphone and try again."); setPhase("error"); return; }
      if (blob.size > maxBytes) { setError("The recording is too large to send."); setPhase("error"); return; }
      if (reason === "duration") setNotice("Maximum recording length reached.");
      if (reason === "size") setNotice("Maximum recording size reached.");
      void finalize(blob, type, fallbackMs);
    };

    try {
      const Ctx = window.AudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        ctx.createMediaStreamSource(stream).connect(analyser);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        void ctx.resume?.();
      }
    } catch { /* the waveform is optional; recording continues without it */ }

    recorder.start(1000);
    segmentStart.current = Date.now();
    setPhase("recording");
    startLoop();
    tickRef.current = setInterval(() => {
      const elapsed = elapsedMs();
      setElapsedSec((prev) => (Math.floor(elapsed / 1000) === prev ? prev : Math.floor(elapsed / 1000)));
      if (elapsed >= maxDurationMs && recorder.state === "recording") {
        stopReasonRef.current = "duration";
        setPhase("processing");
        recorder.stop();
      }
    }, 200);
  }, [finalize, maxBytes, maxDurationMs, releaseMic, startLoop]);

  useEffect(() => {
    void start();
    return () => {
      cancelledRef.current = true;
      sessionRef.current++;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      releaseMic();
    };
  }, [start, releaseMic]);

  useEffect(() => {
    if (!recording) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(recording.blob);
    setPreviewUrl(url);
    setPreviewPlaying(false);
    setPreviewTime(0);
    return () => URL.revokeObjectURL(url);
  }, [recording]);

  function pause() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.pause();
    bankElapsed();
    stopLoop();
    setElapsedSec(Math.floor(bankedMs.current / 1000));
    setPhase("paused");
  }

  function resume() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    recorder.resume();
    segmentStart.current = Date.now();
    void audioCtxRef.current?.resume?.();
    setPhase("recording");
    startLoop();
  }

  /** Stops capture; the recording becomes ready once the final chunk has been collected. */
  function stopRecording(thenSend = false) {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    sendAfterStopRef.current = thenSend;
    setPhase("processing");
    recorder.stop();
  }

  function discard() {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseMic();
    audioRef.current?.pause();
    onClose();
  }

  function recordAgain() {
    if (sendingRef.current) return;
    audioRef.current?.pause();
    void start();
  }

  async function send(rec: VoiceRecording | null = recording) {
    if (!rec || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    audioRef.current?.pause();
    try {
      await onSend(rec, attemptRef.current);
      sendingRef.current = false;
      setSending(false);
      onClose();
    } catch (cause) {
      sendingRef.current = false;
      setSending(false);
      setError(cause instanceof Error ? cause.message : "Upload failed. Try again.");
    }
  }
  sendRef.current = send;

  async function togglePreview() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (recording && audio.currentTime >= recording.durationMs / 1000 - 0.05) audio.currentTime = 0;
      try { await audio.play(); } catch { setError("The recording could not be played."); }
    } else audio.pause();
  }

  const live = phase === "recording" || phase === "paused";
  const totalSec = (recording?.durationMs ?? 0) / 1000;

  return (
    <div className={`voice-bar is-${phase}`} role="group" aria-label="Voice message recorder">
      <span className="sr-only" role="status" aria-live="polite">
        {phase === "recording" ? "Recording" : phase === "paused" ? "Recording paused" : phase === "processing" ? "Finishing recording" : phase === "ready" ? "Recording ready to review" : ""}
      </span>

      {phase === "starting" && <p className="voice-status"><LoaderCircle size={16} className="spin" /> Waiting for microphone…</p>}

      {live && (
        <>
          <button type="button" className="voice-btn" onClick={discard} aria-label="Discard recording"><Trash2 size={19} /></button>
          <span className={`voice-dot${phase === "paused" ? " is-paused" : ""}`} aria-hidden="true" />
          <strong className="voice-timer" aria-label="Recording time">{formatClock(elapsedSec)}</strong>
          {analyserRef.current ? <canvas ref={canvasRef} className="voice-canvas" aria-hidden="true" /> : <span className="voice-canvas voice-canvas-off" aria-hidden="true" />}
          {phase === "recording"
            ? <button type="button" className="voice-btn" onClick={pause} aria-label="Pause recording"><Pause size={18} fill="currentColor" /></button>
            : <>
                <button type="button" className="voice-btn" onClick={resume} aria-label="Resume recording"><Mic size={18} /></button>
                <button type="button" className="voice-btn" onClick={() => stopRecording()} aria-label="Stop and review recording"><Square size={15} fill="currentColor" /></button>
              </>}
          <button type="button" className="voice-btn is-send" onClick={() => stopRecording(true)} aria-label="Send voice message"><SendHorizontal size={20} /></button>
        </>
      )}

      {phase === "processing" && <p className="voice-status"><LoaderCircle size={16} className="spin" /> Finishing recording…</p>}

      {phase === "ready" && recording && (
        <>
          <audio
            ref={audioRef}
            src={previewUrl ?? undefined}
            preload="metadata"
            onPlay={() => setPreviewPlaying(true)}
            onPause={() => setPreviewPlaying(false)}
            onEnded={() => { setPreviewPlaying(false); setPreviewTime(0); }}
            onTimeUpdate={(event) => setPreviewTime(event.currentTarget.currentTime)}
            onSeeked={(event) => setPreviewTime(event.currentTarget.currentTime)}
          />
          <button type="button" className="voice-btn" onClick={discard} disabled={sending} aria-label="Delete recording"><Trash2 size={19} /></button>
          <button type="button" className="voice-btn is-play" onClick={() => void togglePreview()} aria-label={previewPlaying ? "Pause preview" : "Play preview"}>
            {previewPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <AudioWaveform
            peaks={analysis?.peaks ?? null}
            current={previewTime}
            duration={totalSec}
            label="Preview progress"
            onSeek={(value) => { if (audioRef.current) audioRef.current.currentTime = value; setPreviewTime(value); }}
          />
          <span className="audio-time">{formatClock(previewTime)} / {formatClock(totalSec)}</span>
          <button type="button" className="voice-btn" onClick={recordAgain} disabled={sending} aria-label="Record again"><RotateCcw size={18} /></button>
          <button type="button" className="voice-btn is-send" onClick={() => void send()} disabled={sending} aria-label={error ? "Retry sending voice message" : "Send voice message"}>
            {sending ? <LoaderCircle size={19} className="spin" /> : <SendHorizontal size={20} />}
          </button>
        </>
      )}

      {phase === "error" && (
        <>
          <Mic size={18} />
          <span className="voice-error" role="alert">{error}</span>
          <button type="button" className="voice-btn" onClick={() => void start()} aria-label="Try recording again"><RotateCcw size={18} /></button>
          <button type="button" className="voice-btn" onClick={discard} aria-label="Close voice recorder"><Trash2 size={19} /></button>
        </>
      )}

      {phase === "ready" && (error || notice || (sending && status)) && (
        <p className={`voice-note${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
          {error ? `${error} Your recording is kept — use send to retry.` : sending && status ? status : notice}
        </p>
      )}
    </div>
  );
}
