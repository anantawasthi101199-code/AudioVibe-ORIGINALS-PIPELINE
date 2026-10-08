/**
 * The small pieces every page uses.
 *
 * A VERDICT IS NEVER A COLOUR ALONE. Every pill here carries a word, and the
 * colour agrees with the word rather than replacing it. Roughly one reader in
 * twelve cannot tell the green from the red, and a studio where "passed" and
 * "failed" look identical to them is a studio that publishes the wrong episode.
 */
import { useEffect, useState } from 'react';
import type { JobEvent, RunState } from '../api';
import { money } from '../api';

/* --- State ---------------------------------------------------------------- */

const STATE: Record<RunState, { label: string; tone: string }> = {
  running: { label: 'running', tone: 'live' },
  'awaiting-approval': { label: 'held', tone: 'hold' },
  'needs-voice': { label: 'needs voice', tone: 'warn' },
  ready: { label: 'passed', tone: 'pass' },
  failed: { label: 'blocked', tone: 'fail' },
  published: { label: 'published', tone: 'pass' },
  abandoned: { label: 'abandoned', tone: '' },
};

export const StatePill = ({ state, stage }: { state: RunState; stage?: string | null }) => {
  const s = STATE[state];
  // A working run says which step it is on, not just that it is running.
  const phase = state === 'running' ? phaseOf(stage) : null;
  const label = phase ? PHASES.find((p) => p.id === phase)!.doing.toLowerCase() : s.label;
  return (
    <span className={`pill ${s.tone}`}>
      <span className="dot" />
      {label}
    </span>
  );
};

export const Pill = ({ children, tone = '' }: { children: React.ReactNode; tone?: string }) => (
  <span className={`pill ${tone}`}>{children}</span>
);

/* --- Where a run is -------------------------------------------------------- */

/**
 * Six steps every run passes through, whatever its lane.
 *
 * THE PIPELINES REPORT TWENTY-ODD STAGE NAMES (brief, wire, source, reference,
 * casefile, claims, perform, grounding...), and the rail used to know eight of
 * them, so most channels showed nothing but "running". Every name maps to one
 * of these; the log underneath still shows the pipeline's own word.
 */
export const PHASES = [
  { id: 'plan', label: 'Plan', doing: 'Planning what to look for' },
  { id: 'research', label: 'Research', doing: 'Researching sources' },
  { id: 'write', label: 'Write', doing: 'Writing the script' },
  { id: 'voice', label: 'Voice', doing: 'Voicing the audio' },
  { id: 'check', label: 'Check', doing: 'Checking it' },
  { id: 'publish', label: 'Publish', doing: 'Publishing' },
] as const;

export type PhaseId = (typeof PHASES)[number]['id'];

const PHASE_OF: Record<string, PhaseId> = {
  brief: 'plan', wire: 'plan', pipeline: 'plan', next: 'plan',
  corpus: 'research', source: 'research', article: 'research', reference: 'research',
  casefile: 'research', claims: 'research', verification: 'research', repair: 'research',
  gaps: 'research', counterEvidence: 'research', continuity: 'research', research: 'research',
  extract: 'research', fuse: 'research', story: 'research', belief: 'research',
  script: 'write', perform: 'write', grounding: 'write', title: 'write', taboo: 'write',
  stylistic_rule: 'write', series: 'write',
  render: 'voice', voice: 'voice', artwork: 'voice',
  qa: 'check', gate: 'check',
  publish: 'publish', account: 'publish',
};

/** Which step a pipeline stage belongs to. Unknown names count as research. */
export const phaseOf = (stage: string | null | undefined): PhaseId | null =>
  stage ? (PHASE_OF[stage] ?? 'research') : null;

const phaseIndex = (id: PhaseId) => PHASES.findIndex((p) => p.id === id);

export const StageRail = ({
  completed,
  live,
  skip = [],
}: {
  completed: string[];
  live?: string | null;
  skip?: string[];
}) => {
  const livePhase = phaseOf(live);
  const shown = PHASES.filter((p) => !(skip.includes('render') && p.id === 'voice') && !(skip.includes('qa') && p.id === 'check'));
  const doneUpTo = Math.max(-1, ...completed.map((c) => phaseIndex(phaseOf(c)!)));
  return (
    <div className="rail">
      {shown.map((p) => {
        const idx = phaseIndex(p.id);
        const isLive = livePhase === p.id;
        // Everything before the live step is done; otherwise what has completed.
        const done = livePhase ? idx < phaseIndex(livePhase) : idx <= doneUpTo;
        return (
          <div
            key={p.id}
            className={`rail-stage ${isLive ? 'live' : done ? 'done' : 'pending'}`}
            title={`${p.label}: ${isLive ? 'working now' : done ? 'done' : 'not yet'}`}
          >
            <div className="rail-name">
              {done && !isLive ? '✓ ' : ''}
              {p.label}
            </div>
            <div className="rail-note">{isLive ? 'working now' : done ? 'done' : ''}</div>
          </div>
        );
      })}
    </div>
  );
};

