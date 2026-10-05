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
import { MusicPanel } from '../components/MusicPanel';
import { SeriesPicker } from '../components/SeriesPicker';
import { TitleEditor } from '../components/TitleEditor';
import { useHold } from '../useHold';
import { FinalAudio } from '../components/FinalAudio';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  clock,
  money,
  until,
  watchJob,
  type ArtState,
  type Beat,
  type JobEvent,
  type Platform,
  type RunDetail,
} from '../api';
import { CostBar, ErrorNote, LiveLog, StageRail, StatePill, NowBanner } from '../components/bits';
import { Count, Info } from '../components/Info';
import { ImagePicker } from '../components/ImagePicker';

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
  // Who is working on this run. Somebody else: read and listen only.
  const hold = useHold(id);
  const [draft, setDraft] = useState<Beat[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  /** The second press. Publishing is the one thing here that cannot be undone. */
  const [confirming, setConfirming] = useState(false);
  const [art, setArt] = useState<ArtState | null>(null);

  const loadArt = useCallback(async () => {
    try {
      setArt(await api.runArtState(id));
    } catch {
      setArt(null);
    }
  }, [id]);

  useEffect(() => void loadArt(), [loadArt]);

  // A named series' cover, set on the episode that starts it.
  const [seriesArt, setSeriesArt] = useState<
    (ArtState & { title: string; created: boolean }) | null
  >(null);
  const seriesTitle = data?.manifest.seriesTitle;
  const loadSeriesArt = useCallback(async () => {
    if (!seriesTitle) return setSeriesArt(null);
    try {
      setSeriesArt(await api.runSeriesArtState(id));
    } catch {
      setSeriesArt(null);
    }
  }, [id, seriesTitle]);
  useEffect(() => void loadSeriesArt(), [loadSeriesArt]);

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
      // A blank template opens ready to write in.
      if (d.script?.beats.some((b) => b.turns.some((t) => t.text.includes('[WRITE:')))) {
        setEditing(true);
      }
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

  const { run, script, gate, manifest, claims, corpus, cuts, hasAudio, isSource, inSeries, long } = data;
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
  const ignored = (gate?.findings ?? []).filter((f) => f.ignored);
  const advisory = (gate?.findings ?? []).filter((f) => !f.blocking && !f.ignored);
  const published = run.state === 'published';

  // Ignore (or stop ignoring) one blocking finding, then reload so every part
  // of the page - the gate, Publish, the lists - sees the ruling.
  const rule = async (f: { check: string; detail: string }, ignore: boolean) => {
    setBusy(`rule-${f.check}`);
    try {
      await api.overrideFinding(id, f, ignore);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '0.9rem' }}>
        <h1 style={{ fontSize: '1.4rem' }}>{script?.title ?? run.topic}</h1>
        <div className="row nowrap">
          <StatePill state={live ? 'running' : run.state} stage={currentStage} />
          <Info label="What this run was asked for">
            {run.channelName} · {run.label} · {run.formatId}
            <br />
            <br />
            {run.topic}
          </Info>
          {!published && !live && !(hold?.holder && !hold.mine) && (
            <button
              className="btn ghost small"
              disabled={busy !== null}
              onClick={async () => {
                if (
                  !window.confirm(
                    'Discard this run? Its script and audio are deleted, and the topic is free to make again.'
                  )
                )
                  return;
                try {
                  await api.discard(id);
                  go(`/c/${run.channelId}`);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Discard run
            </button>
          )}
        </div>
      </div>

      {hold?.holder && !hold.mine && (
        <div className="stale-bar" style={{ position: 'static', marginBottom: '0.9rem', borderRadius: 8 }}>
          {hold.holder} is working on this right now
          {hold.since
            ? ` (since ${new Date(hold.since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})`
            : ''}
          . You can read and listen; editing opens when they leave it, or after 30 minutes without
          them touching it.
        </div>
      )}

      {/* HELD BY SOMEBODY ELSE: every control below is disabled at once, natively.
          The studio refuses their edits too; this is only so nobody tries. */}
      <fieldset
        disabled={Boolean(hold?.holder && !hold.mine)}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
      {/* What listeners see: editable until it is published. */}
      {script && !isSource && (
        <TitleEditor runId={id} script={script} locked={published} onSaved={() => void load()} />
      )}

      {/* Every episode belongs to a series; changeable until it is published. */}
      {long && !isSource && (
        <div style={{ marginBottom: '0.75rem' }}>
          <SeriesPicker
            runId={id}
            channelId={run.channelId}
            current={manifest.seriesTitle}
            locked={published}
            onSaved={() => void load()}
          >
            {/* THE SERIES COVER, 1920x1080: one picture for the whole series,
                set here when the series is new and changeable here afterwards. */}
            {seriesArt && (
              <ImagePicker
                title={`Series cover: ${seriesArt.title}`}
                note={
                  seriesArt.created
                    ? 'Shared by every episode in this series. Changing it here changes it on AudioVibe straight away.'
                    : 'A new series: give it a 1920x1080 cover. Every episode in it shares this, and it goes up when the first episode publishes. Without one, a cover is drawn.'
                }
                state={seriesArt}
                src={seriesArt.supplied ? `/api/run/series-art?id=${encodeURIComponent(id)}` : null}
                disabled={busy !== null || live}
                onUpload={async (image) => {
                  const r = await api.uploadRunSeriesArt(id, image);
                  await loadSeriesArt();
                  if (r.platform !== 'updated' && r.platform !== 'not created yet') throw new Error(r.platform);
                }}
                onRemove={async () => {
                  await api.removeRunSeriesArt(id);
                  await loadSeriesArt();
                }}
              />
            )}
          </SeriesPicker>
        </div>
      )}

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
              {live && <NowBanner events={events} startedAt={data.job?.startedAt} />}
              <LiveLog events={events} />
              <CostBar events={events} total={run.spentPence} />
            </div>
          </div>
        )}
      </div>

      {/* --- STOPPED PARTWAY: carry on from the last finished step. ------- */}
      {run.stalled && !live && (
        <section className="panel mt2">
          <div className="panel-body row">
            <h2 style={{ fontSize: '1.05rem' }}>Stopped partway</h2>
            <Info label="What resume does">
              This run stopped before it finished, usually because the studio was closed while it
              worked. Every finished step is kept, so resuming only redoes the step it stopped in.
            </Info>
            <span className="spacer" />
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => act('resume', () => api.resume(id))}
            >
              {busy === 'resume' ? 'Resuming...' : 'Resume'}
            </button>
          </div>
        </section>
      )}

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
                onClick={() => go(`/c/${run.channelId}/publish`)}
              >
                Approve them for publishing
              </button>
              <Info label="What happens next">
                Every story that passed its gate is on the channel&apos;s publishing page. Approve
                the ones you want and they get days there, within what the channel publishes in a
                week.
              </Info>
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
                        <StatePill state={c.state} stage={c.liveStage} />
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
          <h2>Final audio</h2>
          <p className="faint tiny" style={{ margin: '0.25rem 0 0' }}>
            Exactly what publishing sends, as every other page plays it.
          </p>
          <div className="player mt">
            <FinalAudio run={run} onChanged={() => void load()} player />
          </div>
          <div className="mt row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <strong className="tiny">Who it is for</strong>
            {(['general', 'mature'] as const).map((r) => (
              <button
                key={r}
                className={run.contentRating === r ? 'btn ghost on' : 'btn ghost'}
                disabled={published || live}
                onClick={() => void api.setContentRating(run.id, r).then(load)}
              >
                {r === 'general' ? 'Everyone' : 'Mature themes'}
              </button>
            ))}
            {run.contentRatingOverridden && !published && (
              <button className="btn ghost" onClick={() => void api.setContentRating(run.id, null).then(load)}>
                Use channel default
              </button>
            )}
            <span className="faint tiny">
              {published
                ? 'Sent with the episode; change it in the app now.'
                : run.contentRatingOverridden
                  ? 'Set for this one only.'
                  : "The channel's default."}{' '}
              Mature hides it from listeners under 18.
            </span>
          </div>
        </section>
      )}

      {/* --- Your own music under it, after the voice is made. Free. ------- */}
      {hasAudio && !isSource && (
        <section className="mt2">
          <h2>Background music</h2>
          <MusicPanel runId={id} disabled={live} onChanged={() => void load()} />
        </section>
      )}

      {/*
        --- The picture -----------------------------------------------------

        NOT SHOWN FOR A SOURCE SCRIPT, which is never published and therefore
        never has a cover. Offering one would be asking somebody to choose
        artwork for a thing that does not go anywhere.

        THE PREVIEW IS THE DRAWN COVER UNTIL SOMEBODY REPLACES IT, so what is
        on screen is always what would be published, rather than a blank frame
        that implies there is nothing yet.
      */}
      {!isSource && (
        <section className="mt2">
          <h2>The picture</h2>
          <div className="mt">
            <ImagePicker
              title={inSeries ? 'Episode image' : 'Audiocard image'}
              note={
                inSeries
                  ? 'What shows on this episode in its series, and on the lock screen while it plays.'
                  : 'What shows on the audiocard in the feed, and on the lock screen while it plays.'
              }
              state={art}
              src={`/api/run/art?id=${encodeURIComponent(id)}`}
              disabled={busy !== null || live}
              onUpload={async (image) => {
                await api.uploadRunArt(id, image);
                await loadArt();
              }}
              onRemove={async () => {
                await api.removeRunArt(id);
                await loadArt();
              }}
            />
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
              <span className="pill pass">{ignored.length ? 'passed (overridden)' : 'passed'}</span>
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
                <span style={{ flex: 1 }}>{f.detail}</span>
                {!published && (
                  <button
                    className="btn ghost small"
                    disabled={busy !== null || live}
                    onClick={() => void rule(f, true)}
                    title="You have checked this yourself and it is right. Recorded with your name."
                  >
                    Ignore
                  </button>
                )}
              </div>
            ))}
            {ignored.map((f, i) => (
              <div className="finding" key={`i${i}`} style={{ opacity: 0.7 }}>
                <span className="check" style={{ textDecoration: 'line-through' }}>
                  {f.check}
                </span>
                <span style={{ flex: 1 }}>
                  <span className="muted" style={{ textDecoration: 'line-through' }}>
                    {f.detail}
                  </span>
                  <span className="faint tiny"> ignored by {f.ignored?.by ?? 'somebody'}</span>
                </span>
                {!published && (
                  <button
                    className="btn ghost small"
                    disabled={busy !== null || live}
                    onClick={() => void rule(f, false)}
                  >
                    Undo
                  </button>
                )}
              </div>
            ))}
            {blocking.length > 0 && !published && (
              <p className="faint tiny" style={{ margin: '0.5rem 0 0' }}>
                Ignore a finding only after checking it yourself, for example after adding facts by
                hand. Once nothing is blocking, it passes and goes to To decide. An edit that changes
                a finding makes it block again.
              </p>
            )}
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
            <span className="muted">Out in the world.</span>
            {run.archivedAt && (
              <span
                className="pill"
                title="Every file is kept in the R2 archive; its audio plays and downloads from there."
              >
                archived to R2 {new Date(run.archivedAt).toLocaleDateString('en-GB')}
              </span>
            )}
            <span className="spacer" />
            {/* Somewhere to go next, rather than a dead end. */}
            <button
              className="btn ghost small"
              onClick={() => go(`/c/${run.channelId}/publish`)}
            >
              What is next
            </button>
            <button className="btn ghost small" onClick={() => go(`/c/${run.channelId}`)}>
              {run.channelName}
            </button>
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
      </fieldset>
    </div>
  );
};
