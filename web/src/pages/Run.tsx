/**
 * One run: watch it, read it, change it, then decide whether to voice it.
 *
 * TWO COLUMNS, ONE NEXT STEP (2026-10-08). The page used to be one long column
 * where the button that mattered could be a screen below the fold - and for a
 * run that was approved but never voiced there was no button at all. Now:
 *
 *   - The NEXT STEP card sits at the top of the left column and always says,
 *     in one sentence, where the run is and what to press. Its colour is the
 *     run's state: amber while working, blue to read, orange to finish, green
 *     to publish, red when something blocks.
 *   - The left column is the work: progress, sound, the script, the gate.
 *   - The right column is the record: what it cost against its target and
 *     ceiling, what listeners will see, its series, its numbers.
 *
 * THE SCRIPT IS SHOWN AS PROSE, NOT AS A FORM. This is the one screen where
 * somebody is judging writing rather than scanning a record, so it gets a real
 * measure, real leading, and the delivery tags kept visible but quiet. Editing
 * is a mode you enter, not the default.
 */
import { MusicPanel } from '../components/MusicPanel';
import { SeriesPicker } from '../components/SeriesPicker';
import { TitleEditor } from '../components/TitleEditor';
import { useHold } from '../useHold';
import { FinalAudio } from '../components/FinalAudio';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ago,
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
  type VoiceChoice,
  type VoiceEngine,
} from '../api';
import {
  BudgetMeter,
  CostBar,
  ErrorNote,
  LiveLog,
  NowBanner,
  ProgressBars,
  StageRail,
  StatePill,
} from '../components/bits';
import { Count, Info } from '../components/Info';
import { ImagePicker } from '../components/ImagePicker';
import { fromWhole, toWhole } from '../scriptText';

const engineName = (e: VoiceEngine) => (e === 'elevenlabs' ? 'ElevenLabs' : 'GPT');

/**
 * Which engine voices this run, and what that will roughly cost against what
 * is left under the ceiling. GPT is the default and the cheap one; ElevenLabs
 * reads the [tags] as direction.
 */
const EnginePicker = ({
  value,
  onChange,
  disabled,
  tagPassDone,
  estimate,
  left,
}: {
  value: VoiceChoice;
  onChange: (choice: VoiceChoice) => void;
  disabled: boolean;
  tagPassDone: boolean;
  estimate: RunDetail['voiceEstimate'];
  /** Pence left under the hard ceiling. */
  left: number;
}) => {
  const cost = estimate ? estimate[value.engine] : null;
  return (
    <div className="engine">
      <div className="engine-choices" role="radiogroup" aria-label="Voice engine">
        {(['openai', 'elevenlabs'] as const).map((e) => (
          <button
            key={e}
            type="button"
            role="radio"
            aria-checked={value.engine === e}
            className={`engine-choice${value.engine === e ? ' on' : ''}`}
            disabled={disabled}
            onClick={() => onChange({ ...value, engine: e })}
          >
            <strong>{e === 'openai' ? 'GPT' : 'ElevenLabs'}</strong>
            <span className="faint tiny">
              {e === 'openai' ? 'cheap draft voice' : 'the real voice, reads [tags]'}
              {estimate ? ` · about ${money(Math.max(1, estimate[e]))}` : ''}
            </span>
          </button>
        ))}
      </div>
      {value.engine === 'elevenlabs' && (
        <label className="row tiny" style={{ gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={value.tagPass}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, tagPass: e.target.checked })}
          />
          <span>
            Tag pass first: one cheap call adds [tags] from the channel&apos;s list, words unchanged
            {tagPassDone ? '. One already ran on this script; ticking runs another.' : '. Unticked, the script is voiced exactly as written.'}
          </span>
        </label>
      )}
      {cost !== null && cost > left && (
        <div className="note warn tiny">
          This voicing is estimated at {money(cost)} and the run has {money(Math.max(0, left))} left
          under its hard ceiling. It will finish anyway, but after it nothing more can be spent on
          this run (no regenerating).
        </div>
      )}
    </div>
  );
};

/** The script's parts without the outro: the editors never touch the outro. */
const withoutOutro = (beats: Beat[]): Beat[] =>
  beats.map((b) => ({ ...b, turns: b.turns.filter((t) => !t.fixed) }));

