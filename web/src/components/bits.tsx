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
export const NowBanner = ({ events, startedAt }: { events: JobEvent[]; startedAt?: string }) => {
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
        {spent > 0 && <> · spent so far {money(spent)}</>}
      </div>
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
