/**
 * Is the studio all right, does it need me, and what do I do next.
 *
 * THE THIRD QUESTION IS WHY THIS WAS REBUILT. The first version answered the
 * first two with seven collapsed bars and nothing else, five of them empty and
 * all seven identical. It was a status board with no way into anything: there
 * was nothing to select, because everything that could be done lived behind a
 * ghost button in the corner.
 *
 * SO: SECTIONS THAT HAVE SOMETHING IN THEM ARE OPEN AND FULL OF IT. A section
 * with nothing in it is not a panel at all - it is a word in one quiet line at
 * the bottom, because "nothing is held" is worth knowing and is not worth a box
 * the same size as the thing that needs you.
 *
 * AND THE NEXT STEP IS ON THE PAGE. Whatever the studio is waiting for, the
 * button for it is here: read the held one, publish the ready one, line up the
 * cut set, or go and make something.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ago,
  api,
  clock,
  money,
  until,
  when,
  type QueueView,
  type RunSummary,
} from '../api';
import { ErrorNote, StatePill } from '../components/bits';
import { Count, Info, PlayButton } from '../components/Info';

const REFRESH_MS = 20_000;

type Key = 'held' | 'stuck' | 'due' | 'soon' | 'dueNow' | 'ready' | 'lined' | 'out';

const Row = ({
  title,
  detail,
  right,
  onClick,
  play,
}: {
  title: React.ReactNode;
  detail: string;
  right: React.ReactNode;
  onClick: () => void;
  /** A run id, when there is something to listen to. */
  play?: string;
}) => (
  <button className="queue-row" onClick={onClick}>
    {play ? <PlayButton id={play} src={api.audioUrl(play)} /> : null}
    <span className="queue-main">
      <span className="queue-title">{title}</span>
      <span className="muted">{detail}</span>
    </span>
    <span className="row nowrap">{right}</span>
    <span className="go">›</span>
  </button>
);

const RunRow = ({ run, go }: { run: RunSummary; go: (path: string) => void }) => (
  <Row
    title={run.title ?? run.topic}
    detail={`${run.channelName}${run.short !== null ? ` · short ${run.short}` : ''} · ${ago(run.createdAt)}`}
    onClick={() => go(`/r/${run.id}`)}
    play={run.hasAudio ? run.id : undefined}
    right={
      <>
        {run.gate && run.gate.blocking > 0 && <span className="pill fail">{run.gate.blocking}</span>}
        <span className="muted mono tiny">{clock(run.durationS)}</span>
        <span className="muted mono tiny">{money(run.spentPence)}</span>
        <StatePill state={run.state} stage={run.liveStage} />
      </>
    }
  />
);

