/**
 * The front page: lanes, then the channels under them.
 *
 * LANES FIRST, WHICH IS NOT HOW THE FILES ARE ARRANGED. A show is a persona
 * file and a beat sheet, an hour's work. A lane is where truth comes from -
 * documents checked against verbatim quotes, or a series bible - and it is
 * weeks. Putting the expensive decision at the top of the page is the whole
 * reason this is not just a list of shows.
 *
 * AN EMPTY LANE IS STILL SHOWN, because that is how you notice the fiction
 * pipeline has never been used.
 */
import { useEffect, useState } from 'react';
import { api, ago, type Lane } from '../api';
import { ErrorNote } from '../components/bits';

export const Lanes = ({ go }: { go: (path: string) => void }) => {
  const [lanes, setLanes] = useState<Lane[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .catalogue()
      .then((d) => setLanes(d.lanes))
      .catch((e: Error) => setError(e.message));
  }, []);

  const totals = (lanes ?? []).flatMap((l) => l.channels);
  const waiting = totals.reduce((n, c) => n + c.runs.awaitingApproval, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">AudioVibe Originals</div>
        <h1>The Foundry</h1>
        <p className="lede">
          Two lanes, {totals.length} channels. Everything here writes before it voices, and nothing
          is voiced until somebody has read it.
        </p>
        {waiting > 0 && (
          <p className="mt">
            <span className="pill hold">
              <span className="dot" />
              {waiting} {waiting === 1 ? 'run is' : 'runs are'} held, waiting to be read
            </span>
          </p>
        )}
      </div>

      <ErrorNote>{error}</ErrorNote>

      {!lanes && !error && <div className="empty">Reading the studio.</div>}

      <div className="stack">
        {(lanes ?? []).map((lane) => (
          <section className="lane" key={lane.id}>
            <div className="lane-head">
              <div style={{ flex: 1, minWidth: '18rem' }}>
                <div className="eyebrow">{lane.id === 'factual' ? 'Evidence ledger' : 'Continuity bible'}</div>
                <h2>{lane.name}</h2>
                <p className="lane-basis">{lane.basis}</p>
              </div>
              <div className="row" style={{ gap: '1.4rem' }}>
                <div>
                  <div className="stat-value mono">{lane.channels.length}</div>
                  <div className="stat-label">channels</div>
                </div>
                <div>
                  <div className="stat-value mono">
                    {lane.channels.reduce((n, c) => n + c.runs.total, 0)}
                  </div>
                  <div className="stat-label">runs</div>
                </div>
              </div>
            </div>

            {lane.channels.length === 0 ? (
              <div className="empty" style={{ border: 0 }}>
                No channels on this lane yet.
              </div>
            ) : (
              <div className="channels">
                {lane.channels.map((c) => (
                  <a
                    key={c.id}
                    className="channel"
                    href={`#/c/${c.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      go(`/c/${c.id}`);
                    }}
                  >
                    <div className="channel-name">
                      <h3>{c.name}</h3>
                      {c.runs.awaitingApproval > 0 && (
                        <span className="pill hold">
                          <span className="dot" />
                          {c.runs.awaitingApproval} held
                        </span>
                      )}
                    </div>
                    <div className="faint mono" style={{ fontSize: '0.72rem', marginBottom: '0.6rem' }}>
                      @{c.handle} · {c.category}
                    </div>
                    <p className="channel-thesis">{c.thesis}</p>

                    <div className="channel-foot">
                      <span>{c.runs.total} runs</span>
                      <span>{c.queued.topics + c.queued.sets} queued</span>
                      <span>
                        {c.routes.some((r) => r.kind === 'shorts') ? 'episodes + shorts' : 'episodes'}
                      </span>
                      <span className="spacer" />
                      <span>{c.runs.lastAt ? ago(c.runs.lastAt) : 'never run'}</span>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
};
