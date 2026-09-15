/**
 * One run: watch it, read it, change it, then decide whether to voice it.
 *
 * THIS PAGE IS THE APPROVAL BREAK. Everything above the script is there so the
 * decision at the bottom is an informed one - what it cost, what it cited, what
 * the gate found - and the one button that spends money is the only amber thing
 * on the page.
 *
 * THE SCRIPT IS SHOWN AS PROSE, NOT AS A FORM. This is the one screen where
 * somebody is judging writing rather than scanning a record, so it gets a real
 * measure, real leading, and the delivery tags kept visible but quiet. Editing
 * is a mode you enter, not the default, because a page full of text boxes reads
 * as data entry and nobody reads data entry.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  clock,
  money,
  until,
  watchJob,
  type Beat,
  type JobEvent,
  type Platform,
  type RunDetail,
} from '../api';
import { CostBar, ErrorNote, LiveLog, StageRail, StatePill } from '../components/bits';
import { Count, Info } from '../components/Info';

/** Delivery tags are part of the script and are not part of the sentence. */
const Prose = ({ turns }: { turns: Beat['turns'] }) => (
  <div className="prose">
    {turns.map((t, i) => (
      <p key={i} style={{ margin: i ? '1.1rem 0 0' : 0 }}>
        {t.text.split(/(\[[a-z ]{1,24}\])/gi).map((part, j) =>
          /^\[[a-z ]{1,24}\]$/i.test(part) ? (
            <span className="tag" key={j}>
              {part}{' '}
            </span>
          ) : (
            <span key={j}>{part}</span>
          )
        )}
      </p>
    ))}
  </div>
);

