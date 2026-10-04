import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loop {
  start: number;
  end: number;
  /** 0.5 to 2. The mix keeps the pitch; this browser preview does not. */
  speed?: number;
}

const MIN_LOOP_S = 2;
const BUCKETS = 600;

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * Pick the section of a track that repeats under an episode.
 *
 * The track is drawn as a waveform; drag the start and end bars, play the
 * selection on loop to hear the join, and save it as the track's default if
 * you want every episode to use it. In the browser the preview loop is a hard
 * cut; the real mix blends the end into the start over half a second.
 */
export const Trimmer = ({
  src,
  value,
  onChange,
  disabled,
}: {
  src: string;
  /** The selected section; null means the whole track. */
  value: Loop | null;
  onChange: (loop: Loop) => void;
  disabled?: boolean;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [drag, setDrag] = useState<'start' | 'end' | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const buffer = useRef<AudioBuffer | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);

  const loop: Loop = value ?? { start: 0, end: duration };
  const speed = value?.speed ?? 1;
  // Every change carries the speed along, so moving a bar never resets it.
  const emit = (next: Loop) => onChange(speed !== 1 ? { ...next, speed } : { start: next.start, end: next.end });

  // Decode once per track and reduce it to a few hundred peaks to draw.
  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setError(null);
    (async () => {
      const res = await fetch(src);
      const data = await res.arrayBuffer();
      ctx.current ??= new AudioContext();
      const audio = await ctx.current.decodeAudioData(data);
      if (cancelled) return;
      buffer.current = audio;
      const ch = audio.getChannelData(0);
      const step = Math.max(1, Math.floor(ch.length / BUCKETS));
      const out: number[] = [];
      for (let i = 0; i < BUCKETS; i++) {
        let max = 0;
        for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j++) max = Math.max(max, Math.abs(ch[j]!));
        out.push(max);
      }
      setDuration(audio.duration);
      setPeaks(out);
    })().catch((e) => !cancelled && setError(`could not read the track: ${(e as Error).message}`));
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Draw: the waveform, the unselected parts dimmed, two bars.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !peaks || !duration) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    const x0 = (loop.start / duration) * w;
    const x1 = (loop.end / duration) * w;
    const bw = w / peaks.length;
    peaks.forEach((p, i) => {
      const x = i * bw;
      const inside = x >= x0 && x <= x1;
      g.fillStyle = inside ? '#5fb3ff' : '#2a3554';
      const bh = Math.max(1, p * h * 0.92);
      g.fillRect(x, (h - bh) / 2, Math.max(1, bw - 1), bh);
    });
    g.fillStyle = '#ffffff';
    g.fillRect(x0 - devicePixelRatio, 0, 2 * devicePixelRatio, h);
    g.fillRect(x1 - devicePixelRatio, 0, 2 * devicePixelRatio, h);
  }, [peaks, duration, loop.start, loop.end]);

  const stop = useCallback(() => {
    try {
      source.current?.stop();
    } catch {
      // Already stopped.
    }
    source.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stop, [stop, src]);

  const play = () => {
    if (!ctx.current || !buffer.current) return;
    stop();
    const node = ctx.current.createBufferSource();
    node.buffer = buffer.current;
    node.loop = true;
    node.loopStart = loop.start;
    node.loopEnd = loop.end;
    node.playbackRate.value = speed;
    node.connect(ctx.current.destination);
    void ctx.current.resume();
    node.start(0, loop.start);
    source.current = node;
    setPlaying(true);
  };

  // Restart the preview when the selection moves, so you hear the new join.
  useEffect(() => {
    if (playing && !drag) play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loop.start, loop.end, speed, drag]);

  const timeAt = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };

  const onDown = (e: React.PointerEvent) => {
    if (disabled || !duration) return;
    const t = timeAt(e.clientX);
    // Grab whichever bar is nearer.
    const which = Math.abs(t - loop.start) <= Math.abs(t - loop.end) ? 'start' : 'end';
    setDrag(which);
    (e.target as Element).setPointerCapture(e.pointerId);
    move(which, t);
  };

  const move = (which: 'start' | 'end', t: number) => {
    if (which === 'start') emit({ start: Math.min(t, loop.end - MIN_LOOP_S), end: loop.end });
    else emit({ start: loop.start, end: Math.max(t, loop.start + MIN_LOOP_S) });
  };

  if (error) return <span className="fail tiny">{error}</span>;
  if (!peaks) return <span className="faint tiny">Reading the track...</span>;

  return (
    <div className="stack tight">
      <canvas
        ref={canvas}
        className="trimmer"
        onPointerDown={onDown}
        onPointerMove={(e) => drag && move(drag, timeAt(e.clientX))}
        onPointerUp={() => setDrag(null)}
        aria-label="Drag the start and end bars to choose the section that repeats"
      />
      <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="mono tiny">
          {fmt(loop.start)} to {fmt(loop.end)} · {(loop.end - loop.start).toFixed(1)}s of the track
        </span>
        <button className="btn small" disabled={disabled} onClick={playing ? stop : play}>
          {playing ? 'Stop' : 'Play selection on loop'}
        </button>
        <button
          className="btn ghost small"
          disabled={disabled || (loop.start === 0 && loop.end === duration)}
          onClick={() => emit({ start: 0, end: duration })}
        >
          Whole track
        </button>
      </div>
      <label className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
        <span style={{ minWidth: '9rem' }}>Speed {speed.toFixed(2)}x</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={speed}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange(v !== 1 ? { start: loop.start, end: loop.end, speed: v } : { start: loop.start, end: loop.end });
          }}
          style={{ flex: 1 }}
        />
        <button
          className="btn ghost small"
          disabled={disabled || speed === 1}
          onClick={() => onChange({ start: loop.start, end: loop.end })}
        >
          1x
        </button>
      </label>
      {speed !== 1 && (
        <span className="faint tiny">
          Each repeat plays for {((loop.end - loop.start) / speed).toFixed(1)}s. This preview shifts
          the pitch with the speed; the mix keeps the pitch.
        </span>
      )}
    </div>
  );
};
