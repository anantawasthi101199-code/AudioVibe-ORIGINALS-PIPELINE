/**
 * One channel's publishing: what it has ready, in what order, and out.
 *
 * UNDER THE CHANNEL, NOT BESIDE IT. This was a studio-wide list, which sounded
 * tidier and is not how anybody works. You set a channel up, you look at what
 * that channel made, you decide what that channel puts out - so a list whose
 * top three rows belong to a show you are not thinking about is worse than
 * useless: ticking one publishes to an account you did not have in mind.
 *
 * THE CARD IS THE WHOLE DECISION. Everything a person needs before saying yes
 * is on it: what it is called, what it will say, what it sounds like, what the
 * gate thought. Making any of that a separate page meant it was skipped, and
 * the one check a person can make that no gate can is whether it sounds right.
 *
 * READ, THEN LISTEN, THEN ORDER, THEN PUBLISH - in that order down the page,
 * because that is the order the decisions actually happen in.
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

type Item = RunSummary & { queued: boolean };

/** The script and gate for one card, fetched only when somebody opens it. */
const Opened = ({
  id,
  go,
  onPublished,
  platform,
}: {
  id: string;
  go: (path: string) => void;
  onPublished: () => void;
  platform: Platform | null;
}) => {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .run(id)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!detail) return <p className="panel-body faint">Reading it...</p>;

  const gate: Gate | null = detail.gate;
  const blocking = (gate?.findings ?? []).filter((f) => f.blocking);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.publish(id, true);
      onPublished();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="card-open">
      {/* What it will actually say. */}
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
            <span className="pill fail">{blocking.length} blocking</span>
          )}
          {gate.needsHumanReview &&
            gate.humanReviewReasons.map((r, i) => (
              <span key={i} className="faint tiny">
                {r}
              </span>
            ))}
        </div>
      )}

      <ErrorNote>{error}</ErrorNote>

      <div className="row">
        <button className="btn ghost small" onClick={() => go(`/r/${id}`)}>
          Edit the script
        </button>
        <span className="faint tiny">Editing re-checks it and drops the audio.</span>
        <span className="spacer" />

        {confirming ? (
          <>
            <button className="btn ghost small" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="btn spend small" disabled={busy} onClick={publish}>
              {busy
                ? 'Publishing...'
                : `Yes, publish to ${platform?.isProduction ? 'production' : 'staging'}`}
            </button>
          </>
        ) : (
          <button
            className="btn small"
            disabled={!gate?.passed || !platform?.configured}
            onClick={() => setConfirming(true)}
          >
            Publish this one
          </button>
        )}
      </div>
    </div>
  );
};