/** Delivery tags are part of the script and are not part of the sentence. */
const Prose = ({ turns }: { turns: Beat['turns'] }) => (
  <div className="prose">
    {turns.map((t, i) => (
      <p key={i} style={{ margin: i ? '1.1rem 0 0' : 0 }}>
        {t.text.split(/(\[[a-z][a-z ,'-]{0,47}\])/gi).map((part, j) =>
          /^\[[a-z][a-z ,'-]{0,47}\]$/i.test(part) ? (
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
  const [showLog, setShowLog] = useState(false);
  // Who is working on this run. Somebody else: read and listen only.
  const hold = useHold(id);
  const [draft, setDraft] = useState<Beat[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Which engine (and tag pass) the next voicing uses. Starts from the run's record.
  const [voiceChoice, setVoiceChoice] = useState<VoiceChoice | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  /** The second press. Publishing is the one thing here that cannot be undone. */
  const [confirming, setConfirming] = useState(false);
  /** Regenerating: 0 closed, 1 choosing the engine, 2 the second confirmation. */
  const [regen, setRegen] = useState<0 | 1 | 2>(0);
  const [stopping, setStopping] = useState(false);
  /** The outro list, open or shut. */
  const [outroOpen, setOutroOpen] = useState(false);
  /** How the script is being edited: part by part, or as one pasted box. Never both. */
  const [editMode, setEditMode] = useState<'beats' | 'whole'>('beats');
  const [wholeText, setWholeText] = useState('');
  const [wholeError, setWholeError] = useState<string | null>(null);
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
      setDraft(withoutOutro(d.script?.beats ?? []));
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
          setStopping(false);
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

  // UNSAVED WORDS ARE NOT LOST BY ACCIDENT: closing or reloading the tab while
  // the script is open for editing asks first.
  useEffect(() => {
    if (!editing) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editing]);

  // SOMEBODY ELSE'S WORK, seen from here: while they hold it, look again now
  // and then, so their voicing appears without a reload.
  const othersHold = Boolean(hold?.holder && !hold.mine);
  useEffect(() => {
    if (!othersHold || live) return;
    const t = window.setInterval(() => {
      void load().then((d) => {
        if (d?.job && !d.job.finishedAt) follow(d.job.id);
      });
    }, 15_000);
    return () => window.clearInterval(t);
  }, [othersHold, live, load, follow]);

  if (error && !data) return <div className="page"><ErrorNote>{error}</ErrorNote></div>;
  if (!data) return <div className="page"><div className="empty">Reading the run.</div></div>;

  const { run, script, gate, manifest, claims, corpus, cuts, hasAudio, isSource, inSeries, long } = data;
  const held = manifest.holdForApproval && !manifest.approvedAt;
  const chosenVoice: VoiceChoice = voiceChoice ?? {
    engine: manifest.voiceEngine ?? 'openai',
    // UNTICKED BY DEFAULT: ElevenLabs voices the script as written, and the
    // tag pass runs only when somebody ticks it for this voicing.
    tagPass: false,
  };
  const currentStage = live ? (events[events.length - 1]?.stage ?? null) : null;
  const left = run.ceilingPence - run.spentPence;
  const isShort = !long;

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

  /** The beats as they will be saved, from whichever editor is open. */
  const draftBeats = (): Beat[] | null => {
    if (editMode === 'beats') return draft;
    const parsed = fromWhole(wholeText, script ? withoutOutro(script.beats) : draft);
    if (!parsed.ok) {
      setWholeError(parsed.error);
      return null;
    }
    setWholeError(null);
    return parsed.beats;
  };

  const switchMode = (mode: 'beats' | 'whole') => {
    if (mode === editMode) return;
    if (mode === 'whole') {
      setWholeText(toWhole(draft));
      setWholeError(null);
      setEditMode('whole');
      return;
    }
    const beats = draftBeats();
    if (!beats) return; // stay in the box until it reads as the script's parts
    setDraft(beats);
    setEditMode('beats');
  };

  const stopEditing = () => {
    setEditing(false);
    setEditMode('beats');
    setWholeError(null);
  };

  const save = async () => {
    if (!script) return;
    const beats = draftBeats();
    if (!beats) return;
    setBusy('save');
    setError(null);
    try {
      await api.saveScript(id, {
        title: script.title,
        description: script.description,
        beats,
      });
      stopEditing();
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
  // The gate on disk before the voice is made is the pre-voice check, which is
  // what a person reads to decide - not the verdict on the audio.
  const gateIsFinal = isSource || run.completed.includes('qa');
  // THE OUTRO IS PART OF THE SAVED SCRIPT, so it follows the script's rules:
  // fixed once published, and not while the words are open for editing or the
  // run is working.
  const outroLockReason = published
    ? 'Published: the outro is fixed.'
    : live
      ? 'Working: change the outro when it stops.'
      : editing
        ? 'Save and re-check the script first, then choose the outro.'
        : null;
  const outroLocked = outroLockReason !== null || busy !== null;

  const changeOutro = async (enabled: boolean, index: number) => {
    const voiced = run.completed.includes('render');
    if (
      voiced &&
      !window.confirm(
        'This run is voiced. Changing the outro changes the script, so it will need voicing again (only the last part is re-voiced). Go ahead?'
      )
    )
      return;
    setBusy('outro');
    setError(null);
    try {
      await api.setOutro(id, enabled, index);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // A finished voice to regenerate, nothing working, and the choice not fixed.
  const regenAllowed =
    !isSource &&
    !published &&
    !live &&
    !data.takes.locked &&
    run.completed.includes('render') &&
    run.completed.includes('qa');

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

  // The job's error and the run's recorded failure are usually the same words.
  const failure = run.lastFailure;
  const shownError = error && error !== failure?.message ? error : null;

  const engineFor = (verb: string) => (
    <EnginePicker
      value={chosenVoice}
      onChange={setVoiceChoice}
      disabled={busy !== null}
      tagPassDone={!!manifest.tagPassAt}
      estimate={data.voiceEstimate}
      left={left}
      key={verb}
    />
  );

  const FailureNote = () =>
    failure ? (
      <div className="note fail">
        <strong>Last attempt stopped{failure.stage ? ` while ${failure.stage === 'render' ? 'voicing' : failure.stage}` : ''}</strong>{' '}
        <span className="faint tiny">{ago(failure.at)}</span>
        <div className="tiny" style={{ marginTop: '0.25rem' }}>{failure.message}</div>
      </div>
    ) : null;

  // WORDS BEING EDITED ARE NOT WORDS TO VOICE (owner, 2026-10-08). Voicing
  // reads the saved script, so while the editor is open every button that
  // spends on it waits for Save and re-check, and says so beside itself.
  const EditLock = () =>
    editing ? (
      <div className="note warn tiny edit-lock">
        <strong>The script is open for editing.</strong> Save and re-check it first, so what is
        voiced is what you wrote.{' '}
        <button
          type="button"
          className="btn ghost small"
          onClick={() => document.getElementById('script')?.scrollIntoView({ behavior: 'smooth' })}
        >
          Go to Save
        </button>
      </div>
    ) : null;

  // AT THE HARD CEILING: the voicing that crossed it was allowed to finish,
  // and nothing more is spent on this run. Its takes can still be published.
  const CeilingLock = () =>
    run.atCeiling ? (
      <div className="note fail tiny">
        <strong>
          This run has reached its hard ceiling ({money(run.spentPence)} of {money(run.ceilingPence)}).
        </strong>{' '}
        Nothing more can be spent on it, so voicing and regenerating are off. Its takes can still be
        chosen and published.
      </div>
    ) : null;

  // TOO LONG (owner, 2026-10-09): a loud warning past 15 min (episode) or 3 min
  // (short); past 20 or 5 the voice is blocked until the script is cut down.
  // WHILE EDITING, THE LENGTH FOLLOWS THE WORDS AS THEY ARE TYPED: the same
  // count the studio makes (tags left out, the outro in), at its 2.85 words a second.
  const liveLen = (() => {
    const saved = data.length;
    if (!editing || !saved) return saved;
    const text =
      (editMode === 'whole' ? wholeText.replace(/^##\s.*$/gm, ' ') : draft.flatMap((b) => b.turns.map((t) => t.text)).join(' ')) +
      ' ' +
      (data.outro.current ?? '');
    const words = text
      .replace(/\[[^\]]{1,48}\]/g, ' ')
      .split(/\s+/)
      .filter((w) => /[a-z0-9]/i.test(w)).length;
    const seconds = words / 2.85;
    const level: 'ok' | 'warn' | 'block' = seconds > saved.blockSeconds ? 'block' : seconds > saved.warnSeconds ? 'warn' : 'ok';
    return { ...saved, words, seconds, level };
  })();
  const len = liveLen;
  const tooLong = len?.level === 'block';
  const LengthNote = () =>
    len && len.level !== 'ok' ? (
      <div className={`length-alarm ${len.level}`}>
        <strong>
          {len.level === 'block' ? 'Too long to voice' : 'Running long'}: about {clock(len.seconds)} (
          {len.words.toLocaleString()} words)
        </strong>
        <span>
          {len.level === 'block'
            ? `A ${len.kind} cannot be voiced past ${len.blockSeconds / 60} minutes (${len.blockWords.toLocaleString()} words). Cut it down and save, then voice it.`
            : `A ${len.kind} should stay under ${len.warnSeconds / 60} minutes (${len.warnWords.toLocaleString()} words). It can still be voiced; past ${len.blockSeconds / 60} minutes it cannot.`}
        </span>
      </div>
    ) : null;

  /* --- THE NEXT STEP ----------------------------------------------------- */
  const nextStep = (() => {
    if (live) {
      return (
        <section className="next working">
          <div className="next-head">
            <span className="next-kicker">Working now</span>
            <span className="spacer" />
            <button
              className="btn ghost small"
              disabled={stopping}
              title="Stops after the paid step it is on; everything paid for is kept, and Resume carries on."
              onClick={async () => {
                if (!window.confirm('Stop this now? It stops after the step it is on; everything already paid for is kept, and Resume carries on later.')) return;
                setStopping(true);
                try {
                  await api.stop(id);
                } catch (e) {
                  setError((e as Error).message);
                  setStopping(false);
                }
              }}
            >
              {stopping ? 'Stopping after this step...' : 'Stop'}
            </button>
            <span className="pill live">
              <span className="dot" /> live
            </span>
          </div>
          <NowBanner events={events} startedAt={data.job?.startedAt} startedBy={data.job?.startedBy} />
          <ProgressBars events={events} engine={manifest.voiceEngine} />
          <p className="faint tiny" style={{ margin: 0 }}>
            You can leave this page; the work carries on and this card picks it back up. A
            voicing that passes the hard ceiling finishes; nothing more is spent after it.
          </p>
        </section>
      );
    }
    if (isSource && script) {
      return (
        <section className="next">
          <div className="next-head">
            <span className="next-kicker">Source script</span>
            <Info label="What a source script is">
              This is a source script. It is never voiced or published whole; each story becomes its
              own short, with its own audio, its own ledger and its own gate.
            </Info>
          </div>
          <h2>{cuts.length > 0 ? `${cuts.length} shorts cut from this` : 'Cut it into shorts'}</h2>
          <EditLock />
          <div className="next-actions">
            <button className="btn spend" disabled={busy !== null || editing} onClick={() => act('cut', () => api.cut(id))}>
              {busy === 'cut' ? 'Cutting...' : cuts.length ? 'Cut again' : `Cut ${script.beats.length} shorts`}
            </button>
            {cuts.length > 0 && (
              <button className="btn" onClick={() => go(`/c/${run.channelId}/publish`)}>
                Approve them for publishing
              </button>
            )}
          </div>
        </section>
      );
    }
    if (held && script) {
      return (
        <section className="next read">
          <div className="next-head">
            <span className="next-kicker">Step 1 of 2 · Read it</span>
            <Info label="What held means">
              Nothing has been voiced. Read it below, change anything that needs changing, and
              approve it when you are happy. Approving is the only step here that spends real money,
              and it is the last point at which the words are free to change.
            </Info>
          </div>
          <h2>Read the script, then approve and voice it</h2>
          {engineFor('approve')}
          <EditLock />
          <CeilingLock />
          <LengthNote />
          <div className="next-actions">
            <button
              className="btn spend"
              disabled={busy !== null || editing || run.atCeiling || tooLong}
              onClick={() => act('approve', () => api.approve(id, chosenVoice))}
            >
              {busy === 'approve' ? 'Starting...' : `Approve and voice on ${engineName(chosenVoice.engine)}`}
            </button>
          </div>
        </section>
      );
    }
    if (run.state === 'needs-voice' || run.stalled) {
      const voiceOnly = run.state === 'needs-voice';
      return (
        <section className="next finish">
          <div className="next-head">
            <span className="next-kicker">{voiceOnly ? 'Step 2 of 2 · Voice it' : 'Stopped partway'}</span>
            <Info label="What this does">
              {voiceOnly
                ? 'It is approved and written, but there is no current audio: the last voicing stopped, or an edit or an engine change discarded it. Voicing again keeps every beat already made on the chosen engine.'
                : 'This run stopped before it finished, usually because the studio was closed while it worked. Every finished step is kept, so resuming only redoes the step it stopped in.'}
            </Info>
          </div>
          <h2>{voiceOnly ? 'Approved, not voiced yet' : 'Carry on from where it stopped'}</h2>
          <FailureNote />
          {engineFor('resume')}
          <EditLock />
          <CeilingLock />
          <LengthNote />
          <div className="next-actions">
            <button
              className="btn spend"
              disabled={busy !== null || editing || run.atCeiling || tooLong}
              onClick={() => act('resume', () => api.resume(id, chosenVoice))}
            >
              {busy === 'resume'
                ? 'Starting...'
                : voiceOnly
                  ? `Voice it on ${engineName(chosenVoice.engine)}`
                  : 'Resume'}
            </button>
          </div>
        </section>
      );
    }
    if (published) {
      return (
        <section className="next done">
          <div className="next-head">
            <span className="next-kicker">Published</span>
            {run.archivedAt && (
              <span className="pill" title="Every file is kept in the R2 archive; its audio plays and downloads from there.">
                archived to R2 {new Date(run.archivedAt).toLocaleDateString('en-GB')}
              </span>
            )}
          </div>
          <h2>Out in the world</h2>
          <div className="next-actions">
            <button className="btn ghost" onClick={() => go(`/c/${run.channelId}/publish`)}>
              What is next
            </button>
            <button className="btn ghost" onClick={() => go(`/c/${run.channelId}`)}>
              {run.channelName}
            </button>
          </div>
        </section>
      );
    }
    if (run.state === 'failed') {
      return (
        <section className="next blocked">
          <div className="next-head">
            <span className="next-kicker">Blocked by the gate</span>
          </div>
          <h2>
            {blocking.length} {blocking.length === 1 ? 'finding blocks' : 'findings block'} it
          </h2>
          <p className="muted tiny" style={{ margin: 0 }}>
            Fix the script below and save (re-checking is free), or ignore a finding you have checked
            yourself. Once nothing blocks, it moves to To decide.
          </p>
          <div className="next-actions">
            <a className="btn" href="#gate" onClick={(e) => { e.preventDefault(); document.getElementById('gate')?.scrollIntoView({ behavior: 'smooth' }); }}>
              See the findings
            </a>
          </div>
        </section>
      );
    }
    if (run.state === 'ready' && gate?.passed && !isSource) {
      return (
        <section className="next pass">
          <div className="next-head">
            <span className="next-kicker">Ready</span>
            <Info label="What publishing does">
              It goes out as the channel&apos;s own account, through the same upload the platform
              gives every creator, carrying the AI label and the list of what it read. Followers are
              notified, feeds cache it and the seen ledger records it. None of that can be taken
              back. Approving it for a day on the publishing page lets it go out at its slot instead.
            </Info>
            <span className="spacer" />
            {platform?.configured && (
              <span className={`where${platform.isProduction ? ' live' : ''}`}>
                <span className="dot" />
                {platform.isProduction ? 'production' : new URL(platform.url!).hostname}
              </span>
            )}
          </div>
          <h2>
            {run.releaseAt
              ? `Approved, goes out ${until(run.releaseAt)}`
              : run.heldAt
                ? 'Passed, parked on hold'
                : 'Passed: listen, then publish or give it a day'}
          </h2>
          {gate.needsHumanReview &&
            gate.humanReviewReasons.map((r, i) => (
              <div className="finding" key={i}>
                <span className="check" style={{ color: 'var(--hold)' }}>read first</span>
                <span className="muted">{r}</span>
              </div>
            ))}
          <EditLock />
          <div className="next-actions">
            {!run.releaseApprovedAt && (
              <button className="btn" onClick={() => go(`/c/${run.channelId}/publish`)}>
                Approve for a day
              </button>
            )}
            {confirming ? (
              <>
                <button className="btn ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  className="btn spend"
                  disabled={busy !== null || editing}
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
                className="btn ghost"
                disabled={busy !== null || !platform?.configured || editing}
                onClick={() => setConfirming(true)}
              >
                Publish now
              </button>
            )}
          </div>
        </section>
      );
    }
    return (
      <section className="next">
        <div className="next-head">
          <span className="next-kicker">Waiting</span>
        </div>
        <h2>Nothing to do here yet</h2>
        <FailureNote />
      </section>
    );
  })();

  return (
    <div className="page wide">
      {/* --- Who and what ------------------------------------------------ */}
      <header className="run-head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">
            {run.channelName} · {run.label} · {isSource ? 'source script' : isShort ? 'short' : 'episode'}
          </div>
          <h1 className="run-title">{script?.title ?? run.topic}</h1>
          <div className="run-chips">
            <StatePill state={live ? 'running' : run.state} stage={currentStage} />
            {!isSource && <span className="chip-static">voice: {engineName(manifest.voiceEngine ?? 'openai')}</span>}
            {run.durationS !== null && <span className="chip-static mono">{clock(run.durationS)}</span>}
            <span className="chip-static">made {ago(run.createdAt)}</span>
            {data.job?.startedBy && live && <span className="chip-static who">working: {data.job.startedBy}</span>}
            {hold?.mine && <span className="chip-static who mine">you have this open</span>}
          </div>
        </div>
        <div className="row nowrap">
          <Info label="What this run was asked for">
            {run.channelName} · {run.label} · {run.formatId}
            <br />
            <br />
            {run.topic}
          </Info>
          {!published && !live && !othersHold && (
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
      </header>

      {othersHold && (
        <div className="lockbar">
          <span className="lock-dot" />
          <span>
            <strong>{hold!.holder}</strong> is working on this
            {hold!.since
              ? ` (since ${new Date(hold!.since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})`
              : ''}
            . You can read and listen; editing opens when they leave it, or after 30 minutes without
            them touching it.
          </span>
        </div>
      )}

      <StageRail completed={run.completed} live={currentStage} skip={isSource ? ['render', 'qa'] : []} />

      <ErrorNote>{shownError}</ErrorNote>

      {/* HELD BY SOMEBODY ELSE: every control below is disabled at once, natively.
          The studio refuses their edits too; this is only so nobody tries. */}
      <fieldset disabled={othersHold} className="run-fieldset">
        <div className="run-grid">
          {/* ================= LEFT: the work ================= */}
          <div className="run-main">
            {nextStep}

            {/* What the last job said, folded away when nothing is running. */}
            {events.length > 0 && (
              <section className="panel">
                <div className="panel-head">
                  <button className="panel-tap" onClick={() => setShowLog((v) => !v)}>
                    <span className={`caret${showLog || live ? ' open' : ''}`}>›</span>
                    <h3>{live ? 'Live log' : 'What happened last time'}</h3>
                  </button>
                  <span className="spacer" />
                  <span className="faint mono tiny">{events.length} lines</span>
                </div>
                {(showLog || live) && (
                  <div className="panel-body">
                    <LiveLog events={events} />
                  </div>
                )}
              </section>
            )}

            {/* Cuts from a source, as a table. */}
            {isSource && cuts.length > 0 && (
              <section className="panel">
                <div className="panel-head">
                  <h3>The shorts</h3>
                  <span className="spacer" />
                  <Info label="What happens next">
                    Every story that passed its gate is on the channel&apos;s publishing page. Approve the
                    ones you want and each gets the next free day: at most one short and one episode a day.
                  </Info>
                </div>
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
                            {c.releaseAt ? <span title={c.releaseAt}>{until(c.releaseAt)}</span> : <span className="faint">-</span>}
                          </td>
                          <td className="right num">{clock(c.durationS)}</td>
                          <td className="right num">{money(c.spentPence)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* --- Sound: the final audio and the music under it -------------- */}
            {!isSource && (
              <section className="panel sound">
                <div className="panel-head">
                  <h3>Sound</h3>
                  <span className="spacer" />
                  {hasAudio ? (
                    <span className="faint tiny">Exactly what publishing sends.</span>
                  ) : (
                    <span className="pill warn">no audio yet</span>
                  )}
                </div>
                <div className="panel-body stack">
                  {hasAudio ? (
                    <>
                      {run.state === 'needs-voice' && (
                        <div className="note warn tiny">
                          This is the audio from before the last change. It is not what will be
                          published: voice it again above.
                        </div>
                      )}
                      <div className="player">
                        <FinalAudio run={run} onChanged={() => void load()} player />
                      </div>
                      <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <strong className="tiny">Who it is for</strong>
                        {(['general', 'mature'] as const).map((r) => (
                          <button
                            key={r}
                            className={run.contentRating === r ? 'btn ghost small on' : 'btn ghost small'}
                            disabled={published || live}
                            onClick={() => void api.setContentRating(run.id, r).then(load)}
                          >
                            {r === 'general' ? 'Everyone' : 'Mature themes'}
                          </button>
                        ))}
                        {run.contentRatingOverridden && !published && (
                          <button className="btn ghost small" onClick={() => void api.setContentRating(run.id, null).then(load)}>
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
                      <details className="fold">
                        <summary>Background music</summary>
                        <div className="mt">
                          <MusicPanel runId={id} disabled={live} onChanged={() => void load()} />
                        </div>
                      </details>
                    </>
                  ) : (
                    <p className="faint tiny" style={{ margin: 0 }}>
                      {live
                        ? 'The voice is being made; the player appears here when it is done.'
                        : 'Nothing voiced yet. The card above says how to voice it.'}
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* --- Takes: every voicing kept, one chosen to publish ---------- */}
            {!isSource && (data.takes.takes.length > 0 || run.completed.includes('render')) && (
              <section className="panel takes" id="takes">
                <div className="panel-head">
                  <h3>Takes</h3>
                  <span className="faint mono tiny">{data.takes.takes.length}</span>
                  <Info label="How takes work">
                    Every finished voicing is kept as a take. Regenerating voices the same saved
                    script again from scratch as a new take, and never replaces the one chosen:
                    listen to both and choose which one publishes. Once it is approved for a day or
                    published the choice is fixed, and the other takes stay as drafts. Choosing
                    another take drops any music mix, so mix again after. Each regeneration of a
                    short adds 15p to its budget.
                  </Info>
                  <span className="spacer" />
                  {regenAllowed && regen === 0 && (
                    <button
                      className="btn ghost small"
                      disabled={busy !== null || editing || run.atCeiling || tooLong}
                      onClick={() => setRegen(1)}
                    >
                      Regenerate voice
                    </button>
                  )}
                </div>
                <div className="panel-body stack tight">
                  {data.takes.locked && data.takes.takes.length > 1 && (
                    <div className="note tiny">The choice is fixed: {data.takes.locked}</div>
                  )}
                  {data.takes.takes.length === 0 && (
                    <p className="faint tiny" style={{ margin: 0 }}>The current voice becomes take 1.</p>
                  )}
                  {[...data.takes.takes].reverse().map((t) => {
                    const chosen = data.takes.chosen === t.id;
                    const canChoose = !chosen && !t.earlierScript && !data.takes.locked && !live && !editing;
                    return (
                      <div key={t.id} className={`take${chosen ? ' chosen' : ''}${t.earlierScript ? ' old' : ''}`}>
                        <label className="take-pick">
                          <input
                            type="radio"
                            name="take"
                            checked={chosen}
                            disabled={!canChoose && !chosen}
                            onChange={async () => {
                              setBusy('take');
                              setError(null);
                              try {
                                await api.chooseTake(id, t.id);
                                await load();
                              } catch (e) {
                                setError((e as Error).message);
                              } finally {
                                setBusy(null);
                              }
                            }}
                          />
                          <span className="take-name">Take {t.id}</span>
                        </label>
                        <span className="take-meta faint tiny">
                          {t.engine === 'elevenlabs' ? 'ElevenLabs' : t.engine === 'openai' ? 'GPT' : t.engine} ·{' '}
                          {clock(t.durationS)} · {ago(t.createdAt)}
                          {t.by ? ` · ${t.by}` : ''}
                        </span>
                        <span className="take-badges">
                          {chosen ? (
                            <span className="pill pass">{published ? 'published' : 'publishes'}</span>
                          ) : t.earlierScript ? (
                            <span className="pill">earlier script</span>
                          ) : (
                            <span className="pill">draft</span>
                          )}
                        </span>
                        <audio
                          className="take-player"
                          controls
                          preload="none"
                          src={api.takeAudioUrl(id, t)}
                        />
                      </div>
                    );
                  })}

                  {/* REGENERATING ASKS TWICE: once to choose the engine and see
                      the cost, and once more to spend it. */}
                  {regen > 0 && regenAllowed && (
                    <div className="regen">
                      {regen === 1 ? (
                        <>
                          <strong>Make a new take?</strong>
                          <span className="muted tiny">
                            The saved script is voiced again from scratch. Take{' '}
                            {data.takes.chosen ?? 1} stays chosen until you pick another.
                          </span>
                          {engineFor('regen')}
                          <EditLock />
                          <CeilingLock />
                          <LengthNote />
                          <div className="next-actions">
                            <button className="btn ghost small" onClick={() => setRegen(0)}>
                              Cancel
                            </button>
                            <button className="btn small" disabled={busy !== null || editing || run.atCeiling || tooLong} onClick={() => setRegen(2)}>
                              Yes, make a new take
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <strong>
                            Really spend about{' '}
                            {money(Math.max(1, data.voiceEstimate?.[chosenVoice.engine] ?? 0))} on{' '}
                            {engineName(chosenVoice.engine)}?
                          </strong>
                          <span className="muted tiny">
                            This cannot be taken back. The budget grows by{' '}
                            {isShort ? '15p' : '£1'} for this regeneration.
                          </span>
                          <div className="next-actions">
                            <button className="btn ghost small" onClick={() => setRegen(0)}>
                              No, stop
                            </button>
                            <button
                              className="btn spend small"
                              disabled={busy !== null || editing || run.atCeiling || tooLong}
                              onClick={() => {
                                setRegen(0);
                                void act('regen', () => api.regenerate(id, chosenVoice));
                              }}
                            >
                              {busy === 'regen' ? 'Starting...' : 'Confirm: regenerate'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* --- The script ---------------------------------------------- */}
            {script && (
              <section className="panel" id="script">
                <div className="panel-head">
                  <h3>{isSource ? 'The stories' : 'The script'}</h3>
                  <span className="faint mono tiny">
                    {script.beats.length} {isSource ? 'stories' : 'beats'} ·{' '}
                    {len ? (
                      <span className={`length-chip ${len.level}`}>
                        about {clock(len.seconds)} · {len.words.toLocaleString()} words
                      </span>
                    ) : (
                      `${gate?.measurement?.words ?? '?'} words`
                    )}
                  </span>
                  <span className="spacer" />
                  {editing ? (
                    <>
                      {/* EITHER OR: one editor open at a time. */}
                      <div className="segmented" role="tablist" aria-label="How to edit">
                        <button
                          role="tab"
                          aria-selected={editMode === 'beats'}
                          className={editMode === 'beats' ? 'on' : ''}
                          onClick={() => switchMode('beats')}
                        >
                          By part
                        </button>
                        <button
                          role="tab"
                          aria-selected={editMode === 'whole'}
                          className={editMode === 'whole' ? 'on' : ''}
                          onClick={() => switchMode('whole')}
                        >
                          Whole script
                        </button>
                      </div>
                      <button className="btn small" disabled={busy !== null} onClick={save}>
                        {busy === 'save' ? 'Saving...' : 'Save and re-check'}
                      </button>
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          setDraft(withoutOutro(script.beats));
                          stopEditing();
                        }}
                      >
                        Discard changes
                      </button>
                    </>
                  ) : (
                    !published && (
                      <button className="btn ghost small" disabled={live} onClick={() => setEditing(true)}>
                        Edit
                      </button>
                    )
                  )}
                </div>
                <div className="panel-body">
                  {editing && hasAudio && (
                    <div className="note warn tiny" style={{ marginBottom: '1rem' }}>
                      This run has already been voiced. Saving a change to the words discards that
                      audio, because it would be about different words; it then needs voicing again.
                    </div>
                  )}

                  {editing && editMode === 'whole' ? (
                    <div className="stack tight">
                      <p className="faint tiny" style={{ margin: 0 }}>
                        Paste or write the whole script here. Each part starts with a line{' '}
                        <code>## part</code> ({script.beats.map((b) => b.beatId).join(', ')}), and a blank
                        line separates paragraphs. Pasted without any <code>##</code> lines, the
                        paragraphs are shared out over the parts in order. Save and re-check before
                        voicing.
                      </p>
                      <textarea
                        className="beat-edit whole-edit"
                        value={wholeText}
                        spellCheck
                        onChange={(e) => {
                          setWholeText(e.target.value);
                          setWholeError(null);
                        }}
                      />
                      {wholeError && <div className="note fail tiny">{wholeError}</div>}
                    </div>
                  ) : (
                  <div className="stack">
                    {(editing ? draft : withoutOutro(script.beats)).map((beat, i) => (
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
                                const speaker =
                                  beat.turns[0]?.speaker ?? script.beats[i]?.turns[0]?.speaker ?? 'narrator';
                                // The outro is not here: the Outro panel below owns it.
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
                  )}
                </div>
              </section>
            )}

            {/* --- The outro: optional, one of the channel's three --------- */}
            {script && !isSource && data.outro.options.length > 0 && (
              <section className="panel outro" id="outro">
                <div className="panel-head">
                  <label className="row" style={{ gap: '0.5rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={data.outro.current !== null}
                      disabled={outroLocked}
                      onChange={(e) =>
                        void changeOutro(e.target.checked, data.outro.index ?? 0)
                      }
                    />
                    <h3>Outro</h3>
                  </label>
                  <span className="faint tiny">
                    {data.outro.current !== null ? 'attached to the end of the script' : 'none: the script is voiced alone'}
                  </span>
                  <span className="spacer" />
                  <Info label="How the outro works">
                    Optional. Ticked, the chosen outro is attached to the end of the saved script and
                    voiced with it, word for word. Unticked, only the script is voiced. It works the
                    same whether you edit by part or as the whole script, and the editors leave it
                    alone. Changing it changes the script: it is re-checked at once and, if the run
                    was voiced, only the last part needs voicing again.
                  </Info>
                </div>
                <div className={`panel-body stack tight${data.outro.current === null ? ' greyed' : ''}`}>
                  {/* A DROPDOWN THAT SHOWS EVERY OUTRO IN FULL (owner, 2026-10-09).
                      A native select cannot wrap, so long outros were cut off. */}
                  <div className={`outro-pick${outroOpen ? ' open' : ''}`}>
                    <button
                      type="button"
                      className="outro-current"
                      disabled={outroLocked || data.outro.current === null}
                      aria-expanded={outroOpen}
                      onClick={() => setOutroOpen((v) => !v)}
                    >
                      <span className="outro-words">
                        {data.outro.current ?? data.outro.options[data.outro.index ?? 0]}
                      </span>
                      <span className="caret">›</span>
                    </button>
                    {outroOpen && (
                      <div className="outro-options" role="listbox">
                        {data.outro.options.map((o, i) => (
                          <button
                            key={i}
                            type="button"
                            role="option"
                            aria-selected={data.outro.index === i}
                            className={`outro-option${data.outro.index === i ? ' on' : ''}`}
                            onClick={() => {
                              setOutroOpen(false);
                              if (data.outro.index !== i) void changeOutro(true, i);
                            }}
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {outroLockReason && <span className="faint tiny">{outroLockReason}</span>}
                </div>
              </section>
            )}

            {/* --- The gate -------------------------------------------------- */}
            {gate && (
              <section className="panel" id="gate">
                <div className="panel-head">
                  <h3>{gateIsFinal ? 'The gate' : 'Pre-voice check'}</h3>
                  {gate.passed ? (
                    <span className="pill pass">{ignored.length ? 'passed (overridden)' : 'passed'}</span>
                  ) : (
                    <span className="pill fail">{blocking.length} blocking</span>
                  )}
                  <span className="spacer" />
                  {advisory.length > 0 && (
                    <span className="faint mono" style={{ fontSize: '0.72rem' }}>
                      {advisory.length} advisory
                    </span>
                  )}
                </div>
                <div className="panel-body">
                  {!gateIsFinal && (
                    <p className="faint tiny" style={{ margin: '0 0 0.6rem' }}>
                      Checked against the words before any audio. The gate runs again for real over
                      the voice once it is made.
                    </p>
                  )}
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
                      hand. Once nothing is blocking, it passes and goes to To decide. An edit that
                      changes a finding makes it block again.
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

            {/* --- Evidence ---------------------------------------------------- */}
            {corpus && corpus.sources.length > 0 && (
              <section className="panel">
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

          {/* ================= RIGHT: the record ================= */}
          <aside className="run-side">
            <section className="panel side-card">
              <div className="panel-head">
                <h3>Cost</h3>
                <span className="spacer" />
                <Info label="How the budget works">
                  Two numbers. The target ({money(run.targetPence)}) is what a{' '}
                  {isShort ? 'short' : 'n episode'} is meant to cost: passing it is noted and the work
                  carries on. The hard ceiling ({money(run.ceilingPence)}) is where it stops, keeping
                  everything paid for so far (a voicing already under way still finishes). Every
                  re-voice after an edit or an engine switch, and every regeneration, adds{' '}
                  {isShort ? '15p' : 'room'} to both.
                </Info>
              </div>
              <div className="panel-body stack tight">
                <BudgetMeter spent={run.spentPence} target={run.targetPence} ceiling={run.ceilingPence} />
                <CostBar events={events} total={run.spentPence} />
              </div>
            </section>

            {!isSource && (
              <section className="panel side-card">
                <div className="panel-head">
                  <h3>What listeners see</h3>
                </div>
                <div className="panel-body stack tight">
                  {script && <TitleEditor runId={id} script={script} locked={published} onSaved={() => void load()} />}
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

            {/* Every episode belongs to a series; changeable until it is published. */}
            {long && !isSource && (
              <section className="panel side-card">
                <div className="panel-head">
                  <h3>Series</h3>
                </div>
                <div className="panel-body">
                  <SeriesPicker
                    runId={id}
                    channelId={run.channelId}
                    current={manifest.seriesTitle}
                    locked={published}
                    onSaved={() => void load()}
                  >
                    {/* THE SERIES COVER, 1920x1080: one picture for the whole series. */}
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
              </section>
            )}

            <section className="panel side-card">
              <div className="panel-head">
                <h3>In numbers</h3>
              </div>
              <div className="panel-body">
                <div className="side-counts">
                  <Count n={clock(run.durationS)} label="length" />
                  <Count n={script?.beats.length ?? 0} label={isSource ? 'stories' : 'beats'} />
                  <Count n={gate?.measurement?.words ?? 0} label="words" />
                  <Count n={claims?.claims.length ?? 0} label="facts" />
                  <Count n={corpus?.sources.length ?? 0} label="sources" />
                  <Count n={run.label} label="label" />
                </div>
              </div>
            </section>
          </aside>
        </div>
      </fieldset>
    </div>
  );
};
