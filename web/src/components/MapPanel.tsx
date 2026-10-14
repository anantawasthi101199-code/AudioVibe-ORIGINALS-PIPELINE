/**
 * A channel's content maps: episodes planned in series, or a flat list of
 * standalone shorts, each made in order.
 *
 * ONE ITEM IS OFFERED AT A TIME, the first not yet published, and the next is
 * not offered until it is out. The server enforces the same rule (maps.ts), so
 * this panel only shows it. Load fills the Make form with the item's subject
 * and series; everything after that is the ordinary pipeline.
 */
import { useState } from 'react';
import type { MapItem, MapView } from '../api';

/**
 * THE TRACK BAR READS LEFT TO RIGHT AS PROGRESS (owner, 2026-10-13): a written
 * script is a yellow outline, audio fills it yellow, publishing turns it green.
 */
const TONE: Record<MapItem['state'], string> = {
  published: 'var(--pass)',
  voiced: 'var(--amber)',
  scripted: 'var(--amber)',
  making: 'var(--hold)',
  retry: 'var(--fail)',
  todo: 'var(--ink-600)',
};

const WORD: Record<MapItem['state'], string> = {
  published: 'published',
  voiced: 'voiced, not published',
  scripted: 'script written',
  making: 'being made',
  retry: 'failed, make again',
  todo: 'not started',
};

/** A run exists and is still going somewhere: open it rather than start another. */
const IN_HAND = new Set<MapItem['state']>(['making', 'scripted', 'voiced']);

/** Filled for anything with audio or further; an outline for a script alone. */
const notch = (i: MapItem, isNext: boolean): React.CSSProperties => {
  const outlined = i.state === 'scripted' || (i.state === 'todo' && i.scripted);
  return {
    flex: 1,
    height: 10,
    borderRadius: 2,
    boxSizing: 'border-box',
    background: outlined ? 'transparent' : TONE[i.state],
    border: outlined ? '2px solid var(--amber)' : undefined,
    outline: isNext ? '2px solid var(--text)' : undefined,
    outlineOffset: 2,
  };
};

/** Copies the title and what it covers, ready to paste anywhere (owner, 2026-10-14). */
const CopyButton = ({ item }: { item: MapItem }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      style={{ padding: '0 0.45rem', flexShrink: 0 }}
      title="Copy the title and description"
      onClick={() =>
        void navigator.clipboard.writeText(`${item.title}\n\n${item.covers}`).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
};

/** One line of the whole map, ruled off from the next. */
const Row = ({ i }: { i: MapItem }) => (
  <div className="map-row row between tiny" style={{ gap: '0.8rem', alignItems: 'flex-start' }}>
    <span style={{ minWidth: 0 }}>
      <span className="faint">#{i.number} </span>
      {i.runId ? (
        <a href={`#/r/${i.runId}`} title="Open the run">
          {i.title}
        </a>
      ) : (
        i.title
      )}{' '}
      <CopyButton item={i} />
      <span className="muted" style={{ display: 'block', marginTop: '0.15rem' }}>
        {i.covers}
      </span>
    </span>
    <span style={{ color: TONE[i.state], whiteSpace: 'nowrap' }}>
      {i.scripted && i.state === 'todo' ? 'script written' : WORD[i.state]}
    </span>
  </div>
);

export const MapPanel = ({
  map,
  loaded,
  onLoad,
  go,
}: {
  map: MapView;
  /** The item key the Make form currently holds, if it came from here. */
  loaded: string | null;
  onLoad: (item: MapItem) => void;
  go: (path: string) => void;
}) => {
  const next = map.next;
  const unit = map.shorts ? 'short' : 'episode';
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{map.title}</h2>
        <span className="spacer" />
        <span className="muted tiny right-edge">
          {map.published} of {map.total} published
        </span>
      </div>

      <div className="panel-body stack">
        {/* THE TRACK BAR: one notch per item, in map order. */}
        <div style={{ display: 'flex', gap: 2 }} aria-label={`${map.published} of ${map.total} published`}>
          {map.items.map((i) => (
            <span
              key={i.key}
              title={`#${i.number} ${i.title}: ${i.state === 'todo' && i.scripted ? 'script written' : WORD[i.state]}`}
              style={notch(i, i.key === next?.key)}
            />
          ))}
        </div>

        <p className="faint tiny" style={{ margin: 0 }}>
          Yellow outline: script written · yellow: voiced · green: published · white ring: next up
        </p>

        {!next && <p className="muted">Every {unit} on this map is published.</p>}

        {next && (
          <div className="card" style={{ borderColor: 'var(--amber)' }}>
            <div className="eyebrow">
              {map.shorts
                ? `Next: short ${next.number} of ${map.total}`
                : `Next: series ${next.seriesNumber}, ${next.seriesTitle} · episode ${next.position} of ${next.seriesSize} · #${next.number}`}
            </div>
            <div className="row" style={{ gap: '0.6rem' }}>
              <strong>{next.title}</strong>
              <CopyButton item={next} />
            </div>
            <p className="muted tiny" style={{ margin: '0.35rem 0 0' }}>
              {next.covers}
            </p>
            <p className="faint tiny" style={{ margin: '0.35rem 0 0' }}>
              From {next.source}
            </p>
            <div className="row" style={{ gap: '0.6rem', marginTop: '0.6rem' }}>
              {IN_HAND.has(next.state) ? (
                <>
                  <span className="pill hold">{WORD[next.state]}</span>
                  <button type="button" className="btn small" onClick={() => go(`/r/${next.runId}`)}>
                    Open the run
                  </button>
                  <span className="faint tiny">The next one comes up once this is published.</span>
                </>
              ) : (
                <>
                  {next.state === 'retry' && <span className="pill fail">last run failed</span>}
                  {next.scripted && <span className="pill pass">script written</span>}
                  <button type="button" className="btn spend" onClick={() => onLoad(next)} disabled={loaded === next.key}>
                    {loaded === next.key ? 'Loaded into Make' : 'Load into Make'}
                  </button>
                  {next.scripted && (
                    <span className="faint tiny">Load it, then press Blank script: it opens with the script filled in.</span>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <details>
          <summary className="muted tiny">The whole map</summary>
          <div className="stack tight" style={{ marginTop: '0.5rem' }}>
            {map.shorts
              ? map.items.map((i) => <Row key={i.key} i={i} />)
              : [...new Set(map.items.map((i) => i.seriesNumber))].map((n) => {
                  const eps = map.items.filter((i) => i.seriesNumber === n);
                  return (
                    <div key={n} className="stack tight">
                      <div className="eyebrow">
                        Series {n}: {eps[0]!.seriesTitle} ({eps.filter((e) => e.state === 'published').length}/
                        {eps.length})
                      </div>
                      {eps.map((i) => (
                        <Row key={i.key} i={i} />
                      ))}
                    </div>
                  );
                })}
          </div>
        </details>

        <p className="faint tiny" style={{ margin: 0 }}>
          Edit <code>maps/{map.id}.json</code> to change the plan.
        </p>
      </div>
    </section>
  );
};