const since = (from: string, now: number): string => {
  const s = Math.max(0, Math.round((now - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/**
 * What a working run is doing right now, in words: the step, the last thing it
 * reported, and how long each has taken. Ticks every second.
 */
export const NowBanner = ({
  events,
  startedAt,
  startedBy,
}: {
  events: JobEvent[];
  startedAt?: string;
  startedBy?: string | null;
}) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const last = events[events.length - 1];
  const phase = phaseOf(last?.stage) ?? 'plan';
  const step = PHASES.find((p) => p.id === phase)!;
  // When this step began: the first event of the unbroken run of this phase.
  let stepStart = last?.at;
  for (let i = events.length - 1; i >= 0 && phaseOf(events[i]!.stage) === phase; i--) {
    stepStart = events[i]!.at;
  }
  const spent = events.reduce((n, e) => Math.max(n, e.spentPence), 0);

  return (
    <div className="now">
      <div className="now-step">
        <span className="pill live">
          <span className="dot" /> Step {phaseIndex(phase) + 1} of {PHASES.length}
        </span>
        <strong>{step.doing}</strong>
        {stepStart && <span className="faint">for {since(stepStart, now)}</span>}
      </div>
      <div className="now-line muted">{last ? last.message : 'Starting...'}</div>
      <div className="now-meta faint tiny">
        {startedAt && <>Running {since(startedAt, now)}</>}
        {startedBy && <> · started by {startedBy}</>}
        {spent > 0 && <> · spent so far {money(spent)}</>}
      </div>
    </div>
  );
};

/* --- Progress ------------------------------------------------------------- */

/**
 * How far the voice is, read off the renderer's own lines ("3/8: hook ...").
 *
 * FROM THE LOG, NOT A SECOND CHANNEL. The renderer already says which beat it
 * is on; a progress bar that counted something else would be a second account
 * of the same work, and the two would disagree the first time a beat was
 * reused from an earlier attempt.
 */
export const voiceProgress = (
  events: JobEvent[]
): { done: number; total: number; startedAt: string | null } | null => {
  let done = 0;
  let total = 0;
  let startedAt: string | null = null;
  for (const e of events) {
    if (phaseOf(e.stage) !== 'voice') continue;
    const m = /(?:^|\s)(\d+)\/(\d+):\s/.exec(e.message);
    if (!m) continue;
    startedAt ??= e.at;
    // The line is written as a beat STARTS, so beat n means n-1 are finished.
    done = Math.max(done, Number(m[1]) - 1);
    total = Number(m[2]);
  }
  return total > 0 ? { done, total, startedAt } : null;
};

const MAKE_STEPS = PHASES.filter((p) => p.id !== 'publish');

/** Overall and voice progress for a working run, as two bars. */
export const ProgressBars = ({ events, engine }: { events: JobEvent[]; engine?: string }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const last = events[events.length - 1];
  const phase = phaseOf(last?.stage) ?? 'plan';
  const failed = last?.stage === 'failed';
  const voice = voiceProgress(events);
  const voicing = phase === 'voice' || (voice !== null && phase === 'check');

  const stepIdx = Math.max(0, MAKE_STEPS.findIndex((p) => p.id === phase));
  const within = phase === 'voice' && voice ? voice.done / voice.total : 0.35;
  const overall = Math.min(0.99, (stepIdx + within) / MAKE_STEPS.length);

  let eta: string | null = null;
  if (voice && voice.startedAt && voice.done > 0 && voice.done < voice.total) {
    const perBeat = (now - Date.parse(voice.startedAt)) / voice.done;
    const left = Math.round((perBeat * (voice.total - voice.done)) / 1000);
    eta = left < 60 ? `about ${left}s left` : `about ${Math.round(left / 60)} min left`;
  }

  return (
    <div className="progress-pair">
      <div className="progress">
        <div className="progress-label">
          <span>Overall</span>
          <span className="mono">{failed ? 'stopped' : `${Math.round(overall * 100)}%`}</span>
        </div>
        <div className={`progress-track${failed ? ' failed' : ''}`}>
          <span style={{ width: `${overall * 100}%` }} />
        </div>
      </div>
      {voice && (
        <div className="progress">
          <div className="progress-label">
            <span>
              Voice{engine ? ` on ${engine === 'elevenlabs' ? 'ElevenLabs' : 'GPT'}` : ''}: beat{' '}
              {Math.min(voice.total, voice.done + (voicing && voice.done < voice.total ? 1 : 0))} of{' '}
              {voice.total}
            </span>
            <span className="mono">
              {eta ?? (voice.done >= voice.total || phase === 'check' ? 'joining and checking' : '')}
            </span>
          </div>
          <div className={`progress-track voice${failed ? ' failed' : ''}`}>
            <span style={{ width: `${(phase === 'check' ? 1 : voice.done / voice.total) * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * What a run has spent against what it was meant to cost and where it stops.
 *
 * THREE NUMBERS, ONE BAR. The bar's full width is the hard ceiling; the tick is
 * the target. Under the tick is on budget; past it is over target and still
 * going, which is allowed; the end of the bar is where the run stops.
 */
export const BudgetMeter = ({
  spent,
  target,
  ceiling,
  compact = false,
}: {
  spent: number;
  target: number;
  ceiling: number;
  compact?: boolean;
}) => {
  const pct = (n: number) => `${Math.min(100, Math.max(0, (n / ceiling) * 100))}%`;
  const tone = spent > ceiling ? 'fail' : spent > target ? 'warn' : 'pass';
  const say =
    spent > ceiling
      ? 'stopped at the hard ceiling'
      : spent > target
        ? 'over target, still allowed'
        : 'within target';
  return (
    <div className={`budget ${tone}${compact ? ' compact' : ''}`}>
      <div className="budget-head">
        <strong className="mono">{money(spent)}</strong>
        <span className="faint tiny">
          target {money(target)} · hard stop {money(ceiling)}
        </span>
      </div>
      <div className="budget-track" title={`${money(spent)} of a ${money(ceiling)} ceiling; target ${money(target)}`}>
        <span className="budget-fill" style={{ width: pct(spent) }} />
        <span className="budget-target" style={{ left: pct(target) }} />
      </div>
      {!compact && <div className={`budget-say ${tone}`}>{say}</div>}
    </div>
  );
};

/* --- Live log ------------------------------------------------------------- */

export const LiveLog = ({ events }: { events: JobEvent[] }) => {
  if (!events.length) {
    return <div className="empty">Nothing reported yet.</div>;
  }

  return (
    <div
      className="log"
      ref={(el) => {
        // Follow the tail. A log that has to be scrolled to be current is a log
        // nobody watches.
        if (el) el.scrollTop = el.scrollHeight;
      }}
    >
      {events.map((e, i) => (
        <div className="log-line" key={`${e.at}-${i}`}>
          <span className="stage">{e.stage}</span>
          <span>{e.message}</span>
          <span className="spend">{e.spentPence > 0 ? money(e.spentPence) : ''}</span>
        </div>
      ))}
    </div>
  );
};

/* --- Numbers -------------------------------------------------------------- */

export const Stat = ({
  value,
  label,
  money: isMoney = false,
}: {
  value: React.ReactNode;
  label: string;
  money?: boolean;
}) => (
  <div className={`stat ${isMoney ? 'money' : ''}`}>
    <div className="stat-value mono">{value}</div>
    <div className="stat-label">{label}</div>
  </div>
);

/**
 * What a run spent, by stage.
 *
 * DRAWN FROM THE JOB'S OWN EVENTS, each of which carries the running total at
 * the moment it was written. The differences between consecutive lines are what
 * each stage actually cost, which is a real measurement rather than an
 * allocation - and it is the only view anywhere that answers "where did the
 * money go" without reading the journal.
 */
const STAGE_COLOUR: Record<string, string> = {
  brief: '#6f9ef0',
  corpus: '#4f7fd0',
  claims: '#f0a831',
  verification: '#e8615f',
  repair: '#c07ad8',
  script: '#3fb98a',
  render: '#f0d431',
  qa: '#5d6b8c',
};

export const CostBar = ({ events, total }: { events: JobEvent[]; total: number }) => {
  const byStage = new Map<string, number>();
  let last = 0;

  for (const e of events) {
    const delta = Math.max(0, e.spentPence - last);
    if (delta > 0) byStage.set(e.stage, (byStage.get(e.stage) ?? 0) + delta);
    last = Math.max(last, e.spentPence);
  }

  const parts = [...byStage.entries()].filter(([, p]) => p > 0);
  if (!parts.length || total <= 0) return null;

  return (
    <div>
      <div className="costbar">
        {parts.map(([stage, p]) => (
          <span
            key={stage}
            style={{ width: `${(p / total) * 100}%`, background: STAGE_COLOUR[stage] ?? '#2a3554' }}
            title={`${stage}: ${money(p)}`}
          />
        ))}
      </div>
      <div className="costkey">
        {parts
          .sort((a, b) => b[1] - a[1])
          .map(([stage, p]) => (
            <span key={stage}>
              <i style={{ background: STAGE_COLOUR[stage] ?? '#2a3554' }} />
              {stage} {money(p)}
            </span>
          ))}
      </div>
    </div>
  );
};

/* --- Errors --------------------------------------------------------------- */

export const ErrorNote = ({ children }: { children: React.ReactNode }) =>
  children ? <div className="error">{children}</div> : null;
