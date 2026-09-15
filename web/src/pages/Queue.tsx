/**
 * The publish queue: is the studio all right, and does it need me.
 *
 * ORDERED BY WHO HAS TO ACT, NOT BY WHAT HAPPENS FIRST. Held runs are at the
 * top because a run waiting for approval is the studio asking a person a
 * question, and a question nobody sees is the failure this whole interface
 * exists to prevent. Then what the gate rejected, then what is due, then the
 * week ahead, then what went out. The first sections are work; everything below
 * them is reassurance.
 *
 * A QUIET SECTION IS STILL SHOWN. An empty "held" reads as "nothing is waiting
 * on me", which is information. Sections that vanish when empty make the page a
 * different shape every time, and then you cannot tell at a glance whether
 * anything is wrong.
 *
 * NOTHING HERE SPENDS. Every row is a link to where the decision is actually
 * made. A page that both reported the state of the studio and started runs
 * would be one misclick away from being expensive.
 */
import { useEffect, useState } from 'react';
import { ago, api, clock, money, until, when, type QueueView, type RunSummary } from '../api';
import { ErrorNote, StatePill } from '../components/bits';

/** How often the page re-reads itself. The only thing that moves is the clock. */
const REFRESH_MS = 60_000;

const Section = ({
  title,
  note,
  count,
  tone,
  shown,
  children,
}: {
  title: string;
  note: string;
  count: number;
  tone?: 'hold' | 'fail';
  /** How many are actually listed, when the count is larger than the list. */
  shown?: number;
  children: React.ReactNode;
}) => (
  <section className="panel">
    <div className="panel-head">
      <h2 style={{ fontSize: '1.05rem' }}>{title}</h2>
      <span className={`pill${count > 0 && tone ? ` ${tone}` : ''}`}>{count}</span>
      {shown !== undefined && shown < count && (
        <span className="faint" style={{ fontSize: '0.78rem' }}>
          newest {shown}
        </span>
      )}
      <span className="spacer" />
      <span className="muted nowrap" style={{ fontSize: '0.8rem' }}>
        {note}
      </span>
    </div>

    {count > 0 ? (
      <div className="queue-list">{children}</div>
    ) : (
      <div className="panel-body faint">Nothing.</div>
    )}
  </section>
);

const Row = ({
  title,
  detail,
  onClick,
  children,
}: {
  title: React.ReactNode;
  detail: string;
  onClick: () => void;
  children?: React.ReactNode;
}) => (
  <button className="queue-row" onClick={onClick}>
    <span className="queue-main">
      <span className="queue-title">{title}</span>
      <span className="muted">{detail}</span>
    </span>
    <span className="row nowrap">{children}</span>
  </button>
);

const RunRow = ({ run, go }: { run: RunSummary; go: (path: string) => void }) => (
  <Row
    title={run.title ?? run.topic}
    detail={`${run.channelName}${run.short !== null ? ` - short ${run.short}` : ''} - ${ago(run.createdAt)}`}
    onClick={() => go(`/r/${run.id}`)}
  >
    {run.gate?.needsHumanReview && <span className="pill hold">needs a read</span>}
    {run.gate && run.gate.blocking > 0 && (
      <span className="pill fail">{run.gate.blocking} blocking</span>
    )}
    <span className="muted mono" style={{ fontSize: '0.78rem' }}>
      {clock(run.durationS)}
    </span>
    <span className="muted mono" style={{ fontSize: '0.78rem' }}>
      {money(run.spentPence)}
    </span>
    <StatePill state={run.state} />
  </Row>
);