export const Run = ({ id, go }: { id: string; go: (path: string) => void }) => {
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [live, setLive] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Beat[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  /** The second press. Publishing is the one thing here that cannot be undone. */
  const [confirming, setConfirming] = useState(false);
  /** What the last scheduling said, so "3 of 10" is not a silent surprise. */
  const [scheduled, setScheduled] = useState<string | null>(null);

  useEffect(() => {
    void api
      .platform()
      .then(setPlatform)
      .catch(() => undefined);
  }, []);
  const stop = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.run(id);
      setData(d);
      setEvents(d.job?.events ?? []);
      setDraft(d.script?.beats ?? []);
      return d;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [id]);

  // Watch whatever job this run has, and keep watching one we start.
  const follow = useCallback(
    (jobId: string) => {
      stop.current?.();
      setLive(true);
      stop.current = watchJob(jobId, {
        onEvent: (e) => setEvents((prev) => [...prev, e]),
        onDone: (r) => {
          setLive(false);
          setBusy(null);
          if (r.error) setError(r.error);
          void load();
        },
      });
    },
    [load]
  );

  useEffect(() => {
    void load().then((d) => {
      if (d?.job && !d.job.finishedAt) follow(d.job.id);
    });
    return () => stop.current?.();
  }, [load, follow]);

  if (error && !data) return <div className="page"><ErrorNote>{error}</ErrorNote></div>;
  if (!data) return <div className="page"><div className="empty">Reading the run.</div></div>;

  const { run, script, gate, manifest, claims, corpus, cuts, hasAudio, isSource } = data;
  const held = manifest.holdForApproval && !manifest.approvedAt;
  const currentStage = live ? (events[events.length - 1]?.stage ?? null) : null;

  const act = async (what: string, fn: () => Promise<{ jobId: string }>) => {
    setBusy(what);
    setError(null);
    try {
      follow((await fn()).jobId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  /**
   * Something that finishes at once, rather than starting a job to watch.
   *
   * Scheduling writes a date onto each cut and returns. Routing it through
   * `act` would leave the page waiting for a job id that is never coming.
   */
  const now = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!script) return;
    setBusy('save');
    setError(null);
    try {
      await api.saveScript(id, {
        title: script.title,
        description: script.description,
        beats: draft,
      });
      setEditing(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const blocking = (gate?.findings ?? []).filter((f) => f.blocking);
  const advisory = (gate?.findings ?? []).filter((f) => !f.blocking);

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '0.9rem' }}>
        <h1 style={{ fontSize: '1.4rem' }}>{script?.title ?? run.topic}</h1>
        <div className="row nowrap">
          <StatePill state={live ? 'running' : run.state} />
          <Info label="What this run was asked for">
            {run.channelName} · e{String(run.episode).padStart(3, '0')}
            {run.short ? `-s${String(run.short).padStart(2, '0')}` : ''} · {run.formatId}
            <br />
            <br />
            {run.topic}
          </Info>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="stack mt">
        <StageRail
          completed={run.completed}
          live={currentStage}
          skip={isSource ? ['render', 'qa'] : []}
        />

        {(live || events.length > 0) && (
          <div className="panel">
            <div className="panel-head">
              <h3>{live ? 'Working' : 'What happened'}</h3>
              <span className="spacer" />
              {live && (
                <span className="pill live">
                  <span className="dot" /> live
                </span>
              )}
            </div>
            <div className="panel-body stack">
              <LiveLog events={events} />
              <CostBar events={events} total={run.spentPence} />
            </div>
          </div>
        )}
      </div>

      {/* --- THE DECISION ------------------------------------------------- */}
      {held && script && !live && (
        <section className="panel mt2" style={{ borderColor: 'var(--hold-dim)' }}>
          <div className="panel-body">
            <div className="row">
              <h2 style={{ fontSize: '1.05rem' }}>Held</h2>
              <Info label="What held means">
                Nothing has been voiced. Read it below, change anything that needs changing, and
                approve it when you are happy. Approving is the only step here that spends real
                money, and it is the last point at which the words are free to change.
              </Info>
              <span className="spacer" />
              <button
                className="btn spend"
                disabled={busy !== null}
                onClick={() => act('approve', () => api.approve(id))}
              >
                {busy === 'approve' ? 'Voicing...' : 'Approve and voice'}
              </button>
            </div>
          </div>
        </section>
      )}

      {isSource && script && !live && (
        <section className="panel mt2">
          <div className="panel-body row">
            <h2 style={{ fontSize: '1.05rem' }}>
              {cuts.length > 0 ? `${cuts.length} cut` : 'Not cut yet'}
            </h2>
            <Info label="What a source script is">
              This is a source script. It is never voiced or published whole; each story becomes
              its own short, with its own audio, its own ledger and its own gate.
            </Info>
            <span className="spacer" />
            <button
              className="btn spend"
              disabled={busy !== null}
              onClick={() => act('cut', () => api.cut(id))}
            >
              {busy === 'cut'
                ? 'Cutting...'
                : cuts.length
                  ? 'Cut again'
                  : `Cut ${script.beats.length} shorts`}
            </button>
          </div>

          {cuts.length > 0 && (
            <div className="panel-body row" style={{ paddingTop: 0 }}>
              <button
                className="btn small"
                disabled={busy !== null}
                onClick={() =>
                  now('schedule', async () => {
                    const r = await api.scheduleRelease(id);
                    setScheduled(
                      r.skipped
                        ? `${r.scheduled} lined up, ${r.skipped} skipped: published already or the gate rejected them`
                        : `${r.scheduled} lined up, one a day`
                    );
                  })
                }
              >
                {busy === 'schedule' ? 'Scheduling...' : 'Line them up'}
              </button>
              <Info label="What lining them up does">
                Gives each story a release time, one a day starting tomorrow, at a different hour
                each day. Ten shorts published together is what makes a feed look like somebody
                emptied a bucket into it. The times are derived rather than random, so running
                this again gives the same answer, and nothing stops you publishing one now.
              </Info>
              {scheduled && <span className="faint tiny">{scheduled}</span>}
              {cuts.some((c) => c.releaseAt) && (
                <button
                  className="btn ghost small"
                  disabled={busy !== null}
                  onClick={() =>
                    now('unschedule', async () => {
                      await api.scheduleRelease(id, true);
                      setScheduled(null);
                    })
                  }
                >
                  Clear times
                </button>
              )}
            </div>
          )}

          {cuts.length > 0 && (
            <div className="panel-body" style={{ paddingTop: 0 }}>
              <table className="runs">
                <thead>
                  <tr>
                    <th>Story</th>
                    <th>State</th>
                    <th className="right">Goes out</th>
                    <th className="right">Length</th>
                    <th className="right">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {cuts.map((c) => (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => go(`/r/${c.id}`)}>
                      <td>
                        <span className="faint mono" style={{ marginRight: '0.6rem' }}>
                          {String(c.story ?? 0).padStart(2, '0')}
                        </span>
                        {c.title ?? '(untitled)'}
                      </td>
                      <td>
                        <StatePill state={c.state} />
                      </td>
                      <td className="right num">
                        {c.releaseAt ? (
                          <span title={c.releaseAt}>{until(c.releaseAt)}</span>
                        ) : (
                          <span className="faint">-</span>
                        )}
                      </td>
                      <td className="right num">{clock(c.durationS)}</td>
                      <td className="right num">{money(c.spentPence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* --- Audio --------------------------------------------------------- */}
      {hasAudio && (
        <section className="mt2">
          <h2>Listen</h2>
          <div className="player mt">
            {/* metadata, so the length is on screen before anybody presses play */}
            <audio controls preload="metadata" src={api.audioUrl(id)} />
          </div>
        </section>
      )}

      {/* --- Numbers ------------------------------------------------------- */}
      <div className="counts" style={{ margin: '1.5rem 0' }}>
        <Count n={money(run.spentPence)} label="spent" />
        <Count n={clock(run.durationS)} label="length" />
        <Count n={claims?.claims.length ?? 0} label="facts" />
        <Count n={corpus?.sources.length ?? 0} label="sources" />
        <Count n={script?.beats.length ?? 0} label={isSource ? 'stories' : 'beats'} />
        <Count n={gate?.measurement?.words ?? 0} label="words" />
      </div>

      {/* --- The gate ------------------------------------------------------ */}
      {gate && (
        <section className="panel mt2">
          <div className="panel-head">
            <h3>The gate</h3>
            {gate.passed ? (
              <span className="pill pass">passed</span>
            ) : (
              <span className="pill fail">{blocking.length} blocking</span>
            )}
            <span className="spacer" />
            {advisory.length > 0 && <span className="faint mono" style={{ fontSize: '0.72rem' }}>{advisory.length} advisory</span>}
          </div>
          <div className="panel-body">
            {gate.findings.length === 0 && gate.humanReviewReasons.length === 0 && (
              <p className="muted">Nothing to report.</p>
            )}
            {blocking.map((f, i) => (
              <div className="finding" key={`b${i}`}>
                <span className="check" style={{ color: 'var(--fail)' }}>
                  {f.check}
                </span>
                <span>{f.detail}</span>
              </div>
            ))}
            {advisory.map((f, i) => (
              <div className="finding" key={`a${i}`}>
                <span className="check">{f.check}</span>
                <span className="muted">{f.detail}</span>
              </div>
            ))}
            {gate.humanReviewReasons.map((r, i) => (
              <div className="finding" key={`h${i}`}>
                <span className="check" style={{ color: 'var(--hold)' }}>
                  a human
                </span>
                <span className="muted">{r}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* --- THE LAST IRREVERSIBLE ACT -------------------------------------
          Two presses, and the second one names the platform. Everything else
          in this studio can be redone; a publish notifies followers, warms
          feed caches and writes the seen ledger, and none of that comes back.
      */}
      {gate?.passed && !isSource && run.state !== 'published' && !live && (
        <section className="panel mt2" style={{ borderColor: 'var(--line)' }}>
          <div className="panel-body row">
            <h2 style={{ fontSize: '1.05rem' }}>Publish</h2>
            <Info label="What publishing does">
              It goes out as the channel&apos;s own account, through the same upload the platform
              gives every creator, carrying the AI label and the list of what it read. Followers
              are notified, feeds cache it and the seen ledger records it. None of that can be
              taken back.
            </Info>
            <span className="spacer" />

            {platform?.configured && (
              <span className={`where${platform.isProduction ? ' live' : ''}`}>
                <span className="dot" />
                {platform.isProduction ? 'production' : new URL(platform.url!).hostname}
              </span>
            )}

            {confirming ? (
              <>
                <button className="btn ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  className="btn spend"
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirming(false);
                    void act('publish', () => api.publish(id, true));
                  }}
                >
                  {busy === 'publish'
                    ? 'Publishing...'
                    : `Yes, publish to ${platform?.isProduction ? 'production' : 'staging'}`}
                </button>
              </>
            ) : (
              <button
                className="btn"
                disabled={busy !== null || !platform?.configured}
                onClick={() => setConfirming(true)}
              >
                Publish
              </button>
            )}
          </div>

          {gate.needsHumanReview && (
            <div className="panel-body" style={{ paddingTop: 0 }}>
              {gate.humanReviewReasons.map((r, i) => (
                <div className="finding" key={i}>
                  <span className="check" style={{ color: 'var(--hold)' }}>
                    read first
                  </span>
                  <span className="muted">{r}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {run.state === 'published' && (
        <section className="panel mt2">
          <div className="panel-body row">
            <span className="pill pass">published</span>
            <span className="muted">This is out in the world.</span>
          </div>
        </section>
      )}

      {/* --- The script ---------------------------------------------------- */}
      {script && (
        <section className="mt2">
          <div className="row" style={{ marginBottom: '1rem' }}>
            <h2>{isSource ? 'The stories' : 'The script'}</h2>
            <span className="spacer" />
            {editing ? (
              <>
                <button className="btn" disabled={busy !== null} onClick={save}>
                  {busy === 'save' ? 'Saving...' : 'Save and re-check'}
                </button>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setDraft(script.beats);
                    setEditing(false);
                  }}
                >
                  Discard
                </button>
              </>
            ) : (
              <button className="btn ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
          </div>

          {editing && hasAudio && (
            <div className="error" style={{ marginBottom: '1rem' }}>
              This run has already been voiced. Saving a change here discards that audio, because it
              would be about different words.
            </div>
          )}

          <div className="stack">
            {(editing ? draft : script.beats).map((beat, i) => (
              <article className="beat" key={beat.beatId}>
                <div className="beat-head">
                  <span className="beat-id">{beat.beatId}</span>
                  <span className="faint mono" style={{ fontSize: '0.7rem' }}>
                    {beat.beatType}
                  </span>
                  <span className="spacer" />
                  <span className="faint mono" style={{ fontSize: '0.7rem' }}>
                    {beat.claimIds.length} {beat.claimIds.length === 1 ? 'fact' : 'facts'}
                  </span>
                </div>
                <div className="beat-body">
                  {editing ? (
                    <textarea
                      className="beat-edit"
                      value={beat.turns.map((t) => t.text).join('\n\n')}
                      onChange={(e) => {
                        const speaker = beat.turns[0]?.speaker ?? 'narrator';
                        const turns = e.target.value
                          .split(/\n{2,}/)
                          .map((text) => ({ speaker, text: text.trim() }))
                          .filter((t) => t.text.length > 0);
                        setDraft((prev) =>
                          prev.map((b, j) => (j === i ? { ...b, turns: turns.length ? turns : b.turns } : b))
                        );
                      }}
                    />
                  ) : (
                    <Prose turns={beat.turns} />
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* --- Evidence ------------------------------------------------------ */}
      {corpus && corpus.sources.length > 0 && (
        <section className="panel mt2">
          <div className="panel-head">
            <h3>What it read</h3>
            <span className="spacer" />
            <span className="faint mono" style={{ fontSize: '0.72rem' }}>
              {corpus.sources.length} documents
            </span>
          </div>
          <div className="panel-body">
            {corpus.sources.map((s) => (
              <div className="finding" key={s.id}>
                <span className="check">{s.tier ?? '-'}</span>
                <span>
                  <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--hold)' }}>
                    {s.title || s.url}
                  </a>
                  <div className="faint mono" style={{ fontSize: '0.7rem' }}>
                    {s.url.replace(/^https?:\/\//, '').slice(0, 88)}
                  </div>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
