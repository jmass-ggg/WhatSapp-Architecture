interface AudioWaveformProps {
  /** Real amplitude peaks; when absent a plain progress track is shown (never a fabricated waveform). */
  peaks: number[] | null;
  current: number;
  duration: number;
  disabled?: boolean;
  label: string;
  onSeek: (seconds: number) => void;
}

export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Seekable waveform / progress track. A native range input sits on top for pointer, touch and keyboard seeking. */
export function AudioWaveform({ peaks, current, duration, disabled, label, onSeek }: AudioWaveformProps) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeCurrent = Math.min(Math.max(Number.isFinite(current) ? current : 0, 0), safeDuration);
  const ratio = safeDuration ? safeCurrent / safeDuration : 0;
  return (
    <div className="audio-wave">
      {peaks ? (
        <div className="audio-wave-bars" aria-hidden="true">
          {peaks.map((peak, index) => (
            <span key={index} className={(index + 0.5) / peaks.length <= ratio ? "is-played" : undefined} style={{ height: `${Math.max(12, Math.round(peak * 100))}%` }} />
          ))}
        </div>
      ) : (
        <div className="audio-wave-track" aria-hidden="true"><span style={{ width: `${ratio * 100}%` }} /></div>
      )}
      <input
        type="range"
        className="audio-progress"
        min={0}
        max={safeDuration || 1}
        step={0.1}
        value={safeCurrent}
        disabled={disabled || !safeDuration}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label={label}
        aria-valuetext={`${formatClock(safeCurrent)} of ${formatClock(safeDuration)}`}
      />
    </div>
  );
}