export const Queue = ({ go }: { go: (path: string) => void }) => {
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .queue()
        .then((q) => {
          setQueue(q);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));

    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  if (!queue) {
    return (
      <div className="page">
        <ErrorNote>{error}</ErrorNote>
        {!error && <p className="faint">...</p>}
      </div>
    );
  }

  // WHAT ACTUALLY NEEDS A PERSON. Held runs and blocked shows, and not the
  // gate-failure tail: those accumulate, most of them were superseded by a
  // later episode, and counting them here would make the page permanently say
  // twenty-odd things need you until nobody read the number at all.
  const needsMe = queue.held.length + queue.blocked.length;

  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">Publishing</div>
        <h1>The queue</h1>
        <p className="lede">
          {queue.paused ? (
            <>
              The schedule is <strong>paused</strong>, so nothing comes up as due. Held runs below
              are still waiting to be read.
            </>
          ) : needsMe === 0 ? (
            <>
              Nothing is waiting on you.{' '}
              {queue.waiting.length > 0
                ? `${queue.waiting.length} on the way.`
                : 'Nothing scheduled either.'}
            </>
          ) : (
            <>
              {needsMe} {needsMe === 1 ? 'thing needs' : 'things need'} you. Everything else is on
              its own clock.
            </>
          )}
        </p>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="stack">
        <Section
          title="Held"
          note="Written and gated, waiting to be read"
          count={queue.held.length}
          tone="hold"
        >
          {queue.held.map((r) => (
            <RunRow key={r.id} run={r} go={go} />
          ))}
        </Section>

        <Section
          title="Gate rejected"
          note="Blocking findings; the run page says which"
          count={queue.failedTotal}
          shown={queue.failed.length}
          tone="fail"
        >
          {queue.failed.map((r) => (
            <RunRow key={r.id} run={r} go={go} />
          ))}
        </Section>

        <Section
          title="Waiting on you"
          note="Due, but something has to be done first"
          count={queue.blocked.length}
          tone="hold"
        >
          {queue.blocked.map((b) => (
            <Row
              key={b.channelId}
              title={b.channelName}
              detail={b.reason}
              onClick={() => go(`/c/${b.channelId}`)}
            >
              <span className="pill hold">blocked</span>
            </Row>
          ))}
        </Section>

        <Section
          title="Due now"
          note="The schedule says make these; nothing starts by itself"
          count={queue.due.length}
        >
          {queue.due.map((d) => (
            <Row
              key={`${d.channelId}-${d.kind}`}
              title={
                <>
                  {d.channelName} <span className="muted">{d.kind}</span>
                </>
              }
              detail={d.reason}
              onClick={() => go(`/c/${d.channelId}`)}
            >
              {d.overdueDays ? (
                <span className="pill fail">{d.overdueDays}d late</span>
              ) : (
                <span className="pill">due</span>
              )}
            </Row>
          ))}
        </Section>

        <Section
          title="Coming up"
          note={`Ready, not yet its turn - ${queue.timezone}`}
          count={queue.waiting.length}
        >
          {queue.waiting.map((w) => (
            <Row
              key={`${w.channelId}-${w.kind}-${w.at}`}
              title={
                <>
                  {w.channelName} <span className="muted">{w.kind}</span>
                </>
              }
              detail={w.reason}
              onClick={() => go(`/c/${w.channelId}`)}
            >
              <span className="muted mono" style={{ fontSize: '0.78rem' }}>
                {when(w.at!, queue.timezone)}
              </span>
              <span className="pill">{until(w.at!)}</span>
            </Row>
          ))}
        </Section>

        <Section title="Ready" note="Gate passed clean, not published" count={queue.ready.length}>
          {queue.ready.map((r) => (
            <RunRow key={r.id} run={r} go={go} />
          ))}
        </Section>

        <Section
          title="Published"
          note="Out in the world, most recent first"
          count={queue.publishedTotal}
          shown={queue.published.length}
        >
          {queue.published.map((r) => (
            <RunRow key={r.id} run={r} go={go} />
          ))}
        </Section>

        {/*
          THE WEEK, AS ONE LINE PER SHOW. Not a calendar: the only question
          anybody asks of it is "do two shows go out on the same day", and a
          list answers that faster than a grid with five things in it.
        */}
        <section className="panel">
          <div className="panel-head">
            <h2 style={{ fontSize: '1.05rem' }}>The week</h2>
            <span className="spacer" />
            <span className="muted nowrap" style={{ fontSize: '0.8rem' }}>
              When each show goes out, {queue.timezone}
            </span>
          </div>
          <div className="queue-list">
            {queue.slots.map((s) => (
              <Row
                key={s.channelId}
                title={s.channelName}
                detail={s.slot ? '' : 'publishes as soon as its cadence says so'}
                onClick={() => go(`/c/${s.channelId}`)}
              >
                {s.slot ? (
                  <span className="pill">{s.slot}</span>
                ) : (
                  <span className="muted">no slot</span>
                )}
              </Row>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
