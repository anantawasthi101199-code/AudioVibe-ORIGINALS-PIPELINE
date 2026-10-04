import { useEffect, useRef, useState } from 'react';

export interface Loop {
  start: number;
  end: number;
  /** 0.5 to 2. Tempo only: the pitch stays put, in the preview and the mix. */
  speed?: number;
}

const MIN_LOOP_S = 2;
const BUCKETS = 600;

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * Pick the section of a track that repeats under an episode, and hear it.
 *
 * The track is drawn as a waveform. Drag the start and end bars; press play
 * and it plays from the start bar to the end bar and round again, with a
 * playhead moving across, at the chosen speed with the pitch kept - exactly
 * what the mix will repeat. Moving a bar or the speed while it plays changes
 * what you hear straight away. The one difference from the mix: there the end
 * blends into the start over half a second; here it jumps.
 */
/** Half a second: the blend where the loop's end runs into its start. */
const CROSSFADE_S = 0.5;

export const Trimmer = ({
  src,
  previewUrl,
  value,
  onChange,
  disabled,
}: {
  src: string;
  /** Where the studio serves this exact loop, as the mix will repeat it. */
  previewUrl: (loop: Loop) => string;
  /** The selected section; null means the whole track. */
  value: Loop | null;
  onChange: (loop: Loop) => void;
  disabled?: boolean;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ctx = useRef<AudioContext | null>(null);
  const node = useRef<AudioBufferSourceNode | null>(null);
  const startedAt = useRef(0);
  const frame = useRef<number | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [head, setHead] = useState<number | null>(null);
  const [drag, setDrag] = useState<'start' | 'end' | null>(null);

  const loop: Loop = value ?? { start: 0, end: duration };
  const speed = value?.speed ?? 1;
  // The play loop reads these every frame, so it always follows the latest bars.
  const live = useRef({ start: loop.start, end: loop.end });
  live.current = { start: loop.start, end: loop.end };

  // Every bar move carries the speed along, so moving a bar never resets it.
  const emit = (next: Loop) =>
    onChange(speed !== 1 ? { ...next, speed } : { start: next.start, end: next.end });

  // Decode once per track and reduce it to a few hundred peaks to draw.
  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setError(null);
    (async () => {
      const res = await fetch(src);
      const data = await res.arrayBuffer();
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(data);
      void ctx.close();
      if (cancelled) return;
      const ch = decoded.getChannelData(0);
      const step = Math.max(1, Math.floor(ch.length / BUCKETS));
      const out: number[] = [];
      for (let i = 0; i < BUCKETS; i++) {
        let max = 0;
        for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j++) max = Math.max(max, Math.abs(ch[j]!));
        out.push(max);
      }
      setDuration(decoded.duration);
      setPeaks(out);
    })().catch((e) => !cancelled && setError(`could not read the track: ${(e as Error).message}`));
    return () => {
      cancelled = true;
    };
  }, [src]);

  // What is playing, so the playhead can be placed on the track.
  const playingLoop = useRef<Loop | null>(null);

  const halt = () => {
    try {
      node.current?.stop();
    } catch {
      // Already stopped.
    }
    node.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const tick = () => {
    const l = playingLoop.current;
    const n = node.current;
    if (!l || !n || !ctx.current || !n.buffer) return;
    const sp = l.speed ?? 1;
    const len = l.end - l.start;
    // The clip starts CROSSFADE_S into the section (as heard) and wraps.
    const p = (ctx.current.currentTime - startedAt.current) % n.buffer.duration;
    setHead(l.start + (((CROSSFADE_S + p) * sp) % len));
    frame.current = requestAnimationFrame(tick);
  };

  const play = async (l: Loop = { ...loop, ...(speed !== 1 ? { speed } : {}) }) => {
    setPreparing(true);
    try {
      ctx.current ??= new AudioContext();
      await ctx.current.resume();
      const res = await fetch(previewUrl(l));
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      const buf = await ctx.current.decodeAudioData(await res.arrayBuffer());
      halt();
      const n = ctx.current.createBufferSource();
      n.buffer = buf;
      // The clip is already seamless: looping it whole is the mix's loop.
      n.loop = true;
      n.connect(ctx.current.destination);
      n.start();
      startedAt.current = ctx.current.currentTime;
      node.current = n;
      playingLoop.current = l;
      setPlaying(true);
      frame.current = requestAnimationFrame(tick);
    } catch (e) {
      setError(`could not play the selection: ${(e as Error).message}`);
    } finally {
      setPreparing(false);
    }
  };

  const stop = () => {
    halt();
    playingLoop.current = null;
    setPlaying(false);
    setHead(null);
  };

  // A new track: stop whatever was playing.
  useEffect(() => stop, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bars or speed moved while playing: once they settle, play the new loop.
  useEffect(() => {
    if (!playing || drag) return;
    const l = playingLoop.current;
    if (l && l.start === loop.start && l.end === loop.end && (l.speed ?? 1) === speed) return;
    const t = window.setTimeout(() => void play(), 350);
    return () => window.clearTimeout(t);
  }, [loop.start, loop.end, speed, drag, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draw: the waveform, the unselected parts dimmed, the two bars, the playhead.
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
      const played = head !== null && x >= x0 && x <= (head / duration) * w;
      g.fillStyle = x >= x0 && x <= x1 ? (played ? '#9fd4ff' : '#5fb3ff') : '#2a3554';
      const bh = Math.max(1, p * h * 0.92);
      g.fillRect(x, (h - bh) / 2, Math.max(1, bw - 1), bh);
    });
    g.fillStyle = '#ffffff';
    g.fillRect(x0 - devicePixelRatio, 0, 2 * devicePixelRatio, h);
    g.fillRect(x1 - devicePixelRatio, 0, 2 * devicePixelRatio, h);
    if (head !== null) {
      g.fillStyle = '#4ade80';
      g.fillRect((head / duration) * w - devicePixelRatio, 0, 2 * devicePixelRatio, h);
    }
  }, [peaks, duration, loop.start, loop.end, head]);

  const timeAt = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };

  const move = (which: 'start' | 'end', t: number) => {
    if (which === 'start') emit({ start: Math.min(t, loop.end - MIN_LOOP_S), end: loop.end });
    else emit({ start: loop.start, end: Math.max(t, loop.start + MIN_LOOP_S) });
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

  if (error) return <span className="fail tiny">{error}</span>;
  if (!peaks) return <span className="faint tiny">Reading the track...</span>;

  return (
    <div className="stack tight">
      <div className="trim-row">
        <button
          className={`trim-play${playing ? ' on' : ''}`}
          disabled={disabled}
          onClick={playing ? stop : () => void play()}
          aria-busy={preparing}
          aria-label={playing ? 'Stop the preview' : 'Play from the start bar to the end bar, on loop'}
          title={playing ? 'Stop' : 'Play the selection on loop'}
        >
          {preparing ? '…' : playing ? '■' : '▶'}
        </button>
        <canvas
          ref={canvas}
          className="trimmer"
          onPointerDown={onDown}
          onPointerMove={(e) => drag && move(drag, timeAt(e.clientX))}
          onPointerUp={() => setDrag(null)}
          aria-label="Drag the start and end bars to choose the section that repeats"
        />
      </div>
      <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="mono tiny">
          {playing && head !== null ? `${fmt(head)} · ` : ''}
          {fmt(loop.start)} to {fmt(loop.end)} · {(loop.end - loop.start).toFixed(1)}s of the track
          {speed !== 1 ? `, plays ${((loop.end - loop.start) / speed).toFixed(1)}s at ${speed.toFixed(2)}x` : ''}
        </span>
        <span className="spacer" />
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
      <span className="faint tiny">
        Press play to hear exactly what the mix will repeat: this section, at this speed with the
        pitch kept, the end blending into the start. Move the bars or the speed while it plays and
        it follows.
      </span>
    </div>
  );
};
