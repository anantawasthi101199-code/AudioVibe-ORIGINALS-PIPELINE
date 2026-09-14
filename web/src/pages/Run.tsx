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
  watchJob,
  type Beat,
  type JobEvent,
  type RunDetail,
} from '../api';
import { CostBar, ErrorNote, LiveLog, StageRail, StatePill, Stat } from '../components/bits';

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
      <div className="page-head">
        <div className="eyebrow">
          {run.channelName} · e{String(run.episode).padStart(3, '0')}
          {run.short ? `-s${String(run.short).padStart(2, '0')}` : ''}
        </div>
        <h1>{script?.title ?? run.topic}</h1>
        <p className="lede">{run.topic}</p>
        <div className="row mt">
          <StatePill state={live ? 'running' : run.state} />
          <span className="pill">{run.formatId}</span>
          {run.durationS !== null && <span className="pill">{clock(run.durationS)} of audio</span>}
          <span className="pill">{money(run.spentPence)} spent</span>
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
              <div style={{ flex: 1, minWidth: '20rem' }}>
                <h2>Held before the render</h2>
                <p className="muted" style={{ marginTop: '0.4rem', maxWidth: '58ch' }}>
                  Nothing has been voiced. Read it below, change anything that needs changing, and
                  approve it when you are happy. Approving is the only step here that spends real
                  money.
                </p>
              </div>
              <button
                className="btn spend"
                disabled={busy !== null}
                onClick={() => act('approve', () => api.approve(id))}
              >
                {busy === 'approve' ? 'Voicing...' : 'Approve and voice it'}
              </button>
            </div>
          </div>
        </section>
      )}

      {isSource && script && !live && (
        <section className="panel mt2">
          <div className="panel-body row">
            <div style={{ flex: 1, minWidth: '20rem' }}>
              <h2>{cuts.length > 0 ? `${cuts.length} shorts cut` : 'Not cut yet'}</h2>
              <p className="muted" style={{ marginTop: '0.4rem', maxWidth: '58ch' }}>
                This is a source script. It is never voiced or published whole; each story becomes
                its own short, with its own audio, ledger and gate.
              </p>
            </div>
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
            <div className="panel-body" style={{ paddingTop: 0 }}>
              <table className="runs">
                <thead>
                  <tr>
                    <th>Story</th>
                    <th>State</th>
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
      <section className="mt2">
        <div className="grid three">
          <Stat value={money(run.spentPence)} label="spent" money />
          <Stat
            value={claims?.claims.length ?? 0}
            label={claims?.claims.length === 1 ? 'fact bound to a quote' : 'facts bound to quotes'}
          />
          <Stat
            value={corpus?.sources.length ?? 0}
            label={corpus?.sources.length === 1 ? 'document read' : 'documents read'}
          />
          <Stat
            value={script?.beats.length ?? 0}
            label={isSource ? 'stories' : script?.beats.length === 1 ? 'beat' : 'beats'}
          />
          <Stat value={gate?.measurement?.words ?? 0} label="words" />
          <Stat
            value={gate?.measurement ? gate.measurement.sentenceWordsMean.toFixed(1) : '-'}
            label="mean sentence"
          />
        </div>
      </section>

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
