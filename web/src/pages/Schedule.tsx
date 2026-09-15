/**
 * What goes out, in what order, and what it sounds like.
 *
 * ONE ORDERED LIST ACROSS EVERY CHANNEL. The question somebody actually has is
 * "what does this studio put out over the next fortnight" - and that is a
 * single sequence, not five per-channel ones held in your head at once.
 *
 * LISTEN BEFORE YOU QUEUE IT. Every row has a play button, because the one
 * thing a person can check that no gate can is whether it sounds right. Making
 * that require opening each run separately meant it mostly did not happen.
 *
 * ONE PLAYER AT A TIME, and that is deliberate rather than incidental: two
 * episodes talking over each other is useless, and pausing the first by hand
 * every time is the kind of small friction that stops people listening at all.
 *
 * PUBLISHED ONES LEAVE BY THEMSELVES. Nothing here removes them. A published
 * run stops being `ready`, so it stops being offered and the order that remains
 * is still the order.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  clock,
  money,
  until,
  when,
  type QueueView,
  type RunSummary,
} from '../api';
import { ErrorNote } from '../components/bits';
import { Count, Info, PlayButton, stopAudio } from '../components/Info';

/** A run in the list, with whether it is queued and where. */
type Item = RunSummary & { queued: boolean };

export const Schedule = ({ go }: { go: (path: string) => void }) => {
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  // A player left running after you navigate is a voice with no visible source.
  useEffect(() => stopAudio, []);

  const load = useCallback(
    () =>
      api
        .queue()
        .then((q) => {
          setQueue(q);
          setError(null);

          // ONLY REBUILT WHEN THE PAGE IS CLEAN. A refresh landing mid-drag and
          // throwing away an order somebody was halfway through arranging is
          // the most annoying possible bug in a page like this.
          setDirty((wasDirty) => {
            if (wasDirty) return wasDirty;

            // Queued first, in release order; then everything else that could
            // be queued, newest first.
            const queued: Item[] = q.scheduled.map((r) => ({ ...r, queued: true }));
            const rest: Item[] = q.ready
              .filter((r) => !queued.some((x) => x.id === r.id))
              .map((r) => ({ ...r, queued: false }));

            setItems([...queued, ...rest]);
            return wasDirty;
          });
        })
        .catch((e: Error) => setError(e.message)),
    []
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row!);
    setItems(next);
    setDirty(true);
  };

  const toggle = (id: string) => {
    setItems((was) => was.map((r) => (r.id === id ? { ...r, queued: !r.queued } : r)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setPublishQueue(items.filter((r) => r.queued).map((r) => r.id));
      setDirty(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!queue) {
    return (
      <div className="page">
        <ErrorNote>{error}</ErrorNote>
        {!error && <p className="faint">...</p>}
      </div>
    );
  }

  const chosen = items.filter((r) => r.queued);

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '0.3rem' }}>
        <h1 className="headline">Publishing order</h1>
        <div className="row nowrap">
          {dirty && (
            <button className="btn ghost" onClick={() => void load()} disabled={saving}>
              Undo
            </button>
          )}
          <button className="btn spend" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving...' : dirty ? `Save order (${chosen.length})` : 'Saved'}
          </button>
        </div>
      </div>

      <div className="counts" style={{ margin: '1.3rem 0 1.5rem' }}>
        <Count n={chosen.length} label="queued" tone="pass" />
        <Count n={items.length - chosen.length} label="held back" />
        <Count n={queue.publishedTotal} label="out" />
      </div>

      <ErrorNote>{error}</ErrorNote>

      <p className="muted" style={{ marginBottom: '0.9rem', fontSize: '0.85rem' }}>
        Drag to reorder. Tick what goes out.{' '}
        <Info label="How the order becomes dates">
          Position decides the day, one a day starting tomorrow. The hour comes from the
          channel&apos;s own slot, so two shows on consecutive days still go out at their own
          times. Anything unticked has its date cleared and goes back to publishable whenever you
          like; nothing here stops you publishing something now. Published runs drop off this list
          by themselves, and the order that remains is still the order. Times are {queue.timezone}.
        </Info>
      </p>

      {items.length === 0 ? (
        <div className="empty">
          Nothing finished yet. <a href="#/channels">Make something</a> first.
        </div>
      ) : (
        <div className="order">
          {items.map((r, i) => (
            <div
              key={r.id}
              className={`order-row${r.queued ? ' on' : ''}${dragging === r.id ? ' dragging' : ''}`}
              draggable
              onDragStart={() => setDragging(r.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => {
                e.preventDefault();
                const from = items.findIndex((x) => x.id === dragging);
                if (from >= 0 && from !== i) move(from, i);
              }}
            >
              <span className="grip" aria-hidden>
                ⠿
              </span>

              <input
                type="checkbox"
                className="tick"
                checked={r.queued}
                onChange={() => toggle(r.id)}
                aria-label={`Publish ${r.title ?? r.topic}`}
              />

              <span className="order-n mono">{r.queued ? chosen.indexOf(r) + 1 : '—'}</span>

              {r.hasAudio ? (
                <PlayButton id={r.id} src={api.audioUrl(r.id)} />
              ) : (
                <span className="play empty" aria-hidden />
              )}

              <button className="order-main" onClick={() => go(`/r/${r.id}`)}>
                <span className="queue-title">{r.title ?? r.topic}</span>
                <span className="muted">
                  {r.channelName}
                  {r.short !== null ? ` · short ${r.short}` : ''} · {clock(r.durationS)} ·{' '}
                  {money(r.spentPence)}
                </span>
              </button>

              <span className="row nowrap order-when">
                {r.queued && r.releaseAt && !dirty ? (
                  <>
                    <span className="muted mono tiny">{when(r.releaseAt, queue.timezone)}</span>
                    <span className="pill">{until(r.releaseAt)}</span>
                  </>
                ) : r.queued ? (
                  <span className="pill">day {chosen.indexOf(r) + 1}</span>
                ) : (
                  <span className="faint tiny">held back</span>
                )}
              </span>

              {/* Keyboard and touch, because dragging is neither. */}
              <span className="nudge">
                <button onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up">
                  ↑
                </button>
                <button
                  onClick={() => move(i, i + 1)}
                  disabled={i === items.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
