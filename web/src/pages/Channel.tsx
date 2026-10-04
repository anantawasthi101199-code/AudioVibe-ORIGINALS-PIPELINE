/**
 * One channel: set it up once, then make things with it.
 *
 * SETUP IS AT THE TOP AND DISAPPEARS WHEN IT IS DONE. A channel needs an
 * account, a publishing credential and sometimes a series, each done once ever.
 * While any of them is missing it is the only thing on this page that matters,
 * because everything below it will fail at the last step. Once all three are
 * there the strip collapses to a single line and stays out of the way.
 *
 * THE ROUTE IS THE FIRST DECISION AND IT IS STILL ASKED OUT LOUD. An episode
 * makes one thing to publish; a set makes a script that is never published and
 * is cut into ten that are. They cost differently and want different subjects.
 * But the paragraph explaining that is behind a mark now, because you need it
 * once and then never again.
 */
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ago,
  clock,
  money,
  watchJob,
  type ArtKind,
  type ArtState,
  type Channel as ChannelT,
  type JobEvent,
  type Platform,
  type Route,
  type RunSummary,
  type CoveredView,
  type SeasonView,
} from "../api";
import { ErrorNote, StatePill } from "../components/bits";
import { Count, Info, PlayButton } from "../components/Info";
import { ImagePicker } from "../components/ImagePicker";

