/**
 * One channel: choose a route, give it a subject, start it.
 *
 * THE ROUTE IS THE FIRST DECISION AND IT IS ASKED OUT LOUD. An episode makes
 * one thing to publish. A set makes a script that is never published and is cut
 * into ten things that are. They cost differently, they are approved
 * differently, and they want different kinds of subject - so this page puts the
 * fork in front of you rather than hiding it in a format dropdown.
 *
 * THE SUBJECT BOX IS A TEXT BOX FIRST. Suggestions are a way to get a blank page
 * moving; they fill the box and are then yours to edit. Nothing here writes to a
 * queue on its own, because a studio that picks its own subjects converges on
 * whatever the model finds most available.
 */
import { useEffect, useState } from 'react';
import { api, ago, clock, money, type Channel as ChannelT, type Route, type RunSummary } from '../api';
import { ErrorNote, StatePill } from '../components/bits';

export const Channel = ({ id, go }: { id: string; go: (path: string) => void }) => {
  const [data, setData] = useState<{
    channel: ChannelT;
    topics: string[];
    sets: string[];
    runs: RunSummary[];
    budgetPence: number;
  } | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [topic, setTopic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [ideas, setIdeas] = useState<Array<{ topic: string; why: string }>>([]);

  useEffect(() => {
    api
      .channel(id)
      .then((d) => {
        setData(d);
        setRoute(d.channel.routes[0] ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error && !data) return <div className="page"><ErrorNote>{error}</ErrorNote></div>;
  if (!data) return <div className="page"><div className="empty">Reading the channel.</div></div>;

  const { channel, runs, budgetPence } = data;
  const queue = route?.kind === 'shorts' ? data.sets : data.topics;

  const start = async () => {
    if (!route || !topic.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const { runId } = await api.start({
        channelId: channel.id,
        formatId: route.formatId,
        topic: topic.trim(),
      });
      go(`/r/${runId}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  const suggest = async () => {
    if (!route) return;
    setSuggesting(true);
    setError(null);
    try {
      const { suggestions } = await api.suggest(channel.id, route.formatId);
      setIdeas(suggestions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">
          {channel.fiction ? 'Fiction lane' : 'Factual lane'} · {channel.category}
        </div>
        <h1>{channel.name}</h1>
        <p className="lede">{channel.thesis}</p>
        <div className="row mt">
          <span className="pill">@{channel.handle}</span>
          {channel.voice ? (
            <span className="pill pass">
              voice committed · {channel.voice.provider}/{channel.voice.voiceId}
            </span>
          ) : (
            <span className="pill hold">no voice committed yet</span>
          )}
          <span className="pill">budget {money(budgetPence)} a run</span>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/* --- The fork ---------------------------------------------------- */}
      <section className="mt2">
        <h2>What are you making?</h2>
        <p className="muted" style={{ marginTop: '0.35rem', marginBottom: '1rem' }}>
          Two routes out of this channel, and they are genuinely different things.
        </p>

        <div className="routes">
          {channel.routes.map((r) => (
            <button
              key={r.formatId}
              className="route"
              aria-pressed={route?.formatId === r.formatId}
              onClick={() => setRoute(r)}
            >
              <div className="route-kind">
                {r.kind === 'episode' ? 'One episode' : `${r.produces} shorts`}
              </div>
              <h3>{r.formatName}</h3>
              <p className="route-intent">{r.intent}</p>
              <div className="route-facts">
                <span>
                  {Math.round(r.seconds[0] / 60) < 1
                    ? `${r.seconds[0]}-${r.seconds[1]}s`
                    : `${Math.round(r.seconds[0] / 60)}-${Math.round(r.seconds[1] / 60)} min`}{' '}
                  each
                </span>
                <span>{r.minClaims}+ facts</span>
                <span>{r.beats} beats</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* --- The subject -------------------------------------------------- */}
      {route && (
        <section className="mt2">
          <h2>{route.kind === 'shorts' ? 'What body of material?' : 'What is it about?'}</h2>
          <p className="muted" style={{ marginTop: '0.35rem', marginBottom: '1rem' }}>
            {route.kind === 'shorts'
              ? 'Name something with ten genuinely different stories in it. Not a theme that forces ten angles on one thing.'
              : 'A subject, not a title. The research is planned from these words, so be specific.'}
          </p>

          <div className="panel">
            <div className="panel-body stack">
              <textarea
                className="field"
                rows={3}
                placeholder={
                  route.kind === 'shorts'
                    ? 'Norse mythology past the three stories everybody knows...'
                    : 'Why a bad night of sleep makes you forget things...'
                }
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />

              <div className="row">
                <button className="btn spend" disabled={!topic.trim() || starting} onClick={start}>
                  {starting
                    ? 'Starting...'
                    : route.kind === 'shorts'
                      ? 'Research and write the set'
                      : 'Research and write it'}
                </button>
                <button className="btn ghost" onClick={suggest} disabled={suggesting}>
                  {suggesting ? 'Thinking...' : 'Suggest subjects'}
                </button>
                <span className="spacer" />
                <span className="faint mono" style={{ fontSize: '0.75rem' }}>
                  {route.kind === 'shorts'
                    ? 'The set is never voiced. You cut it into shorts afterwards.'
                    : 'Stops before the audio. Nothing is voiced until you approve it.'}
                </span>
              </div>

              {ideas.length > 0 && (
                <div className="stack" style={{ gap: '0.5rem' }}>
                  <label className="lbl">Suggestions, yours to edit</label>
                  {ideas.map((idea) => (
                    <button
                      key={idea.topic}
                      className="route"
                      style={{ padding: '0.8rem 0.95rem' }}
                      onClick={() => setTopic(idea.topic)}
                    >
                      <div style={{ fontWeight: 500 }}>{idea.topic}</div>
                      <div className="faint" style={{ fontSize: '0.83rem', marginTop: '0.3rem' }}>
                        {idea.why}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {queue.length > 0 && (
                <div>
                  <label className="lbl">
                    Queued in topics/{channel.id}.yaml ({queue.length})
                  </label>
                  <div className="row" style={{ gap: '0.4rem' }}>
                    {queue.slice(0, 6).map((t) => (
                      <button
                        key={t}
                        className="btn ghost small"
                        onClick={() => setTopic(t)}
                        title={t}
                      >
                        {t.split(/[-–—]/)[0]!.trim().slice(0, 52)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* --- History ------------------------------------------------------ */}
      <section className="mt2">
        <h2>Runs</h2>
        {runs.length === 0 ? (
          <div className="empty mt">This channel has never been run.</div>
        ) : (
          <div className="panel mt" style={{ overflow: 'hidden' }}>
            <table className="runs">
              <thead>
                <tr>
                  <th>What</th>
                  <th>State</th>
                  <th className="right">Length</th>
                  <th className="right">Spent</th>
                  <th className="right">When</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => go(`/r/${r.id}`)}
                  >
                    <td>
                      <div style={{ fontWeight: 500 }}>{r.title ?? r.topic}</div>
                      <div className="faint mono" style={{ fontSize: '0.72rem' }}>
                        e{String(r.episode).padStart(3, '0')}
                        {r.short ? `-s${String(r.short).padStart(2, '0')}` : ''} · {r.formatId}
                      </div>
                    </td>
                    <td>
                      <StatePill state={r.state} />
                    </td>
                    <td className="right num">{clock(r.durationS)}</td>
                    <td className="right num">{money(r.spentPence)}</td>
                    <td className="right num">{ago(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
