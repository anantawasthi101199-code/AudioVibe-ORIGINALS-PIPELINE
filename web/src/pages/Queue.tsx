/**
 * Is the studio all right, and does it need me.
 *
 * ONE SCREEN, AND THE TOP ROW ANSWERS IT. Seven numbers. If "held" and "stuck"
 * are both nought, nothing needs you and you can close the tab; that judgement
 * should take under a second and should not require reading a sentence.
 *
 * THE SECTIONS ARE SHUT UNLESS THEY MATTER. Held and stuck open by themselves
 * when they have anything in them, because those are work. The rest open when
 * you tap their number. A page showing all seven lists at once is a page where
 * the two that need you are somewhere in the middle of it.
 *
 * THE REASONS ARE BEHIND THE MARKS. Every rule in this studio has one and none
 * of them are guessable, but they are not what somebody wants ninety-nine times
 * out of a hundred.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ago,
  api,
  clock,
  money,
  until,
  when,
  type Platform,
  type QueueView,
  type RunSummary,
} from '../api';
import { ErrorNote, StatePill } from '../components/bits';
import { Count, Info } from '../components/Info';

const REFRESH_MS = 20_000;

type Panel = 'held' | 'stuck' | 'due' | 'soon' | 'ready' | 'lined' | 'out';

const Row = ({
  title,
  detail,
  right,
  onClick,
}: {
  title: React.ReactNode;
  detail: string;
  right: React.ReactNode;
  onClick: () => void;
}) => (
  <button className="queue-row" onClick={onClick}>
    <span className="queue-main">
      <span className="queue-title">{title}</span>
      <span className="muted">{detail}</span>
    </span>
    <span className="row nowrap">{right}</span>
  </button>
);

const RunRow = ({ run, go }: { run: RunSummary; go: (path: string) => void }) => (
  <Row
    title={run.title ?? run.topic}
    detail={`${run.channelName}${run.short !== null ? ` · short ${run.short}` : ''} · ${ago(run.createdAt)}`}
    onClick={() => go(`/r/${run.id}`)}
    right={
      <>
        {run.gate && run.gate.blocking > 0 && <span className="pill fail">{run.gate.blocking}</span>}
        <span className="muted mono tiny">{clock(run.durationS)}</span>
        <span className="muted mono tiny">{money(run.spentPence)}</span>
        <StatePill state={run.state} />
      </>
    }
  />
);

const Panel = ({
  id,
  title,
  count,
  tone,
  open,
  toggle,
  why,
  children,
}: {
  id: Panel;
  title: string;
  count: number;
  tone?: 'hold' | 'fail' | 'pass';
  open: Set<Panel>;
  toggle: (p: Panel) => void;
  why: React.ReactNode;
  children: React.ReactNode;
}) => {
  const isOpen = open.has(id);

  return (
    <section className="panel">
      <div className="panel-head">
        <button className="panel-tap" onClick={() => toggle(id)}>
          <span className={`caret${isOpen ? ' open' : ''}`}>›</span>
          <h2>{title}</h2>
          <span className={`pill${count && tone ? ` ${tone}` : ''}`}>{count}</span>
        </button>
        <span className="spacer" />
        <span className="right-edge">
          <Info label={`Why ${title.toLowerCase()} works this way`}>{why}</Info>
        </span>
      </div>
      {isOpen && (count > 0 ? <div className="queue-list">{children}</div> : <p className="panel-body faint">Nothing.</p>)}
    </section>
  );
};

export const Queue = ({ go }: { go: (path: string) => void }) => {
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<Panel>>(new Set());

  const toggle = useCallback((p: Panel) => {
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  useEffect(() => {
    const load = () =>
      api
        .queue()
        .then((q) => {
          setQueue(q);
          setError(null);
          // WORK OPENS ITSELF. You should never have to tap to discover that
          // something is waiting on you.
          setOpen((was) => {
            if (!q.held.length && !q.failedTotal) return was;
            const next = new Set(was);
            if (q.held.length) next.add('held');
            if (q.failedTotal) next.add('stuck');
            return next;
          });
        })
        .catch((e: Error) => setError(e.message));

    void load();
    void api
      .platform()
      .then(setPlatform)
      .catch(() => undefined);

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

  const needsMe = queue.held.length + queue.blocked.length;

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.5rem' }}>
          {queue.paused ? 'Paused' : needsMe === 0 ? 'All clear' : 'Needs you'}
        </h1>

        {platform?.configured && (
          <span className={`where${platform.isProduction ? ' live' : ''}`}>
            <span className="dot" />
            {platform.isProduction ? 'production' : new URL(platform.url!).hostname}
          </span>
        )}
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="counts" style={{ marginBottom: '1.7rem' }}>
        <Count n={queue.held.length} label="held" tone="hold" onClick={() => toggle('held')} />
        <Count n={queue.failedTotal} label="stuck" tone="fail" onClick={() => toggle('stuck')} />
        <Count
          n={queue.due.length + queue.blocked.length}
          label="due"
          tone={queue.blocked.length ? 'hold' : undefined}
          onClick={() => toggle('due')}
        />
        <Count n={queue.waiting.length} label="soon" onClick={() => toggle('soon')} />
        <Count n={queue.ready.length} label="ready" tone="pass" onClick={() => toggle('ready')} />
        <Count n={queue.scheduled.length} label="lined up" onClick={() => toggle('lined')} />
        <Count n={queue.publishedTotal} label="out" onClick={() => toggle('out')} />
      </div>

      <div className="stack tight">
        <Panel
          id="held"
          title="Held"
          count={queue.held.length}
          tone="hold"
          open={open}
          toggle={toggle}
          why="Written and gated, waiting for somebody to read it. Nothing here publishes on its own and nothing ever will: the two things the gate hands to a person are whether the script acknowledges its counter-evidence and whether the weakest source is framed as one account. Neither is settled by arithmetic."
        >
          {queue.held.map((r) => (
            <RunRow key={r.id} run={r} go={go} />
          ))}
        </Panel>

        <Panel
          id="stuck"
          title="Stuck"
          count={queue.failedTotal}
          tone="fail"
          open={open}
          toggle={toggle}
          why="The gate found something blocking. Most were superseded by a later episode and are only here because nothing deletes them, so the newest dozen are listed and the count is the true one. Open one to see which check failed."
        >
          {queue.failed.map((r) => (
            <RunRow key={r.id} run={r} go={go} />
          ))}
        </Panel>

        <Panel
          id="due"
          title="Due"
          count={queue.due.length + queue.blocked.length}
          open={open}
          toggle={toggle}
          why="What the schedule says should be made now. Nothing starts by itself. A blocked show is due but waiting on you, almost always for topics: a factual show with nothing to cover is reported rather than skipped, so it cannot quietly stop publishing and still look healthy."
        >
          {queue.blocked.map((b) => (
            <Row
              key={b.channelId}
              title={b.channelName}
              detail={b.reason}
              onClick={() => go(`/c/${b.channelId}`)}
              right={<span className="pill hold">blocked</span>}
            />
          ))}
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
              right={
                d.overdueDays ? (
                  <span className="pill fail">{d.overdueDays}d late</span>
                ) : (
                  <span className="pill">due</span>
                )
              }
            />
          ))}
        </Panel>

        <Panel
          id="soon"
          title="Soon"
          count={queue.waiting.length}
          open={open}
          toggle={toggle}
          why={`Ready, but not yet its turn. Each show has a day and an hour so a week's work arrives spread across the week rather than in one lump. A slot that passes while nothing is running leaves the show overdue now, never pushed to next week. Times are ${queue.timezone}.`}
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
              right={
                <>
                  <span className="muted mono tiny">{when(w.at!, queue.timezone)}</span>
                  <span className="pill">{until(w.at!)}</span>
                </>
              }
            />
          ))}
        </Panel>

        <Panel
          id="ready"
          title="Ready"
          count={queue.ready.length}
          tone="pass"
          open={open}
          toggle={toggle}
          why="Gate passed clean and nothing is waiting on a person. Open one to hear it and publish it."
        >
          {queue.ready.map((r) => (
            <RunRow key={r.id} run={r} go={go} />
          ))}
        </Panel>

        <Panel
          id="lined"
          title="Lined up"
          count={queue.scheduled.length}
          open={open}
          toggle={toggle}
          why={`Finished, with a release time that has not come. Ten shorts cut in one afternoon are all publishable at once, and publishing them together is what makes a feed look like somebody emptied a bucket into it. They go out one a day at a different hour each day. Nothing stops you publishing one now. Times are ${queue.timezone}.`}
        >
          {queue.scheduled.map((r) => (
            <Row
              key={r.id}
              title={r.title ?? r.topic}
              detail={`${r.channelName}${r.short !== null ? ` · short ${r.short}` : ''}`}
              onClick={() => go(`/r/${r.id}`)}
              right={
                <>
                  <span className="muted mono tiny">{when(r.releaseAt, queue.timezone)}</span>
                  <span className="pill">{until(r.releaseAt)}</span>
                </>
              }
            />
          ))}
        </Panel>

        <Panel
          id="out"
          title="Out"
          count={queue.publishedTotal}
          open={open}
          toggle={toggle}
          why="Published. The most recent dozen are listed."
        >
          {queue.published.map((r) => (
            <RunRow key={r.id} run={r} go={go} />
          ))}
        </Panel>
      </div>

      {/* The week, one line per show. Not a calendar: the only question asked
          of it is whether two shows go out on the same day. */}
      <div className="week">
        {queue.slots.map((s) => (
          <button key={s.channelId} className="week-row" onClick={() => go(`/c/${s.channelId}`)}>
            <span className="mono tiny">{s.slot ?? '—'}</span>
            <span className="muted">{s.channelName}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
