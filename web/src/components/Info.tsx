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