/** The once-per-channel jobs, which is where everything platform-facing lives. */
const Setup = ({
  channel,
  platform,
  onDone,
}: {
  channel: ChannelT;
  platform: Platform | null;
  onDone: () => void;
}) => {
  const [openPanel, setOpenPanel] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [art, setArt] = useState<Record<ArtKind, ArtState> | null>(null);

  // Its own call rather than part of the channel payload, because it changes
  // on its own schedule: picking a file must update these two without
  // reloading every run on the page behind them.
  const loadArt = useCallback(async () => {
    try {
      setArt(await api.channelArtState(channel.id));
    } catch {
      setArt(null);
    }
  }, [channel.id]);

  useEffect(() => void loadArt(), [loadArt]);

  const { account } = channel;
  // A show that publishes loose episodes never needs a shelf, so it is set up
  // as soon as it has an account and a credential. Showing it a third step it
  // will never complete would leave it permanently unfinished.
  const done =
    account.exists &&
    account.canPublish &&
    (!account.needsSeries || account.hasSeries);

  const watch = (jobId: string, what: string) => {
    setBusy(what);
    setLog([]);
    watchJob(jobId, {
      onEvent: (e) => setLog((was) => [...was, e]),
      onDone: (r) => {
        setBusy(null);
        if (r.error) setError(r.error);
        onDone();
      },
    });
  };

  const create = async (redraw = false) => {
    setError(null);
    try {
      const { jobId } = await api.setUpChannel(
        channel.id,
        email,
        password,
        redraw,
      );
      // An existing account re-running setup is sending artwork, not creating
      // anything, and the button that is spinning should be the one pressed.
      watch(jobId, redraw ? "artwork" : account.exists ? "upload" : "account");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const record = async () => {
    setError(null);
    try {
      await api.recordToken(channel.id, token.trim());
      setToken("");
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const series = async () => {
    setError(null);
    try {
      const { jobId } = await api.createSeries(channel.id);
      watch(jobId, "series");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // DONE AND SHUT is one line. There is nothing to do here again.
  if (done && !openPanel) {
    return (
      <button className="setup-done" onClick={() => setOpenPanel(true)}>
        <span className="pill pass">set up</span>
        <span className="muted">
          @{account.handle} on{" "}
          {platform?.isProduction ? "production" : "staging"}
          {account.needsSeries ? " · series" : ""}
        </span>
        <span className="spacer" />
        <span className="faint tiny">open</span>
      </button>
    );
  }

  return (
    <section className="panel setup">
      <div className="panel-head">
        <h2>Setting up</h2>
        {done && <span className="pill pass">done</span>}
        <span className="spacer" />
        {platform?.configured && (
          <span className={`where${platform.isProduction ? " live" : ""}`}>
            <span className="dot" />
            {platform.isProduction
              ? "production"
              : new URL(platform.url!).hostname}
          </span>
        )}
        <span className="right-edge">
          <Info label="Why setting up works this way">
            Three things, each done once ever. The account is created as a
            declared AI show, which renders the label on every card it publishes
            and is checked rather than assumed. The publishing credential cannot
            be made from here: the platform has no endpoint that issues machine
            credentials, deliberately, so a person mints one on the API server.
            The series is the shelf a show&apos;s episodes sit on, and it is a
            button rather than something a publish does by itself, because
            creating a second one would fork the show.
          </Info>
        </span>
      </div>

      <div className="panel-body stack">
        <ErrorNote>{error}</ErrorNote>

        {/* 1. The account */}
        <div className="step">
          <span className={`step-n${account.exists ? " done" : ""}`}>1</span>
          <div
            className="stack"
            style={{ gap: "0.5rem", flex: 1, minWidth: 0 }}
          >
            {account.exists ? (
              <div className="stack" style={{ gap: "0.5rem" }}>
                <span className="muted">
                  Account <strong>@{account.handle}</strong>
                </span>

                {/*
                  A CHANNEL'S FACE HAS TO BE CHANGEABLE. Reuse is the default
                  and should be - it must not change because somebody re-ran a
                  command - but deleting two files by hand is not a way to
                  change it deliberately, it is a thing you have to know.

                  NO CREDENTIALS. The account exists, so this signs in as the
                  channel with the password this studio already recorded; admin
                  is only ever needed to bring an account into existence.
                */}
                {/*
                  TWO BUTTONS, BECAUSE THEY COST DIFFERENTLY. Sending uses
                  whatever is already on disk and spends nothing. Redrawing
                  calls an image model for every picture nobody supplied, which
                  is the right thing when you want a new one and an accidental
                  charge when you only wanted to upload the file you just
                  picked.
                */}
                <div className="row" style={{ gap: "0.5rem" }}>
                  <button
                    className="btn small"
                    disabled={busy !== null}
                    onClick={() => void create(false)}
                  >
                    {busy === "upload"
                      ? "Sending..."
                      : "Send artwork to the platform"}
                  </button>
                  <button
                    className="btn small ghost"
                    disabled={busy !== null}
                    onClick={() => void create(true)}
                  >
                    {busy === "artwork" ? "Redrawing..." : "Redraw"}
                  </button>
                  <span className="faint tiny">
                    Sending costs nothing. Redrawing makes a new picture for
                    anything you have not supplied, and leaves what you have
                    supplied alone.
                  </span>
                </div>
              </div>
            ) : (
              <>
                <div className="row" style={{ gap: "0.5rem" }}>
                  <input
                    className="field"
                    style={{ maxWidth: "16rem" }}
                    placeholder="Admin email"
                    autoComplete="off"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <input
                    className="field"
                    style={{ maxWidth: "13rem" }}
                    type="password"
                    placeholder="Admin password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    className="btn spend"
                    disabled={!email || !password || busy !== null}
                    onClick={() => void create()}
                  >
                    {busy === "account" ? "Creating..." : "Create account"}
                  </button>
                </div>
                <span className="faint tiny">
                  Account, profile, avatar and cover. Once per channel, ever.
                </span>
              </>
            )}

            {/*
              THE PICTURES, AND THEY SIT ABOVE THE CREATE BUTTON'S OUTCOME
              RATHER THAN AFTER IT. Choosing them before the account exists is
              the point: setup uploads whatever is here, so a channel can be
              born wearing its real artwork instead of a monogram that somebody
              then has to go and replace.
            */}
            <div className="art-pair">
              <ImagePicker
                title="Profile picture"
                note="The circle on the profile and beside every card this channel publishes."
                state={art?.avatar ?? null}
                src={
                  art
                    ? `/api/channel/art?id=${encodeURIComponent(channel.id)}&kind=avatar`
                    : null
                }
                disabled={busy !== null}
                onUpload={async (image) => {
                  await api.uploadChannelArt(channel.id, "avatar", image);
                  await loadArt();
                }}
                onRemove={async () => {
                  await api.removeChannelArt(channel.id, "avatar");
                  await loadArt();
                }}
              />
              <ImagePicker
                title="Cover image"
                note="The banner across the top of the profile. The app overlays the profile picture and handle over its lower left, so keep that corner clear."
                state={art?.cover ?? null}
                src={
                  art
                    ? `/api/channel/art?id=${encodeURIComponent(channel.id)}&kind=cover`
                    : null
                }
                disabled={busy !== null}
                onUpload={async (image) => {
                  await api.uploadChannelArt(channel.id, "cover", image);
                  await loadArt();
                }}
                onRemove={async () => {
                  await api.removeChannelArt(channel.id, "cover");
                  await loadArt();
                }}
              />
            </div>

            {account.exists &&
              (art?.avatar.supplied || art?.cover.supplied) && (
                <span className="faint tiny">
                  Choosing a file here does not touch the live profile by
                  itself. Press &ldquo;Send artwork to the platform&rdquo; above
                  to put it there.
                </span>
              )}
          </div>
        </div>

        {/* 2. The credential */}
        <div className="step">
          <span className={`step-n${account.canPublish ? " done" : ""}`}>
            2
          </span>
          <div
            className="stack"
            style={{ gap: "0.5rem", flex: 1, minWidth: 0 }}
          >
            {account.canPublish ? (
              <span className="muted">Can publish</span>
            ) : (
              <>
                <code className="mint">
                  node dist/scripts/mintIngestToken.js --username{" "}
                  {account.handle ?? channel.handle}
                </code>
                <span className="faint tiny">
                  In the Railway shell for the API service. The deployed image
                  ships compiled JavaScript only, so the ts-node form fails
                  there.
                </span>
                <div className="row" style={{ gap: "0.5rem" }}>
                  <input
                    className="field"
                    style={{ flex: 1, minWidth: "14rem" }}
                    placeholder="Paste the token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <button
                    className="btn"
                    disabled={!token.trim() || !account.exists}
                    onClick={record}
                  >
                    Record
                  </button>
                </div>
                <span className="faint tiny">
                  This studio cannot mint one: the platform has no endpoint that
                  issues machine credentials.
                </span>
              </>
            )}
          </div>
        </div>

        {/* 3. The shelf, only for shows that have one */}
        {account.needsSeries && (
          <div className="step">
            <span className={`step-n${account.hasSeries ? " done" : ""}`}>
              3
            </span>
            <div
              className="stack"
              style={{ gap: "0.5rem", flex: 1, minWidth: 0 }}
            >
              {account.hasSeries ? (
                <span className="muted">Series exists</span>
              ) : (
                <>
                  <ImagePicker
                    title="Series cover"
                    note="The 16:9 shelf art. Read once, when the series is created; without one it is drawn."
                    state={art?.series ?? null}
                    src={
                      art?.series.supplied
                        ? `/api/channel/art?id=${encodeURIComponent(channel.id)}&kind=series`
                        : null
                    }
                    disabled={busy !== null}
                    onUpload={async (image) => {
                      await api.uploadChannelArt(channel.id, "series", image);
                      await loadArt();
                    }}
                    onRemove={async () => {
                      await api.removeChannelArt(channel.id, "series");
                      await loadArt();
                    }}
                  />
                  <div className="row" style={{ gap: "0.5rem" }}>
                    <button
                      className="btn"
                      disabled={!account.canPublish || busy !== null}
                      onClick={series}
                    >
                      {busy === "series" ? "Creating..." : "Create series"}
                    </button>
                    <span className="faint tiny">
                      The shelf its episodes sit on.
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {log.length > 0 && (
          <div className="log">
            {log.slice(-8).map((e, i) => (
              <div className="log-line" key={i}>
                <span className="mono tiny faint">{e.stage}</span> {e.message}
              </div>
            ))}
          </div>
        )}

        {done && (
          <button
            className="btn ghost small"
            onClick={() => setOpenPanel(false)}
          >
            Close
          </button>
        )}
      </div>
    </section>
  );
};

export const Channel = ({
  id,
  go,
}: {
  id: string;
  go: (path: string) => void;
}) => {
  const [data, setData] = useState<{
    channel: ChannelT;
    topics: string[];
    sets: string[];
    runs: RunSummary[];
    budgetPence: number;
  } | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [topic, setTopic] = useState("");
  const [seriesTitle, setSeriesTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [ideas, setIdeas] = useState<Array<{ topic: string; why: string }>>([]);
  // THE SEASON PLAN AND THE COVERED LEDGER. Both are read-only here on purpose:
  // breaking a season costs money and editing a plan is a text edit that wants
  // a text editor, so the page shows them and points at the command rather than
  // growing two more buttons that spend.
  const [season, setSeason] = useState<SeasonView | null>(null);
  const [covered, setCovered] = useState<CoveredView | null>(null);
  // What the topic being typed clashes with, checked as it is typed.
  //
  // THE SERVER DECIDES, NOT THE PAGE. The same call `make` makes before it
  // spends anything, so the warning here cannot say one thing while the
  // pipeline does another. Reimplementing the match in the browser would be two
  // definitions of "already covered" that agree until one is edited.
  const [clash, setClash] = useState<CoveredView["matches"]>([]);

  const load = useCallback(
    () =>
      api
        .channel(id)
        .then((d) => {
          setData(d);
          setRoute((was) => was ?? d.channel.routes[0] ?? null);
        })
        .catch((e: Error) => setError(e.message)),
    [id],
  );

  useEffect(() => {
    void load();
    void api
      .platform()
      .then(setPlatform)
      .catch(() => undefined);
    // Both fail quietly. A channel page that will not render because the
    // duplicate ledger is missing has traded something useful for something
    // decorative.
    void api
      .covered(id)
      .then(setCovered)
      .catch(() => undefined);
  }, [load, id]);

  // Only a fiction show has a season, and asking for one on a factual show is a
  // 400 rather than an empty answer.
  useEffect(() => {
    if (!data?.channel.fiction) return;
    void api
      .season(id)
      .then(setSeason)
      .catch(() => undefined);
  }, [data?.channel.fiction, id]);

  useEffect(() => {
    const t = topic.trim();
    if (!t || data?.channel.fiction) {
      setClash([]);
      return;
    }

    // Debounced, because this fires on every keystroke and the answer only
    // matters once somebody has stopped typing a subject.
    const timer = window.setTimeout(() => {
      void api
        .covered(id, t)
        .then((d) => setClash(d.matches))
        .catch(() => setClash([]));
    }, 400);

    return () => window.clearTimeout(timer);
  }, [topic, id, data?.channel.fiction]);

  if (error && !data) {
    return (
      <div className="page">
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }
  if (!data) return <div className="page faint">...</div>;

  const { channel, runs, budgetPence } = data;
  const queue = route?.kind === "shorts" ? data.sets : data.topics;
  const ready = runs.filter((r) => r.state === "ready" && !r.isSource).length;

  // Whether the topic as typed would be refused. Same threshold the server
  // uses, and the server is still the one that decides.
  const refused = clash.some((m) => m.sameShow && m.score >= 0.6);

  const start = async (again = false, blank = false) => {
    if (!route || !topic.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const { runId } = await api.start({
        channelId: channel.id,
        formatId: route.formatId,
        topic: topic.trim(),
        again,
        blank,
        seriesTitle:
          route.long && seriesTitle.trim() ? seriesTitle.trim() : undefined,
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
      <div className="row between" style={{ marginBottom: "1.2rem" }}>
        <h1 style={{ fontSize: "1.5rem" }}>
          {channel.name}{" "}
          <span className="faint mono tiny">@{channel.handle}</span>
        </h1>
        <Info label="What this show is">{channel.thesis}</Info>
      </div>

      <div className="counts" style={{ marginBottom: "1.4rem" }}>
        <Count n={runs.length} label="runs" />
        <Count
          n={runs.filter((r) => r.state === "published").length}
          label="out"
        />
        <Count
          n={runs.filter((r) => r.state === "awaiting-approval").length}
          label="held"
          tone={
            runs.some((r) => r.state === "awaiting-approval")
              ? "hold"
              : undefined
          }
        />
        {/* "topics", not "queued": queued means waiting for a release date on
            the publishing page, and one word meaning two things on adjacent
            screens is how somebody reads the wrong number. */}
        <Count n={data.topics.length + data.sets.length} label="topics" />
        <Count n={money(budgetPence)} label="budget" />
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="stack tight">
        <Setup
          channel={channel}
          platform={platform}
          onDone={() => void load()}
        />

        {/*
          --- Publishing -------------------------------------------------
          A STEP, NOT A TAB. Set the channel up, then decide what goes out, for
          one show, on one page. The studio-wide list this replaced put three
          rows of another show's work above yours, where ticking one published
          to the wrong account.

          ABOVE `Make` rather than below it, so `Make` sits against the runs
          list it fills: what you asked for and what came of it read as one
          pair. It also puts the thing with work waiting above the thing that
          starts more of it.
        */}
        {ready > 0 && (
          <button
            className="panel step-on"
            onClick={() => go(`/c/${channel.id}/publish`)}
          >
            {/* The count, not a step number: this no longer sits third in a
                numbered sequence, and a stale "3" above `Make` would imply
                making something is step four. */}
            <span className="step-n done">{ready}</span>
            <span
              className="stack"
              style={{ gap: "0.15rem", flex: 1, minWidth: 0 }}
            >
              <span className="queue-title">
                {ready} ready to publish as @
                {channel.account.handle ?? channel.handle}
              </span>
              <span className="muted tiny">
                Read them, listen, order them, publish
              </span>
            </span>
            <span className="caret">›</span>
          </button>
        )}

        {/* --- The season plan, for a serial ---------------------------- */}
        {channel.fiction && (
          <section className="panel">
            <div className="panel-head">
              <h2>Season</h2>
              <span className="spacer" />
              <span className="right-edge">
                <Info label="Why a serial is planned first">
                  A serial written one episode at a time from a summary of the
                  last one cannot foreshadow, because nothing knows where the
                  last episode ends. Breaking the season first is what lets
                  episode two plant something episode seven pays off. The plan
                  costs about a tenth of one written episode, which is the whole
                  point: it is the cheapest place to change your mind.
                </Info>
              </span>
            </div>

            <div className="panel-body stack">
              {!season && <p className="faint">...</p>}

              {season && !season.plan && (
                <>
                  <p className="muted">
                    No season planned. Episodes will be written from the series
                    bible alone, which works, but nothing will be planted for a
                    later episode to pay off.
                  </p>
                  <code className="tiny">
                    npm run foundry -- season --show {channel.id} --episodes 8
                  </code>
                </>
              )}

              {season?.plan && (
                <>
                  <div>
                    <strong>{season.plan.title}</strong>
                    <span
                      className="muted tiny"
                      style={{ marginLeft: "0.6rem" }}
                    >
                      season {season.plan.seasonNumber},{" "}
                      {season.plan.episodes.length} episodes
                    </span>
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    {season.plan.premise}
                  </p>

                  {/* EVERY ONE OF THESE IS FREE AND FOUND BEFORE ANY EPISODE WAS
                      WRITTEN. An unpaid promise is invisible to every other check
                      in the studio: each episode passes, and the season still owes
                      the listener an answer it never gives. */}
                  {season.problems && season.problems.length > 0 && (
                    <div className="stack tight">
                      <div className="eyebrow">Problems with this plan</div>
                      {season.problems.map((p) => (
                        <p
                          key={p}
                          className="tiny"
                          style={{ margin: 0, color: "var(--amber)" }}
                        >
                          {p}
                        </p>
                      ))}
                    </div>
                  )}

                  {season.drift && season.drift.length > 0 && (
                    <div className="stack tight">
                      <div className="eyebrow">Drifted from the plan</div>
                      {season.drift.map((d) => (
                        <p key={d} className="tiny muted" style={{ margin: 0 }}>
                          {d}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="stack tight">
                    {season.plan.episodes.map((ep) => {
                      const next = ep.number === season.nextEpisode;
                      return (
                        <div
                          key={ep.number}
                          className="card"
                          style={
                            next ? { borderColor: "var(--amber)" } : undefined
                          }
                        >
                          <div
                            className="row between"
                            style={{ gap: "0.8rem" }}
                          >
                            <strong>
                              {ep.number}. {ep.title}
                            </strong>
                            {next && (
                              <span className="pill hold">writes next</span>
                            )}
                          </div>
                          <p
                            className="muted tiny"
                            style={{ margin: "0.35rem 0 0" }}
                          >
                            {ep.story}
                          </p>
                          {ep.cliffhanger ? (
                            <p
                              className="tiny"
                              style={{ margin: "0.35rem 0 0" }}
                            >
                              <span className="faint">ends on </span>
                              {ep.cliffhanger}
                            </p>
                          ) : (
                            <p
                              className="tiny faint"
                              style={{ margin: "0.35rem 0 0" }}
                            >
                              the finale, which lands rather than opens
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <p className="faint tiny" style={{ margin: 0 }}>
                    Edit{" "}
                    <code>
                      seasons/{channel.id}-s{season.plan.seasonNumber}.json
                    </code>{" "}
                    by hand to change any of this. That is expected, not a
                    workaround.
                  </p>
                </>
              )}
            </div>
          </section>
        )}

        {/* --- What this channel has already covered -------------------- */}
        {!channel.fiction && covered && covered.entries.length > 0 && (
          <section className="panel">
            <div className="panel-head">
              <h2>Already covered</h2>
              <span className="spacer" />
              <span className="right-edge">
                <Info label="What this stops">
                  Starting a run on a subject this channel has already made is
                  refused before anything is spent, and the earlier run is
                  named. Matching is on the identifying words rather than the
                  exact string, because a duplicate is nearly always the same
                  subject typed at a different length. Pass --again if it really
                  is different.
                </Info>
              </span>
            </div>

            <div className="panel-body stack tight">
              {covered.entries.slice(0, 12).map((e) => (
                <div
                  key={e.runId}
                  className="row between"
                  style={{ gap: "1rem" }}
                >
                  <span style={{ minWidth: 0 }}>{e.topic}</span>
                  <span className="faint tiny" style={{ whiteSpace: "nowrap" }}>
                    {e.madeAt.slice(0, 10)}
                  </span>
                </div>
              ))}
              {covered.entries.length > 12 && (
                <p className="faint tiny" style={{ margin: 0 }}>
                  and {covered.entries.length - 12} more
                </p>
              )}
            </div>
          </section>
        )}

        {/* --- Make something ------------------------------------------- */}
        <section className="panel">
          <div className="panel-head">
            <h2>Make</h2>
            <span className="spacer" />
            <span className="right-edge">
              <Info label="Why the route matters">
                An episode makes one thing to publish. A set makes a script that
                is never published and is cut into ten shorts that are. They
                cost differently, they are approved differently, and they want
                different subjects: an episode wants one specific question, a
                set wants a body of material with ten genuinely different
                stories in it. Nothing writes to the topic queue by itself,
                because a studio that picks its own subjects converges on
                whatever the model finds most available.
              </Info>
            </span>
          </div>

          <div className="panel-body stack">
            <div className="row" style={{ gap: "0.45rem" }}>
              {channel.routes.map((r) => (
                <button
                  key={r.formatId}
                  className={`chip${route?.formatId === r.formatId ? " on" : ""}`}
                  onClick={() => setRoute(r)}
                  // The full description on hover: two formats of the same kind
                  // differ in what they are for, not in their length.
                  title={r.intent}
                >
                  {r.kind === "shorts"
                    ? `${r.produces} shorts`
                    : r.long
                      ? "Episode"
                      : "Short"}
                  {/* The format's own name, so two Episodes or two Shorts on
                      one channel can be told apart. */}
                  <span className="muted tiny">{r.formatName}</span>
                  <span className="faint tiny">
                    {r.seconds[0] < 60
                      ? `${r.seconds[0]}-${r.seconds[1]}s`
                      : r.seconds[1] < 300
                        ? // Half-minutes for shorts, or 150-185s reads as "3-3m".
                          `${Math.round(r.seconds[0] / 30) / 2}-${Math.round(r.seconds[1] / 30) / 2}m`
                        : `${Math.round(r.seconds[0] / 60)}-${Math.round(r.seconds[1] / 60)}m`}
                  </span>
                </button>
              ))}
            </div>

            {route && (
              <>
                <textarea
                  className="field"
                  rows={2}
                  placeholder={
                    route.kind === "shorts"
                      ? "A body of material with ten different stories in it..."
                      : "A subject, not a title. The research is planned from these words."
                  }
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                />

                {/* THE SERIES, long form only: the episode opens by naming it
                    and publishes onto its shelf, which is created the first
                    time a title is used. Pick an existing one or type a new
                    one; leave it empty for a loose episode. */}
                {route.long && (
                  <div className="stack tight">
                    <input
                      className="field"
                      list={`series-${channel.id}`}
                      placeholder="Series (optional), e.g. Founder Stories"
                      value={seriesTitle}
                      onChange={(e) => setSeriesTitle(e.target.value)}
                    />
                    <datalist id={`series-${channel.id}`}>
                      {channel.seriesTitles.map((t) => (
                        <option key={t} value={t} />
                      ))}
                    </datalist>
                    <span className="faint tiny">
                      {seriesTitle.trim()
                        ? channel.seriesTitles.includes(seriesTitle.trim())
                          ? `Joins "${seriesTitle.trim()}".`
                          : `Starts a new series, "${seriesTitle.trim()}". Its cover can be set on the episode's page before publishing.`
                        : "No series: publishes as a loose episode."}
                    </span>
                  </div>
                )}

                {clash.length > 0 && (
                  <div className="stack tight">
                    {clash.map((m) => (
                      <p
                        key={m.entry.runId}
                        className="tiny"
                        style={{
                          margin: 0,
                          color:
                            m.sameShow && m.score >= 0.6
                              ? "var(--amber)"
                              : undefined,
                        }}
                      >
                        {m.sameShow && m.score >= 0.6
                          ? "This will be refused: "
                          : m.sameShow
                            ? "Close to something this channel made: "
                            : `${m.entry.showId} has covered something close: `}
                        <span className="muted">{m.entry.topic}</span>
                        <span className="faint">
                          {" "}
                          ({m.entry.madeAt.slice(0, 10)})
                        </span>
                      </p>
                    ))}
                  </div>
                )}

                <div className="row">
                  <button
                    className="btn spend"
                    disabled={!topic.trim() || starting || refused}
                    onClick={() => void start(false)}
                  >
                    {starting ? "Starting..." : "Research and write"}
                  </button>
                  {/* THE OVERRIDE IS A SEPARATE BUTTON, not a checkbox beside
                      the first. A checkbox can be left ticked from the last
                      time; a button that only exists while a duplicate is on
                      screen cannot be pressed by accident a week later. */}
                  {refused && (
                    <button
                      className="btn ghost"
                      disabled={starting}
                      onClick={() => void start(true)}
                    >
                      {starting ? "Starting..." : "Make it anyway"}
                    </button>
                  )}
                  {route.kind !== "shorts" && (
                    <button
                      className="btn ghost"
                      title="A blank template with one box per part. You write it; only the voice costs anything."
                      disabled={!topic.trim() || starting || refused}
                      onClick={() => void start(false, true)}
                    >
                      Blank script
                    </button>
                  )}
                  <button
                    className="btn ghost"
                    onClick={suggest}
                    disabled={suggesting}
                  >
                    {suggesting ? "Thinking..." : "Suggest"}
                  </button>
                  <span className="spacer" />
                  <span className="faint tiny">
                    {route.kind === "shorts"
                      ? "Never voiced whole"
                      : "Stops before the audio"}
                  </span>
                </div>

                {ideas.length > 0 && (
                  <div className="stack" style={{ gap: "0.35rem" }}>
                    {ideas.map((idea) => (
                      <button
                        key={idea.topic}
                        className="idea"
                        onClick={() => {
                          setTopic(idea.topic);
                          setIdeas([]);
                        }}
                      >
                        <span>{idea.topic}</span>
                        <Info>{idea.why}</Info>
                      </button>
                    ))}
                  </div>
                )}

                {queue.length > 0 && (
                  <div className="row" style={{ gap: "0.35rem" }}>
                    {queue.slice(0, 6).map((t) => (
                      <button
                        key={t}
                        className="btn ghost small"
                        onClick={() => setTopic(t)}
                        title={t}
                      >
                        {t.split(/[-–—]/)[0]!.trim().slice(0, 40)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* --- What it has made ----------------------------------------- */}
        <section className="panel">
          <div className="panel-head">
            <h2>Runs</h2>
            <span className="pill">{runs.length}</span>
            <span className="spacer" />
            {runs.some((r) => r.state === "ready") && (
              <button
                className="btn ghost small"
                onClick={() => go(`/c/${channel.id}/publish`)}
              >
                Publishing
              </button>
            )}
          </div>

          {runs.length === 0 ? (
            <p className="panel-body faint">Never run.</p>
          ) : (
            <div className="queue-list">
              {runs.map((r) => (
                <button
                  key={r.id}
                  className="queue-row"
                  onClick={() => go(`/r/${r.id}`)}
                >
                  {r.hasAudio ? (
                    <PlayButton
                      id={r.id}
                      src={api.audioUrl(r.id, r.audioKey)}
                    />
                  ) : null}
                  <span className="queue-main">
                    <span className="queue-title">{r.title ?? r.topic}</span>
                    <span className="muted">
                      e{String(r.episode).padStart(3, "0")}
                      {r.short
                        ? `-s${String(r.short).padStart(2, "0")}`
                        : ""} · {ago(r.createdAt)}
                    </span>
                  </span>
                  <span className="row nowrap">
                    <span className="muted mono tiny">
                      {clock(r.durationS)}
                    </span>
                    <span className="muted mono tiny">
                      {money(r.spentPence)}
                    </span>
                    <StatePill state={r.state} stage={r.liveStage} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