export const Queue = ({ go }: { go: (path: string) => void }) => {
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shut, setShut] = useState<Set<Key>>(new Set());

  const toggle = useCallback((k: Key) => {
    setShut((was) => {
      const next = new Set(was);
      if (next.has(k)) next.delete(k);
      else next.add(k);
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

  /**
   * What to say at the top, in the order somebody would care.
   *
   * "All clear" while twenty-one runs sit rejected was the old headline, and it
   * was wrong in a way that teaches you to ignore headlines.
   */
  const headline =
    queue.paused
      ? { text: 'Paused', tone: 'fail' as const }
      : queue.dueToPublish.length
        ? { text: `${queue.dueToPublish.length} due to publish`, tone: 'pass' as const }
      : queue.held.length
        ? { text: `${queue.held.length} to read`, tone: 'hold' as const }
        : queue.blocked.length
          ? { text: `${queue.blocked.length} waiting on you`, tone: 'hold' as const }
          : queue.ready.length
            ? { text: `${queue.ready.length} to decide`, tone: 'pass' as const }
            : queue.due.length
              ? { text: `${queue.due.length} due to make`, tone: undefined }
              : { text: 'Nothing to do', tone: undefined };

  // Sections, in the order somebody acts on them. Each carries its own rows.
  const sections: Array<{
    key: Key;
    title: string;
    tone?: 'hold' | 'fail' | 'pass';
    count: number;
    why: string;
    rows: React.ReactNode;
  }> = [
    {
      key: 'held',
      title: 'To read',
      tone: 'hold',
      count: queue.held.length,
      why: 'Written and gated, waiting for somebody to read it. Nothing here publishes on its own and nothing ever will: the two things the gate hands to a person are whether the script acknowledges its counter-evidence and whether the weakest source is framed as one account. Neither is settled by arithmetic.',
      rows: queue.held.map((r) => <RunRow key={r.id} run={r} go={go} />),
    },
    {
      key: 'due',
      title: 'Waiting on you',
      tone: 'hold',
      count: queue.blocked.length,
      why: 'Due, but something has to be done first, almost always an empty topic queue. A factual show with nothing to cover is reported rather than skipped, so it cannot quietly stop publishing and still look healthy.',
      rows: queue.blocked.map((b) => (
        <Row
          key={b.channelId}
          title={b.channelName}
          detail={b.reason}
          onClick={() => go(`/c/${b.channelId}`)}
          right={<span className="pill hold">blocked</span>}
        />
      )),
    },
    {
      key: 'dueNow',
      title: 'Due to publish',
      tone: 'pass',
      count: queue.dueToPublish.length,
      why: 'Approved, and its day has come, but not out yet. Releasing is off, so publish it from the calendar or its channel.',
      rows: queue.dueToPublish.map((r) => <RunRow key={r.id} run={r} go={go} />),
    },
    {
      key: 'ready',
      title: 'To decide',
      tone: 'pass',
      count: queue.ready.length,
      why: "Passed its checks and nobody has decided yet: the publishing page's To decide tab. Listen, then approve it for a day.",
      rows: queue.ready.map((r) => <RunRow key={r.id} run={r} go={go} />),
    },
    {
      key: 'lined',
      title: 'Lined up',
      count: queue.scheduled.length,
      why: `Finished, with a release time that has not come. Ten shorts cut in one afternoon are all publishable at once, and publishing them together is what makes a feed look like somebody emptied a bucket into it. They go out one a day at a different hour each day. Nothing stops you publishing one now. Times are ${queue.timezone}.`,
      rows: queue.scheduled.map((r) => (
        <Row
          key={r.id}
          title={r.title ?? r.topic}
          detail={`${r.channelName}${r.short !== null ? ` · short ${r.short}` : ''}`}
          onClick={() => go(`/r/${r.id}`)}
          play={r.hasAudio ? r.id : undefined}
          right={
            <>
              <span className="muted mono tiny">{when(r.releaseAt, queue.timezone)}</span>
              <span className="pill">{until(r.releaseAt)}</span>
            </>
          }
        />
      )),
    },
    {
      key: 'due',
      title: 'Due to make',
      count: queue.due.length,
      why: 'What the schedule says should be made now. Nothing starts by itself.',
      rows: queue.due.map((d) => (
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
      )),
    },
    {
      key: 'soon',
      title: 'Coming up',
      count: queue.waiting.length,
      why: `Ready, but not yet its turn. Each show has a day and an hour so a week's work arrives spread across the week rather than in one lump. A slot that passes while nothing is running leaves the show overdue now, never pushed to next week. Times are ${queue.timezone}.`,
      rows: queue.waiting.map((w) => (
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
      )),
    },
    {
      key: 'stuck',
      title: 'Gate rejected',
      tone: 'fail',
      count: queue.failedTotal,
      why: 'The gate found something blocking. Most were superseded by a later episode and are only here because nothing deletes them, so the newest dozen are listed and the count is the true one. Open one to see which check failed.',
      rows: queue.failed.map((r) => <RunRow key={r.id} run={r} go={go} />),
    },
    {
      key: 'out',
      title: 'Published',
      count: queue.publishedTotal,
      why: 'Out in the world. The most recent dozen are listed.',
      rows: queue.published.map((r) => <RunRow key={r.id} run={r} go={go} />),
    },
  ];

  const live = sections.filter((s) => s.count > 0);
  const empty = sections.filter((s) => s.count === 0);

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '0.3rem' }}>
        <h1 className={`headline ${headline.tone ?? ''}`}>{headline.text}</h1>

        {/*
          THE NEXT STEP, NOT A MENU. Whatever the studio is waiting for, the
          button beside the headline does that thing. A page that always
          offered the same action regardless of state made you work out what
          to do from the numbers.
        */}
        <div className="row nowrap">
          {/* Straight to the channel with the most waiting, because
              publishing belongs to one show at a time. */}
          {queue.ready.length > 0 && (
            <button
              className="btn"
              onClick={() => {
                const counts = new Map<string, number>();
                for (const r of queue.ready) {
                  counts.set(r.channelId, (counts.get(r.channelId) ?? 0) + 1);
                }
                const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
                go(busiest ? `/c/${busiest[0]}/publish` : '/channels');
              }}
            >
              Decide {queue.ready.length}
            </button>
          )}
          <button
            className={queue.ready.length > 0 ? 'btn ghost' : 'btn'}
            onClick={() => go('/channels')}
          >
            Make something
          </button>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="counts" style={{ margin: '1.4rem 0 1.6rem' }}>
        <Count n={queue.held.length} label="to read" tone="hold" />
        <Count n={queue.ready.length} label="to decide" tone="pass" />
        <Count n={queue.scheduled.length} label="lined up" />
        <Count n={queue.due.length + queue.blocked.length} label="due" />
        <Count n={queue.publishedTotal} label="out" />
        <Count n={queue.failedTotal} label="rejected" tone="fail" />
      </div>

      <div className="stack tight">
        {live.map((s) => {
          const open = !shut.has(s.key);
          return (
            <section className="panel" key={`${s.key}-${s.title}`}>
              <div className="panel-head">
                <button className="panel-tap" onClick={() => toggle(s.key)}>
                  <span className={`caret${open ? ' open' : ''}`}>›</span>
                  <h2>{s.title}</h2>
                  <span className={`pill${s.tone ? ` ${s.tone}` : ''}`}>{s.count}</span>
                </button>
                <span className="spacer" />
                <span className="right-edge">
                  <Info label={`Why ${s.title.toLowerCase()} works this way`}>{s.why}</Info>
                </span>
              </div>
              {open && <div className="queue-list">{s.rows}</div>}
            </section>
          );
        })}

        {live.length === 0 && (
          <div className="empty">
            Nothing in the studio yet. <a href="#/channels">Pick a channel</a> and make something.
          </div>
        )}
      </div>

      {/*
        THE EMPTY ONES, AS A SENTENCE. "Nothing held" is worth knowing and is
        not worth a panel the same size as the thing that needs you.
      */}
      {empty.length > 0 && live.length > 0 && (
        <p className="faint" style={{ marginTop: '1.2rem', fontSize: '0.82rem' }}>
          Nothing {empty.map((s) => s.title.toLowerCase()).join(', ')}.
        </p>
      )}

      {/* The week, one line per show. */}
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
