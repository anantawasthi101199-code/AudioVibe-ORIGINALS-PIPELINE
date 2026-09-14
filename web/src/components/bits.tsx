/**
 * The small pieces every page uses.
 *
 * A VERDICT IS NEVER A COLOUR ALONE. Every pill here carries a word, and the
 * colour agrees with the word rather than replacing it. Roughly one reader in
 * twelve cannot tell the green from the red, and a studio where "passed" and
 * "failed" look identical to them is a studio that publishes the wrong episode.
 */
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

export const StatePill = ({ state }: { state: RunState }) => {
  const s = STATE[state];
  return (
    <span className={`pill ${s.tone}`}>
      <span className="dot" />
      {s.label}
    </span>
  );
};

export const Pill = ({ children, tone = '' }: { children: React.ReactNode; tone?: string }) => (
  <span className={`pill ${tone}`}>{children}</span>
);

/* --- The stage rail ------------------------------------------------------- */

/**
 * Where a run is, as the pipeline itself defines it.
 *
 * THE STAGES ARE THE PIPELINE'S, not a friendlier set invented for the screen.
 * When something goes wrong the next thing somebody does is read the journal or
 * the terminal, and a rail using different words would make them translate.
 */
export const STAGES = [
  'brief',
  'corpus',
  'claims',
  'verification',
  'repair',
  'script',
  'render',
  'qa',
] as const;

const STAGE_NOTE: Record<string, string> = {
  brief: 'what to look for',
  corpus: 'search and fetch',
  claims: 'bind to quotes',
  verification: 'check each one',
  repair: 'narrow or hedge',
  script: 'write it',
  render: 'voice it',
  qa: 'gate it',
};

export const StageRail = ({
  completed,
  live,
  skip = [],
}: {
  completed: string[];
  live?: string | null;
  skip?: string[];
}) => (
  <div className="rail">
    {STAGES.filter((s) => !skip.includes(s)).map((stage) => {
      const done = completed.includes(stage);
      const isLive = live === stage;
      return (
        <div
          key={stage}
          className={`rail-stage ${isLive ? 'live' : done ? 'done' : 'pending'}`}
          title={`${stage}: ${done ? 'done' : isLive ? 'working' : 'not yet'}`}
        >
          <div className="rail-name">{stage}</div>
          <div className="rail-note">{isLive ? 'working' : STAGE_NOTE[stage]}</div>
        </div>
      );
    })}
  </div>
);

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
