/**
 * One channel's publishing: what is waiting, what is approved, what is parked.
 *
 * THREE TABS BECAUSE THERE ARE THREE STATES, and a single list with flags on it
 * makes the one you are deciding about sit among forty you have already
 * decided. Something leaves the tab it was in when you act on it, which is what
 * makes the list you are reading shrink as you work rather than stay the same
 * length and grow badges.
 *
 *   Ready    passed the gate, nobody has decided. This is the deciding list.
 *   Approved a day, and a decision behind it. Read-only here: it can only be
 *            taken back out from the calendar, because cancelling is something
 *            you decide while looking at a month rather than at an episode.
 *   On hold  passed everything and is not wanted now. Comes back whole.
 *
 * APPROVING IS NOT SCHEDULING. It says this may go out; the day comes from what
 * the channel publishes in a week, so approving eight shorts for a show that
 * does three a week fills the next three weeks.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ago,
  api,
  clock,
  money,
  until,
  when,
  type Channel as ChannelT,
  type Gate,
  type Platform,
  type RunDetail,
  type RunSummary,
} from '../api';
import { ErrorNote, StatePill } from '../components/bits';
import { Count, Info, PlayButton, stopAudio } from '../components/Info';
import { FinalAudio } from '../components/FinalAudio';

type Tab = 'ready' | 'approved' | 'hold';

/** The script, the gate, and the two things you can do about them. */
const Opened = ({
  id,
  go,
  onChanged,
}: {
  id: string;
  go: (path: string) => void;
  onChanged: () => void;
}) => {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(
    () =>
      api
        .run(id)
        .then(setDetail)
        .catch((e: Error) => setError(e.message)),
    [id]
  );
  useEffect(() => void fetchDetail(), [fetchDetail]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!detail) return <p className="panel-body faint">Reading it...</p>;

  const gate: Gate | null = detail.gate;

  return (
    <div className="card-open">
      {detail.hasAudio && (
        <FinalAudio
          run={detail.run}
          onChanged={() => {
            void fetchDetail();
            onChanged();
          }}
        />
      )}
      <div className="script-read">
        {detail.script?.beats.flatMap((b) =>
          b.turns.map((t, i) => <p key={`${b.beatId}-${i}`}>{t.text}</p>)
        )}
      </div>

      {gate && (
        <div className="row" style={{ gap: '0.5rem' }}>
          {gate.passed ? (
            <span className="pill pass">gate passed</span>
          ) : (
            <span className="pill fail">
              {gate.findings.filter((f) => f.blocking).length} blocking
            </span>
          )}
          {gate.humanReviewReasons.map((r, i) => (
            <span key={i} className="faint tiny">
              {r}
            </span>
          ))}
        </div>
      )}

      <div className="row">
        <button className="btn ghost small" onClick={() => go(`/r/${id}`)}>
          Edit the script
        </button>
        <span className="faint tiny">Editing re-checks it and drops the audio.</span>
      </div>
    </div>
  );
};

const Row = ({
  run,
  children,
  open,
  onToggle,
  dim,
}: {
  run: RunSummary;
  children?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  dim?: boolean;
}) => (
  <div className={`pub-row${dim ? ' dim' : ''}`}>
    {run.hasAudio ? (
      <PlayButton id={run.id} src={api.audioUrl(run.id, run.audioKey)} />
    ) : (
      <span className="play empty" aria-hidden />
    )}

    <button className="order-main" onClick={onToggle}>
      <span className="queue-title">{run.title ?? run.topic}</span>
      <span className="muted">
        {run.short !== null ? `short ${run.short} · ` : 'episode · '}
        {clock(run.durationS)} · {money(run.spentPence)} · {ago(run.createdAt)}
        {run.music ? ' · with music' : ''}
      </span>
    </button>

    <span className="row nowrap">
      {/* On the row itself, not only inside the opened card, where it was
          easy to miss. The final audio, as an MP3. */}
      {run.hasAudio && (
        <a className="btn ghost small" href={api.downloadUrl(run.id)} download>
          Download MP3
        </a>
      )}
      {children}
    </span>
    <span className={`caret${open ? ' open' : ''}`}>›</span>
  </div>
);

