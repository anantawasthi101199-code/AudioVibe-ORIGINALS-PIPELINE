/**
 * The reasoning, hidden until somebody wants it.
 *
 * WHY THE PROSE IS NOT ON THE PAGE. Every panel in this studio used to carry a
 * paragraph saying why it worked the way it did, and those paragraphs are worth
 * having: the rules here are unusual and the reasons are not guessable. But a
 * page where every section explains itself is a page nobody scans, and scanning
 * is what somebody does ninety-nine times out of a hundred. The hundredth time
 * they want the paragraph, and then they want all of it.
 *
 * SO IT IS BOTH, and the default is silence. A small mark, one click, the whole
 * explanation. Hover opens it too, for a mouse, but click is what makes it work
 * on a phone and click is what keeps it open while you read.
 *
 * ONE OPEN AT A TIME would be tidier and is deliberately not done: comparing
 * two notes is a real thing to want, and closing one to read the other makes
 * that impossible.
 */
import { useEffect, useRef, useState } from 'react';

export const Info = ({ children, label }: { children: React.ReactNode; label?: string }) => {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;

    // Click anywhere else closes it. Without this the only way to dismiss one
    // is to find the mark again, which on a page of them is a hunt.
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);

    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <span className="info" ref={box}>
      <button
        className={`info-mark${open ? ' on' : ''}`}
        aria-label={label ?? 'Why this works this way'}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        i
      </button>
      {open && <span className="info-note">{children}</span>}
    </span>
  );
};

/**
 * A number and what it counts, which is the whole of most of this interface.
 *
 * The number is large and the word is small, because the number is the answer
 * and the word is only there so you know what was asked.
 */
export const Count = ({
  n,
  label,
  tone,
  onClick,
}: {
  n: number | string;
  label: string;
  tone?: 'hold' | 'fail' | 'pass';
  onClick?: () => void;
}) => {
  const body = (
    <>
      <span className={`count-n${tone && n ? ` ${tone}` : ''}`}>{n}</span>
      <span className="count-label">{label}</span>
    </>
  );

  return onClick ? (
    <button className="count tap" onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className="count">{body}</span>
  );
};

/**
 * Listen to a run without leaving the list.
 *
 * ONE PLAYER ACROSS THE WHOLE APP, held in a module-level element rather than
 * in any page's state. Two episodes talking over each other is useless, and a
 * page that only stops its own players lets a second one start the moment you
 * navigate. There is exactly one, and starting anything stops whatever it was
 * doing.
 */
let current: HTMLAudioElement | null = null;
let currentId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

const announce = (id: string | null) => {
  currentId = id;
  listeners.forEach((fn) => fn(id));
};

export const stopAudio = (): void => {
  current?.pause();
  current = null;
  announce(null);
};

export const playAudio = (id: string, src: string): void => {
  if (currentId === id) return stopAudio();
  stopAudio();

  const el = new Audio(src);
  el.addEventListener('ended', () => announce(null));
  el.addEventListener('error', () => announce(null));
  void el.play();

  current = el;
  announce(id);
};

/** Which run is playing, for any component that wants to show it. */
export const useNowPlaying = (): string | null => {
  const [id, setId] = useState<string | null>(currentId);

  useEffect(() => {
    listeners.add(setId);
    return () => {
      listeners.delete(setId);
    };
  }, []);

  return id;
};

export const PlayButton = ({ id, src }: { id: string; src: string }) => {
  const nowPlaying = useNowPlaying();
  const on = nowPlaying === id;

  return (
    <button
      className={`play${on ? ' on' : ''}`}
      aria-label={on ? 'Stop' : 'Listen'}
      onClick={(e) => {
        e.stopPropagation();
        playAudio(id, src);
      }}
    >
      {on ? '■' : '▶'}
    </button>
  );
};
