/**
 * Every channel, one line each.
 *
 * A LIST, NOT CARDS. Cards carried three lines of thesis per channel and four
 * fitted on a screen. The questions this page answers are "which channel do I
 * want" and "is any of them not set up", and both are faster from a column you
 * can run your eye down than from a wall of paragraphs.
 *
 * THE LANE IS A HEADING AND NOTHING ELSE. What a lane means - where truth comes
 * from, documents against verbatim quotes or a series bible - is the most
 * important idea in this studio and the least often needed on this screen. It
 * is behind the mark.
 */
import { useEffect, useState } from 'react';
import { ago, api, type Lane } from '../api';
import { ErrorNote } from '../components/bits';
import { Count, Info } from '../components/Info';

export const Lanes = ({ go }: { go: (path: string) => void }) => {
  const [lanes, setLanes] = useState<Lane[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .catalogue()
      .then((d) => setLanes(d.lanes))
      .catch((e: Error) => setError(e.message));
  }, []);

  const channels = (lanes ?? []).flatMap((l) => l.channels);
  const held = channels.reduce((n, c) => n + c.runs.awaitingApproval, 0);
  const unready = channels.filter(
    (c) => !c.account.exists || !c.account.canPublish || (c.account.needsSeries && !c.account.hasSeries)
  ).length;

  return (
    <div className="page">
      <ErrorNote>{error}</ErrorNote>
      {!lanes && !error && <p className="faint">...</p>}

      {lanes && (
        <div className="counts" style={{ marginBottom: '1.7rem' }}>
          <Count n={channels.length} label="channels" />
          <Count n={channels.reduce((n, c) => n + c.runs.total, 0)} label="runs" />
          <Count
            n={held}
            label="held"
            tone={held ? 'hold' : undefined}
            onClick={() => go('/queue')}
          />
          <Count n={unready} label="not set up" tone={unready ? 'fail' : undefined} />
        </div>
      )}

      <div className="stack tight">
        {(lanes ?? []).map((lane) => (
          <section className="panel" key={lane.id}>
            <div className="panel-head">
              <h2>{lane.name}</h2>
              <span className="pill">{lane.channels.length}</span>
              <span className="spacer" />
              <span className="right-edge">
                <Info label={`What the ${lane.name} lane is`}>{lane.basis}</Info>
              </span>
            </div>

            {lane.channels.length === 0 ? (
              <p className="panel-body faint">No channels on this lane.</p>
            ) : (
              <div className="queue-list">
                {lane.channels.map((c) => (
                  <button key={c.id} className="queue-row" onClick={() => go(`/c/${c.id}`)}>
                    <span className="queue-main">
                      <span className="queue-title">{c.name}</span>
                      <span className="muted">
                        @{c.handle} · {c.runs.total} runs ·{' '}
                        {c.runs.lastAt ? ago(c.runs.lastAt) : 'never run'}
                      </span>
                    </span>

                    <span className="row nowrap">
                      {c.runs.awaitingApproval > 0 && (
                        <span className="pill hold">{c.runs.awaitingApproval} held</span>
                      )}
                      {/*
                        THE STATE THAT IS OTHERWISE INVISIBLE. A channel with an
                        account but no publishing credential looks finished
                        everywhere else, and the first anybody learns is a
                        failed publish at the end of a run already paid for.
                      */}
                      {!c.account.exists ? (
                        <span className="pill">no account</span>
                      ) : !c.account.canPublish ? (
                        <span className="pill fail">no token</span>
                      ) : null}
                      {!c.fiction && c.queued.topics + c.queued.sets === 0 && (
                        <span className="pill">no topics</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
};
