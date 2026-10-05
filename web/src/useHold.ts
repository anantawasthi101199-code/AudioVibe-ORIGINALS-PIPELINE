/**
 * Hold a run while this page is open on it (owner, 2026-10-05). See
 * src/server/holds.ts for the rules: the studio decides, this keeps it told.
 *
 * - A heartbeat every 20 seconds, saying whether the person actually did
 *   anything (click, key, scroll, touch) since the last one.
 * - Leaving the page releases it at once, by beacon, so a closed tab does not
 *   hold a run for the three minutes a missing heartbeat takes.
 * - After 30 minutes with no activity the studio lets it go; touching the page
 *   picks it back up if nobody else has taken it meanwhile.
 */
import { useEffect, useRef, useState } from 'react';

export interface Hold {
  holder: string | null;
  mine: boolean;
  since: string | null;
}

const HEARTBEAT_MS = 20_000;

export const useHold = (runId: string): Hold | null => {
  const [hold, setHold] = useState<Hold | null>(null);
  const activeSinceBeat = useRef(true);

  useEffect(() => {
    let stopped = false;
    const url = (what: 'hold' | 'release') => `/api/run/${what}?id=${encodeURIComponent(runId)}`;

    const beat = () => {
      const active = activeSinceBeat.current;
      activeSinceBeat.current = false;
      void fetch(url('hold'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active }),
      })
        .then((r) => (r.ok ? (r.json() as Promise<Hold>) : null))
        .then((h) => {
          if (!stopped && h) setHold(h);
        })
        .catch(() => undefined);
    };

    // Real activity only: a page left open is not somebody working.
    let last = 0;
    const touched = () => {
      activeSinceBeat.current = true;
      // Picking a lapsed hold back up should not wait for the next beat.
      const now = Date.now();
      if (now - last > 5_000) {
        last = now;
        setHold((h) => {
          if (h && !h.holder) beat();
          return h;
        });
      }
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, touched, { passive: true });

    const leave = () => navigator.sendBeacon(url('release'));
    window.addEventListener('pagehide', leave);

    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, touched);
      window.removeEventListener('pagehide', leave);
      // Navigating to another page inside the studio: release now.
      leave();
    };
  }, [runId]);

  return hold;
};
