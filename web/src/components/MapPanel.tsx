/**
 * A channel's content maps: the planned series and episodes, made in order.
 *
 * ONE ITEM IS OFFERED AT A TIME, the first not yet published, and the next is
 * not offered until it is out. The server enforces the same rule (maps.ts), so
 * this panel only shows it. Load fills the Make form with the item's subject
 * and series; everything after that is the ordinary pipeline.
 */
import type { MapItem, MapView } from '../api';

const TONE: Record<MapItem['state'], string> = {
  published: 'var(--pass)',
  making: 'var(--amber)',
  retry: 'var(--fail)',
  todo: 'var(--ink-600)',
};

const WORD: Record<MapItem['state'], string> = {
  published: 'published',
  making: 'being made',
  retry: 'failed, make again',
  todo: 'not started',
};

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
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Map: {map.title}</h2>
        <span className="spacer" />
        <span className="muted tiny right-edge">
          {map.published} of {map.total} published
        </span>
      </div>

      <div className="panel-body stack">
        {/* THE TRACK BAR: one notch per episode, in map order. */}
        <div style={{ display: 'flex', gap: 2 }} aria-label={`${map.published} of ${map.total} published`}>
          {map.items.map((i) => (
            <span
              key={i.key}
              title={`#${i.number} ${i.title}: ${WORD[i.state]}`}
              style={{
                flex: 1,
                height: 10,
                borderRadius: 2,
                background: TONE[i.state],
                outline: i.key === next?.key ? '2px solid var(--amber)' : undefined,
                outlineOffset: 1,
              }}
            />
          ))}
        </div>

        {!next && <p className="muted">Every episode on this map is published.</p>}

        {next && (
          <div className="card" style={{ borderColor: 'var(--amber)' }}>
            <div className="eyebrow">
              Next: series {next.seriesNumber}, {next.seriesTitle} · episode {next.position} of {next.seriesSize} · #
              {next.number}
            </div>
            <strong>{next.title}</strong>
            <p className="muted tiny" style={{ margin: '0.35rem 0 0' }}>
              {next.covers}
            </p>
            <p className="faint tiny" style={{ margin: '0.35rem 0 0' }}>
              From {next.source}
            </p>
            <div className="row" style={{ gap: '0.6rem', marginTop: '0.6rem' }}>
              {next.state === 'making' ? (
                <>
                  <span className="pill hold">being made</span>
                  <button type="button" className="btn small" onClick={() => go(`/r/${next.runId}`)}>
                    Open the run
                  </button>
                  <span className="faint tiny">The next one opens once this is published.</span>
                </>
              ) : (
                <>
                  {next.state === 'retry' && <span className="pill fail">last run failed</span>}
                  <button type="button" className="btn spend" onClick={() => onLoad(next)} disabled={loaded === next.key}>
                    {loaded === next.key ? 'Loaded into Make' : 'Load into Make'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <details>
          <summary className="muted tiny">The whole map</summary>
          <div className="stack tight" style={{ marginTop: '0.5rem' }}>
            {[...new Set(map.items.map((i) => i.seriesNumber))].map((n) => {
              const eps = map.items.filter((i) => i.seriesNumber === n);
              return (
                <div key={n} className="stack tight">
                  <div className="eyebrow">
                    Series {n}: {eps[0]!.seriesTitle} ({eps.filter((e) => e.state === 'published').length}/{eps.length})
                  </div>
                  {eps.map((i) => (
                    <div key={i.key} className="row between tiny" style={{ gap: '0.8rem' }}>
                      <span style={{ minWidth: 0 }}>
                        <span className="faint">#{i.number} </span>
                        {i.runId ? (
                          <a href={`#/r/${i.runId}`}>
                            {i.title}
                          </a>
                        ) : (
                          i.title
                        )}
                      </span>
                      <span style={{ color: TONE[i.state], whiteSpace: 'nowrap' }}>{WORD[i.state]}</span>
                    </div>
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