export const Publish = ({ id, go }: { id: string; go: (path: string) => void }) => {
  const [channel, setChannel] = useState<ChannelT | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('ready');
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => stopAudio, []);

  const load = useCallback(
    () =>
      api
        .channel(id)
        .then((d) => {
          setChannel(d.channel);
          setRuns(d.runs);
          setError(null);
        })
        .catch((e: Error) => setError(e.message)),
    [id]
  );

  useEffect(() => {
    api
      .recheck(id)
      .catch(() => undefined)
      .finally(() => void load());

    void api
      .platform()
      .then(setPlatform)
      .catch(() => undefined);
  }, [id, load]);

  if (!channel) {
    return (
      <div className="page">
        <ErrorNote>{error}</ErrorNote>
        {!error && <p className="faint">...</p>}
      </div>
    );
  }

  const usable = runs.filter((r) => !r.isSource && r.state !== 'published');
  const ready = usable.filter((r) => r.state === 'ready' && !r.releaseAt && !r.heldAt);
  const approved = usable.filter((r) => r.releaseApprovedAt).sort(
    (a, b) => Date.parse(a.releaseAt!) - Date.parse(b.releaseAt!)
  );
  const onHold = usable.filter((r) => r.heldAt);
  const out = runs.filter((r) => r.state === 'published');

  const { account } = channel;
  const lists: Record<Tab, RunSummary[]> = { ready, approved, hold: onHold };
  const showing = lists[tab];

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setPicked(new Set());
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approveChosen = () =>
    act(async () => {
      const result = await api.approveForRelease(id, [...picked]);
      const first = result.approved[0];
      const last = result.approved[result.approved.length - 1];

      setNote(
        result.unscheduled.length
          ? `${result.approved.length} approved. ${result.unscheduled.length} could not be given a day: ${channel.name} publishes ${result.perWeek.shorts} shorts and ${result.perWeek.episodes} episode a week.`
          : first && last
            ? `${result.approved.length} approved, ${when(first.releaseAt, result.timezone)} to ${when(last.releaseAt, result.timezone)}.`
            : 'Approved.'
      );
      setTab('approved');
    });

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '0.3rem' }}>
        <h1 className="headline">
          Publishing <span className="faint">{channel.name}</span>
        </h1>
        <button className="btn ghost small" onClick={() => go('/calendar')}>
          The calendar
        </button>
      </div>

      <div className="counts" style={{ margin: '1.2rem 0 1.2rem' }}>
        <Count n={ready.length} label="to decide" tone={ready.length ? 'pass' : undefined} />
        <Count n={approved.length} label="approved" />
        <Count n={onHold.length} label="on hold" tone={onHold.length ? 'hold' : undefined} />
        <Count n={out.length} label="out" />
      </div>

      <ErrorNote>{error}</ErrorNote>
      {note && (
        <p className="muted" style={{ marginBottom: '0.8rem', fontSize: '0.85rem' }}>
          {note}{' '}
          <a
            href="#/calendar"
            onClick={(e) => {
              e.preventDefault();
              go('/calendar');
            }}
          >
            See them on the calendar
          </a>
        </p>
      )}

      {!account.canPublish ? (
        <div className="empty">
          {channel.name} cannot publish yet.{' '}
          <a
            href={`#/c/${id}`}
            onClick={(e) => {
              e.preventDefault();
              go(`/c/${id}`);
            }}
          >
            Finish setting it up
          </a>
          .
        </div>
      ) : (
        <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
          Goes out as <strong>@{account.handle}</strong> on{' '}
          <span className={platform?.isProduction ? 'is-live' : ''}>
            {platform?.isProduction ? 'production' : 'staging'}
          </span>
          .{' '}
          <Info label="What approving does">
            Approving says this may go out. The day comes from what {channel.name} publishes in a
            week, so approving more than a week&apos;s worth fills the following weeks rather than
            putting it all out at once - a cadence is a promise to somebody who follows the show.
            <br />
            <br />
            Once approved it moves to the Approved tab and is read-only here. It can only be taken
            back out from the calendar, where you can see what else would move.
            <br />
            <br />
            <strong>On hold</strong> is for something that passed everything and is not one you
            want out: the subject went cold, two cover the same ground, you want to rewrite the
            open. It comes back whole.
          </Info>
        </p>
      )}

      {/* --- The three states -------------------------------------------- */}
      <div className="subtabs">
        {(
          [
            ['ready', 'To decide', ready.length],
            ['approved', 'Approved', approved.length],
            ['hold', 'On hold', onHold.length],
          ] as Array<[Tab, string, number]>
        ).map(([key, label, n]) => (
          <button
            key={key}
            className={`subtab${tab === key ? ' on' : ''}`}
            onClick={() => {
              setTab(key);
              setOpen(null);
            }}
          >
            {label} <span className="subtab-n">{n}</span>
          </button>
        ))}
      </div>

      {tab === 'ready' && picked.size > 0 && (
        <div className="bar">
          <span className="muted">
            {picked.size} chosen, {channel.name} publishes {/* the ceiling, named */}
            <strong>
              {' '}
              {runs.some((r) => r.short !== null) ? 'shorts' : 'episodes'} on a weekly cadence
            </strong>
          </span>
          <span className="spacer" />
          <button className="btn ghost small" onClick={() => setPicked(new Set())}>
            Clear
          </button>
          <button className="btn spend" disabled={busy} onClick={approveChosen}>
            {busy ? 'Approving...' : `Approve ${picked.size} for publishing`}
          </button>
        </div>
      )}

      {showing.length === 0 ? (
        <div className="empty">
          {tab === 'ready'
            ? 'Nothing waiting to be decided.'
            : tab === 'approved'
              ? 'Nothing approved yet.'
              : 'Nothing on hold.'}
        </div>
      ) : (
        <div className="order">
          {showing.map((r) => (
            <div key={r.id}>
              {tab === 'ready' && (
                <div className="pub-line">
                  <input
                    type="checkbox"
                    className="tick"
                    checked={picked.has(r.id)}
                    onChange={() =>
                      setPicked((was) => {
                        const next = new Set(was);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                    aria-label={`Choose ${r.title ?? r.topic}`}
                  />
                  <Row run={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)}>
                    <button
                      className="btn ghost small"
                      disabled={busy}
                      onClick={() => void act(() => api.setHold(r.id, true))}
                    >
                      Hold
                    </button>
                  </Row>
                </div>
              )}

              {tab === 'approved' && (
                <Row
                  run={r}
                  dim
                  open={open === r.id}
                  onToggle={() => setOpen(open === r.id ? null : r.id)}
                >
                  <span className="muted mono tiny">
                    {when(r.releaseAt!, 'Europe/London')}
                  </span>
                  <span className="pill">{until(r.releaseAt!)}</span>
                </Row>
              )}

              {tab === 'hold' && (
                <Row run={r} dim open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)}>
                  <span className="pill hold">held {ago(r.heldAt!)}</span>
                  <button
                    className="btn ghost small"
                    disabled={busy}
                    onClick={() => void act(() => api.setHold(r.id, false))}
                  >
                    Take off hold
                  </button>
                </Row>
              )}

              {open === r.id && <Opened id={r.id} go={go} onChanged={() => void load()} />}
            </div>
          ))}
        </div>
      )}

      {tab === 'approved' && approved.length > 0 && (
        <p className="faint" style={{ marginTop: '0.9rem', fontSize: '0.82rem' }}>
          Read-only here. Cancel one from{' '}
          <a
            href="#/calendar"
            onClick={(e) => {
              e.preventDefault();
              go('/calendar');
            }}
          >
            the calendar
          </a>
          , where you can see what else is around it.
        </p>
      )}

      {out.length > 0 && (
        <section className="panel" style={{ marginTop: '1.5rem' }}>
          <div className="panel-head">
            <h2>Out</h2>
            <span className="pill pass">{out.length}</span>
          </div>
          <div className="queue-list">
            {out.map((r) => (
              <button key={r.id} className="queue-row" onClick={() => go(`/r/${r.id}`)}>
                {r.hasAudio ? <PlayButton id={r.id} src={api.audioUrl(r.id, r.audioKey)} /> : null}
                <span className="queue-main">
                  <span className="queue-title">{r.title ?? r.topic}</span>
                  <span className="muted">{ago(r.createdAt)}</span>
                </span>
                <StatePill state={r.state} stage={r.liveStage} />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