export const Publish = ({ id, go }: { id: string; go: (path: string) => void }) => {
  const [channel, setChannel] = useState<ChannelT | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [published, setPublished] = useState<RunSummary[]>([]);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Whether anything acts on an approval, so the page can say so. */
  const [releasing, setReleasing] = useState<boolean | null>(null);

  useEffect(() => stopAudio, []);

  const load = useCallback(
    () =>
      api
        .channel(id)
        .then((d) => {
          setChannel(d.channel);
          setError(null);
          setPublished(d.runs.filter((r) => r.state === 'published'));

          setDirty((wasDirty) => {
            if (wasDirty) return wasDirty;

            // Queued first in release order. The rest in the order they were
            // written - short 1, short 2 - rather than newest first, because a
            // set of shorts has a reading order and reversing it makes the list
            // look shuffled.
            const ready = d.runs.filter((r) => r.state === 'ready' && !r.isSource);
            const queued = ready
              .filter((r) => r.releaseAt)
              .sort((a, b) => Date.parse(a.releaseAt!) - Date.parse(b.releaseAt!))
              .map((r) => ({ ...r, queued: true }));
            const rest = ready
              .filter((r) => !r.releaseAt)
              .sort((a, b) => (a.episode - b.episode) || (a.short ?? 0) - (b.short ?? 0))
              .map((r) => ({ ...r, queued: false }));

            setItems([...queued, ...rest]);
            return wasDirty;
          });
        })
        .catch((e: Error) => setError(e.message)),
    [id]
  );

  useEffect(() => {
    // RE-CHECK BEFORE LISTING. A run's state comes from the gate report stored
    // beside it, written the day it was made, so a run that passes under
    // today's checks can read as rejected forever because nothing looks at it
    // again. One short sat as failed through an entire clean-up for exactly
    // that reason. The gate is arithmetic with no model calls, so this costs
    // a few file reads.
    api
      .recheck(id)
      .catch(() => undefined)
      .finally(() => void load());

    void api
      .platform()
      .then(setPlatform)
      .catch(() => undefined);

    void api
      .calendar()
      .then((c) => setReleasing(c.releasing))
      .catch(() => undefined);
  }, [id, load]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row!);
    setItems(next);
    setDirty(true);
  };

  const tick = (runId: string) => {
    setItems((was) => was.map((r) => (r.id === runId ? { ...r, queued: !r.queued } : r)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setPublishQueue(
        id,
        items.filter((r) => r.queued).map((r) => r.id)
      );
      setDirty(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!channel) {
    return (
      <div className="page">
        <ErrorNote>{error}</ErrorNote>
        {!error && <p className="faint">...</p>}
      </div>
    );
  }

  const chosen = items.filter((r) => r.queued);
  const { account } = channel;

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '0.3rem' }}>
        <h1 className="headline">
          Publishing <span className="faint">{channel.name}</span>
        </h1>
        <div className="row nowrap">
          {dirty && (
            <button className="btn ghost" onClick={() => void load()} disabled={saving}>
              Undo
            </button>
          )}
          {items.length > 0 && (
            <button className="btn spend" onClick={save} disabled={!dirty || saving}>
              {saving
                ? 'Approving...'
                : dirty
                  ? `Approve ${chosen.length} for release`
                  : 'Approved'}
            </button>
          )}
        </div>
      </div>

      <div className="counts" style={{ margin: '1.2rem 0 1.4rem' }}>
        <Count n={items.length} label="ready" tone="pass" />
        <Count n={chosen.length} label="queued" />
        <Count n={published.length} label="out" />
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/*
        THE ACCOUNT IT PUBLISHES AS, NAMED. Everything below goes out as this
        one, and nothing else on this page says which.
      */}
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
          <Info label="The two ways something goes out">
            <strong>Now</strong> is a card at a time: open it, read it, listen, press publish.
            <br />
            <br />
            <strong>At a set time</strong> is this list: tick what goes out, drag it into order,
            and save. Position gives each one a date, one a day starting tomorrow at{' '}
            {channel.name}&apos;s own slot hour, and saving records that you approved them -
            which is what lets them go out without you.
            <br />
            <br />
            Approving is the same act as pressing publish, made in advance. The gate is checked
            again at the moment each one goes, so a script edited after approval is re-read on
            the way out and skipped if it no longer passes.
          </Info>
        </p>
      )}

      {releasing !== null && chosen.length > 0 && (
        <p className="muted" style={{ marginBottom: '0.9rem', fontSize: '0.85rem' }}>
          {releasing ? (
            <>
              <span className="pill pass">releasing on</span> These publish themselves at their
              times, while the studio is running.
            </>
          ) : (
            <>
              <span className="pill hold">releasing off</span> Approved, but nothing acts on it
              yet. Start the studio with <code className="mono tiny">FOUNDRY_RELEASE=on</code>, or
              publish each from its card.
            </>
          )}{' '}
          <a
            href="#/calendar"
            onClick={(e) => {
              e.preventDefault();
              go('/calendar');
            }}
          >
            See the month
          </a>
        </p>
      )}

      {items.length === 0 ? (
        <div className="empty">
          Nothing ready.{' '}
          <a
            href={`#/c/${id}`}
            onClick={(e) => {
              e.preventDefault();
              go(`/c/${id}`);
            }}
          >
            Make something
          </a>{' '}
          first.
        </div>
      ) : (
        <div className="order">
          {items.map((r, i) => (
            <div key={r.id}>
              <div
                className={`order-row${r.queued ? ' on' : ''}${dragging === r.id ? ' dragging' : ''}`}
                draggable
                onDragStart={() => setDragging(r.id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  const from = items.findIndex((x) => x.id === dragging);
                  if (from >= 0 && from !== i) move(from, i);
                }}
              >
                <span className="grip" aria-hidden>
                  ⠿
                </span>

                <input
                  type="checkbox"
                  className="tick"
                  checked={r.queued}
                  onChange={() => tick(r.id)}
                  aria-label={`Queue ${r.title ?? r.topic}`}
                />

                <span className="order-n mono">{r.queued ? chosen.indexOf(r) + 1 : '—'}</span>

                {r.hasAudio ? (
                  <PlayButton id={r.id} src={api.audioUrl(r.id)} />
                ) : (
                  <span className="play empty" aria-hidden />
                )}

                <button
                  className="order-main"
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                >
                  <span className="queue-title">{r.title ?? r.topic}</span>
                  <span className="muted">
                    {r.short !== null ? `short ${r.short} · ` : ''}
                    {clock(r.durationS)} · {money(r.spentPence)} · {ago(r.createdAt)}
                  </span>
                </button>

                <span className="row nowrap order-when">
                  {r.queued && r.releaseAt && !dirty ? (
                    <>
                      <span className="muted mono tiny">{when(r.releaseAt, 'Europe/London')}</span>
                      <span className="pill">{until(r.releaseAt)}</span>
                    </>
                  ) : r.queued ? (
                    <span className="pill">day {chosen.indexOf(r) + 1}</span>
                  ) : null}
                  <span className={`caret${open === r.id ? ' open' : ''}`}>›</span>
                </span>

                <span className="nudge">
                  <button onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up">
                    ↑
                  </button>
                  <button
                    onClick={() => move(i, i + 1)}
                    disabled={i === items.length - 1}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                </span>
              </div>

              {open === r.id && (
                <Opened
                  id={r.id}
                  go={go}
                  platform={platform}
                  onPublished={() => {
                    setOpen(null);
                    void load();
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {published.length > 0 && (
        <section className="panel" style={{ marginTop: '1.5rem' }}>
          <div className="panel-head">
            <h2>Out</h2>
            <span className="pill pass">{published.length}</span>
          </div>
          <div className="queue-list">
            {published.map((r) => (
              <button key={r.id} className="queue-row" onClick={() => go(`/r/${r.id}`)}>
                {r.hasAudio ? <PlayButton id={r.id} src={api.audioUrl(r.id)} /> : null}
                <span className="queue-main">
                  <span className="queue-title">{r.title ?? r.topic}</span>
                  <span className="muted">{ago(r.createdAt)}</span>
                </span>
                <StatePill state={r.state} />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
