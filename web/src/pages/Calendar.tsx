/**
 * A month of the studio, as a grid.
 *
 * WHY A GRID AND NOT ANOTHER LIST. The questions this answers are about shape:
 * do two shows land on the same day, is there a week with nothing in it, has a
 * channel gone quiet. Every one of those is obvious in a calendar and invisible
 * in a list sorted by date, which is why this is a separate view rather than
 * one more sort order on the publishing page.
 *
 * PAST AND FUTURE IN ONE GRID. What went out is the same kind of fact as what
 * is going to, and splitting them would make "did anything go out last week" a
 * different screen from "is anything going out next week".
 *
 * COLOUR IS THE CHANNEL, SHAPE IS THE KIND, FILL IS WHETHER IT IS REAL. Three
 * things to read off a box four millimetres tall, so each uses a different
 * channel of perception and none of them is colour alone - a solid box is out,
 * an outlined one is going to be, a faint one has a date nobody approved.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  clock,
  until,
  watchJob,
  when,
  type CalendarView,
  type CalendarEntry,
} from '../api';
import { ErrorNote } from '../components/bits';
import { Count, Info, PlayButton } from '../components/Info';

/**
 * A colour per channel, from its id.
 *
 * DERIVED RATHER THAN CONFIGURED, so a new channel has one the first time it
 * appears and nobody has to pick. Spread around the wheel at a fixed
 * saturation, so two channels are never nearly the same and none of them
 * competes with the amber that means spend.
 */
const hueFor = (channelId: string): number => {
  let h = 0;
  for (const c of channelId) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

const colourFor = (channelId: string): string => `hsl(${hueFor(channelId)} 58% 62%)`;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Monday-first, because the studio's week is a working week. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const shift = (month: string, by: number): string => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * The days to draw: the whole month, padded to whole weeks.
 *
 * The padding days are shown greyed rather than blank, because a grid that
 * starts mid-row with empty cells reads as missing data.
 */
const gridFor = (month: string): string[] => {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y!, m! - 1, 1));
  const last = new Date(Date.UTC(y!, m!, 0));

  // getUTCDay is Sunday-0; this week starts on Monday.
  const lead = (first.getUTCDay() + 6) % 7;
  const out: string[] = [];

  for (let i = -lead; out.length < Math.ceil((lead + last.getUTCDate()) / 7) * 7; i++) {
    const d = new Date(Date.UTC(y!, m! - 1, 1 + i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

const Entry = ({
  entry,
  onOpen,
}: {
  entry: CalendarEntry;
  onOpen: (e: CalendarEntry) => void;
}) => (
  <button
    className={`cal-entry ${entry.state} ${entry.kind}`}
    style={{ '--ch': colourFor(entry.channelId) } as React.CSSProperties}
    onClick={(e) => {
      e.stopPropagation();
      onOpen(entry);
    }}
    title={`${entry.channelName} · ${entry.kind} · ${entry.title}`}
  >
    {/* A tick, not a dot, once it is out: the one state that is a fact rather
        than an intention should say so without needing the colour read. */}
    {entry.state === 'published' ? (
      <span className="cal-tick" aria-label="published">
        ✓
      </span>
    ) : (
      <span className="cal-dot" />
    )}
    <span className="cal-entry-text">{entry.title}</span>
  </button>
);

export const Calendar = ({ go }: { go: (path: string) => void }) => {
  const [month, setMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));
  const [view, setView] = useState<CalendarView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<CalendarEntry | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** What the publish is doing right now, so the button is never silent. */
  const [step, setStep] = useState<string | null>(null);
  const [checked, setChecked] = useState<Awaited<ReturnType<typeof api.verifyPublished>> | null>(
    null
  );

  /** Something that finishes at once: cancelling. */
  const run = async (runId: string, fn: () => Promise<unknown>) => {
    setActing(runId);
    setError(null);
    try {
      await fn();
      setOpen(null);
      setConfirming(null);
      await load(month);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(null);
    }
  };

  /**
   * Publish, and wait for it to actually happen.
   *
   * PUBLISHING IS A JOB, NOT A REQUEST. The call returns a job id the moment
   * the upload starts, so awaiting it and reloading showed the calendar exactly
   * as it was - the episode was still mid-transcode - and the button looked
   * broken. It watches the job through and reloads when it is done, so the
   * entry moves to today and turns solid where you can see it.
   */
  const publishNow = (runId: string) => {
    setActing(runId);
    setError(null);
    setStep('starting');

    api
      .publish(runId, true)
      .then(({ jobId }) =>
        watchJob(jobId, {
          onEvent: (e) => setStep(e.message),
          onDone: async (r) => {
            setStep(null);
            setActing(null);
            setConfirming(null);

            if (r.error) {
              setError(r.error);
              return;
            }

            setOpen(null);
            await load(month);
          },
        })
      )
      .catch((e: Error) => {
        setError(e.message);
        setActing(null);
        setStep(null);
      });
  };

  const load = useCallback(
    (m: string) =>
      api
        .calendar(m)
        .then((v) => {
          setView(v);
          setError(null);
        })
        .catch((e: Error) => setError(e.message)),
    []
  );

  useEffect(() => {
    void load(month);

    /*
     * RE-READ ON A TIMER, because the other way something reaches this grid is
     * the releaser publishing it on its own at eight in the morning. Without
     * this, a calendar left open all day would still be showing yesterday's
     * answer, and the entry that went out at 08:00 would sit there outlined as
     * though it were still to come.
     *
     * A minute: nothing here changes faster than that, and the whole month is
     * a few file reads.
     */
    const timer = window.setInterval(() => void load(month), 60_000);
    return () => window.clearInterval(timer);
  }, [load, month]);

  if (!view) {
    return (
      <div className="page">
        <ErrorNote>{error}</ErrorNote>
        {!error && <p className="faint">...</p>}
      </div>
    );
  }

  const byDay = new Map(view.days.map((d) => [d.date, d.entries]));
  const days = gridFor(month);
  const inMonth = (date: string) => date.slice(0, 7) === month;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: view.timezone });

  const all = view.days.flatMap((d) => d.entries);
  const counts = {
    out: all.filter((e) => e.state === 'published').length,
    approved: all.filter((e) => e.state === 'approved').length,
  };

  const [y, m] = month.split('-').map(Number);

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '0.3rem' }}>
        <h1 className="headline">
          {MONTHS[m! - 1]} <span className="faint">{y}</span>
        </h1>
        <div className="row nowrap">
          <button className="btn ghost small" onClick={() => setMonth(shift(month, -1))}>
            ‹
          </button>
          <button
            className="btn ghost small"
            onClick={() => setMonth(new Date().toISOString().slice(0, 7))}
          >
            Today
          </button>
          <button className="btn ghost small" onClick={() => setMonth(shift(month, 1))}>
            ›
          </button>
        </div>
      </div>

      <div className="counts" style={{ margin: '1.2rem 0 1.1rem' }}>
        <Count n={counts.out} label="out this month" tone="pass" />
        <Count n={counts.approved} label="going out" />
        <Count n={view.queue.length} label="in the queue" />
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/*
        WHETHER THE GRID IS A PROMISE OR A WISH. A month of future dates means
        nothing if nothing acts on them, so it says which at the top rather
        than letting somebody assume.
      */}
      <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
        {view.releasing ? (
          <>
            <span className="pill pass">releasing on</span> Approved episodes publish themselves at
            these times, while the studio is running.
          </>
        ) : (
          <>
            <span className="pill hold">releasing off</span> Nothing publishes by itself. These are
            dates you approved; press publish on a card, or start the studio with{' '}
            <code className="mono tiny">FOUNDRY_RELEASE=on</code>.
          </>
        )}{' '}
        <Info label="What the boxes mean">
          Colour is the channel. A solid box has been published; an outlined one is approved and
          will go out at that time. Nothing else appears here: a calendar of things that are going
          to happen must not draw things nobody agreed to. Shorts are narrower than episodes. Times
          are {view.timezone}.
        </Info>
      </p>

      {/* Which colour is which show. */}
      {view.channels.length > 0 && (
        <div className="cal-key">
          {view.channels.map((c) => (
            <button key={c.id} className="cal-key-item" onClick={() => go(`/c/${c.id}/publish`)}>
              <span className="cal-dot" style={{ '--ch': colourFor(c.id) } as React.CSSProperties} />
              {c.name}
              {c.slot && <span className="faint tiny">{c.slot}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="cal-layout">
        {/*
          THE STACK. The grid shows the shape of a month; this shows the order,
          which is the thing you act on - and it is the only place something can
          be taken back out, or pushed out early.
        */}
        <aside className="stack-panel">
          <div className="row between" style={{ marginBottom: '0.6rem' }}>
            <h2 style={{ fontSize: '0.95rem' }}>Queue</h2>
            <span className="pill">{view.queue.length}</span>
          </div>

          {view.queue.length === 0 ? (
            <p className="faint tiny">
              Nothing approved. Approve episodes on a channel&apos;s publishing page and they
              appear here in the order they go out.
            </p>
          ) : (
            <ol className="stack-list">
              {view.queue.map((q) => (
                <li key={q.runId}>
                  <button
                    className={`stack-item${acting === q.runId ? ' busy' : ''}`}
                    style={{ '--ch': colourFor(q.channelId) } as React.CSSProperties}
                    onClick={() => {
                      setChecked(null);
                      setOpen(q);
                    }}
                  >
                    <span className="stack-n">{q.position}</span>
                    <span className="stack-body">
                      <span className="stack-title">{q.title}</span>
                      {/* Which channel it goes out as, on every row. */}
                      <span className="stack-meta">
                        <span className="cal-dot" />
                        {q.channelName} · {q.kind}
                      </span>
                      <span className="stack-when">
                        {when(q.at, view.timezone)} · {until(q.at)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </aside>

      <div className="cal">
        {WEEKDAYS.map((d) => (
          <div className="cal-head" key={d}>
            {d}
          </div>
        ))}

        {days.map((date) => {
          const entries = byDay.get(date) ?? [];
          return (
            <div
              key={date}
              className={`cal-day${inMonth(date) ? '' : ' outside'}${date === today ? ' today' : ''}${
                entries.length ? ' has' : ''
              }`}
            >
              <span className="cal-date">{Number(date.slice(8))}</span>
              {entries.map((e) => (
                <Entry
                  key={e.runId}
                  entry={e}
                  onOpen={(entry) => {
                    setChecked(null);
                    setOpen(entry);
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
      </div>

      {/* What is on that day, in full. */}
      {open && (
        <div className="cal-detail" onClick={() => setOpen(null)}>
          <div className="cal-card" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <span
                className="pill"
                style={
                  {
                    '--ch': colourFor(open.channelId),
                    color: colourFor(open.channelId),
                    borderColor: colourFor(open.channelId),
                  } as React.CSSProperties
                }
              >
                {open.channelName}
              </span>
              <button className="btn ghost small" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>

            <h2 style={{ fontSize: '1.15rem' }}>{open.title}</h2>

            <div className="row" style={{ gap: '0.5rem' }}>
              <span className="pill">{open.kind}</span>
              {open.short !== null && <span className="pill">short {open.short}</span>}
              {open.durationS !== null && <span className="pill">{clock(open.durationS)}</span>}
              <span className={`pill ${open.state === 'published' ? 'pass' : ''}`}>
                {open.state === 'published' ? 'published' : 'approved'}
              </span>
            </div>

            <p className="muted">
              {new Date(open.at).toLocaleString('en-GB', {
                timeZone: view.timezone,
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              <span className="faint tiny">{view.timezone}</span>
            </p>

            <ErrorNote>{error}</ErrorNote>

            {step && (
              <p className="muted tiny">
                <span className="pill live">
                  <span className="dot" />
                  {step}
                </span>
              </p>
            )}

            {/*
              ASK THE PLATFORM, rather than believing this studio's own note.
              Between the upload and a playable card are a transcode, a safety
              check and a fan-out, any of which can leave a row that exists and
              is not playable - and the studio would report it as published
              forever, because its own file says so.
            */}
            {open.state === 'published' && (
              <div className="row" style={{ gap: '0.5rem' }}>
                <button
                  className="btn ghost small"
                  onClick={() =>
                    void api
                      .verifyPublished(open.runId)
                      .then(setChecked)
                      .catch((e: Error) => setError(e.message))
                  }
                >
                  Check it is live
                </button>

                {checked?.live && (
                  <>
                    <span className="pill pass">live on the platform</span>
                    {checked.isAi ? (
                      <span className="pill pass">AI label on</span>
                    ) : (
                      <span className="pill fail">no AI label</span>
                    )}
                    {checked.status && <span className="pill">{checked.status}</span>}
                  </>
                )}
                {checked && checked.checked && !checked.live && (
                  <span className="pill fail">{checked.reason}</span>
                )}
                {checked && checked.checked === false && (
                  <span className="pill hold">could not check: {checked.reason}</span>
                )}
              </div>
            )}

            <div className="row">
              <PlayButton id={open.runId} src={api.audioUrl(open.runId)} />
              <button className="btn ghost small" onClick={() => go(`/r/${open.runId}`)}>
                Open the run
              </button>
              <button
                className="btn ghost small"
                onClick={() => go(`/c/${open.channelId}/publish`)}
              >
                {open.channelName}
              </button>
            </div>

            {/*
              THE TWO WAYS OUT OF THE QUEUE, and both live here rather than on
              the publishing page: cancelling and jumping the queue are both
              decisions you make while looking at what else is around it.
            */}
            {open.state === 'approved' && (
              <div className="row" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: '0.85rem' }}>
                <button
                  className="btn ghost small"
                  disabled={acting !== null}
                  onClick={() => void run(open.runId, () => api.cancelRelease(open.runId))}
                >
                  Cancel
                </button>
                <span className="faint tiny">Back to its channel, undecided.</span>
                <span className="spacer" />

                {confirming === open.runId ? (
                  <>
                    <button className="btn ghost small" onClick={() => setConfirming(null)}>
                      No
                    </button>
                    <button
                      className="btn spend small"
                      disabled={acting !== null}
                      onClick={() => publishNow(open.runId)}
                    >
                      {acting === open.runId ? 'Publishing...' : 'Yes, publish it now'}
                    </button>
                  </>
                ) : (
                  <button
                    className="btn small"
                    disabled={acting !== null}
                    onClick={() => setConfirming(open.runId)}
                  >
                    Publish now
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
