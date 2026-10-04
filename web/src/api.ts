/**
 * Talking to the studio server.
 *
 * ONE PLACE THAT KNOWS THE WIRE. Every fetch in the app goes through here, so
 * there is exactly one thing to change when a route moves and exactly one place
 * that decides what a 401 means - which matters, because a session expiring
 * mid-session should put you back at the password box rather than show you four
 * components each rendering their own idea of an error.
 *
 * THE TYPES ARE WRITTEN OUT RATHER THAN IMPORTED from the server, and that is
 * deliberate at this size: the alternative is a shared package or a path alias
 * reaching up out of web/ into src/, and both make the interface a build-time
 * dependency of the pipeline. What crosses the wire is JSON; this is what the
 * app expects that JSON to look like.
 */

export interface Route {
  kind: 'episode' | 'shorts';
  /** Long form: can be filed into a named series. */
  long: boolean;
  formatId: string;
  formatName: string;
  intent: string;
  seconds: [number, number];
  produces: number;
  minClaims: number;
  beats: number;
}

export interface Channel {
  id: string;
  name: string;
  handle: string;
  category: string;
  thesis: string;
  fiction: boolean;
  voice: { provider: string; voiceId: string; since: string } | null;
  routes: Route[];
  /** Named series this channel already has, to pick from. */
  seriesTitles: string[];
  queued: { topics: number; sets: number };
  runs: { total: number; awaitingApproval: number; lastAt: string | null };
  account: {
    exists: boolean;
    handle: string | null;
    canPublish: boolean;
    needsSeries: boolean;
    hasSeries: boolean;
  };
}

export interface Lane {
  id: 'factual' | 'fiction';
  name: string;
  basis: string;
  channels: Channel[];
}

export type RunState =
  | 'running'
  | 'awaiting-approval'
  | 'ready'
  | 'failed'
  | 'published'
  | 'abandoned';

export interface RunSummary {
  /** While working: the stage the pipeline last reported. */
  liveStage: string | null;
  id: string;
  channelId: string;
  channelName: string;
  formatId: string;
  topic: string;
  title: string | null;
  createdAt: string;
  spentPence: number;
  completed: string[];
  state: RunState;
  episode: number;
  short: number | null;
  story: number | null;
  derivedFrom: string | null;
  durationS: number | null;
  gate: { passed: boolean; blocking: number; needsHumanReview: boolean } | null;
  releaseAt: string | null;
  releaseApprovedAt: string | null;
  heldAt: string | null;
  isSource: boolean;
  hasAudio: boolean;
}

export interface QueueItem {
  channelId: string;
  channelName: string;
  kind: 'episode' | 'short';
  reason: string;
  overdueDays?: number;
  at?: string;
  parentRunId?: string;
}

export interface QueueBlocker {
  channelId: string;
  channelName: string;
  reason: string;
}

export interface QueueView {
  paused: boolean;
  timezone: string;
  due: QueueItem[];
  waiting: QueueItem[];
  blocked: QueueBlocker[];
  held: RunSummary[];
  ready: RunSummary[];
  scheduled: Array<RunSummary & { releaseAt: string }>;
  failed: RunSummary[];
  failedTotal: number;
  published: RunSummary[];
  publishedTotal: number;
  slots: Array<{ channelId: string; channelName: string; slot: string | null }>;
}

export interface Turn {
  speaker: string;
  text: string;
}

export interface Beat {
  beatId: string;
  beatType: string;
  turns: Turn[];
  claimIds: string[];
  revisions: number;
}

export interface Script {
  personaId: string;
  formatId: string;
  title: string;
  description: string;
  beats: Beat[];
  writerModel: string;
  plan?: { spine: string; cast: Array<{ name: string; who: string; introducedIn: string }> };
}

export interface Finding {
  check: string;
  detail: string;
  blocking: boolean;
}

export interface Gate {
  passed: boolean;
  findings: Finding[];
  needsHumanReview: boolean;
  humanReviewReasons: string[];
  measurement?: {
    words: number;
    sentences: number;
    sentenceWordsMean: number;
    sentenceWordsStdDev: number;
    hedgesPer100Words: number;
  };
}

export interface JobEvent {
  at: string;
  stage: string;
  message: string;
  spentPence: number;
}

export interface CalendarEntry {
  runId: string;
  channelId: string;
  channelName: string;
  title: string;
  kind: 'episode' | 'short';
  state: 'published' | 'approved';
  at: string;
  durationS: number | null;
  short: number | null;
}

export interface QueuedItem extends CalendarEntry {
  position: number;
}

export interface CalendarView {
  month: string;
  timezone: string;
  days: Array<{ date: string; entries: CalendarEntry[] }>;
  queue: QueuedItem[];
  channels: Array<{ id: string; name: string; slot: string | null }>;
  releasing: boolean;
}

export interface Platform {
  url: string | null;
  isProduction: boolean;
  configured: boolean;
}

export type ArtKind = 'avatar' | 'cover' | 'series';

export interface Track {
  name: string;
  bytes: number;
}

export interface Mix {
  track: string;
  volume: number;
  duck: boolean;
  mixedAt: string;
  file: string;
}

export interface MixState {
  /** The last mix made, to listen to. Never published by itself. */
  preview: Mix | null;
  /** What publishing sends. Null means the voice alone. */
  chosen: Mix | null;
  previewStale: boolean;
  chosenStale: boolean;
}

/** A picture's provenance, and the shape a replacement has to be. */
export interface ArtState {
  /** True when this is one somebody chose, rather than one the studio made. */
  supplied: boolean;
  width: number;
  height: number;
}

export interface Job {
  id: string;
  kind: 'run' | 'shorts' | 'channel' | 'series' | 'publish';
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  events: JobEvent[];
  error: string | null;
  produced: string[];
}

export interface Claim {
  id: string;
  beatId: string;
  text: string;
  type: string;
  sourceId: string;
  quote: string;
  contested: boolean;
  status?: string;
  hedge?: string;
}

export interface Source {
  id: string;
  url: string;
  title?: string;
  tier?: string;
}

export interface RunDetail {
  run: RunSummary;
  manifest: Record<string, unknown> & {
    holdForApproval: boolean;
    approvedAt?: string;
    spentPence: number;
    topic: string;
    /** The named series a long episode is filed into. */
    seriesTitle?: string;
  };
  script: Script | null;
  gate: Gate | null;
  brief: { angle?: string; mustEstablish?: string[]; queries?: string[] } | null;
  claims: { claims: Claim[] } | null;
  corpus: { sources: Source[]; rejected: unknown[] } | null;
  render: { durationS?: number } | null;
  cuts: RunSummary[];
  /** A source script, which is cut into shorts and never voiced whole. */
  isSource: boolean;
  job: Job | null;
  hasAudio: boolean;
  /** Publishes as an episode of a series, rather than a loose audiocard. */
  inSeries: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Set by the app so a 401 anywhere can bounce back to the password box. */
let onSignedOut: (() => void) | null = null;
export const whenSignedOut = (fn: () => void): void => {
  onSignedOut = fn;
};

const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });

  if (res.status === 401) {
    onSignedOut?.();
    throw new ApiError(401, 'sign in');
  }

  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    throw new ApiError(res.status, (body as { error?: string })?.error ?? `HTTP ${res.status}`);
  }
  return body as T;
};

export interface SynthControl {
  id: string;
  label: string;
  group: string;
  kind: 'toggles' | 'choice' | 'slider';
  help: string;
  options?: Array<{ value: string; label: string; help?: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

/** Every knob, as the engine defines it. The page never keeps its own copy. */
export type SynthSettings = Record<string, string | number | string[]>;

export interface Beat {
  name: string;
  note: string;
  madeAt: string;
  settings: SynthSettings;
  summary: string;
  rendered: boolean;
}

export interface EpisodeCard {
  number: number;
  title: string;
  opens: string;
  story: string;
  changes: string;
  cliffhanger: string;
  plants: string[];
  paysOff: string[];
}

export interface SeasonPlan {
  personaId: string;
  seasonNumber: number;
  title: string;
  premise: string;
  spine: string;
  world: string[];
  carryCast: Array<{ name: string; who: string }>;
  promises: Array<{ id: string; text: string }>;
  episodes: EpisodeCard[];
}

export interface SeasonView {
  show: string;
  season: number;
  plan: SeasonPlan | null;
  rendered?: string;
  problems?: string[];
  drift?: string[];
  nextEpisode?: number;
}

export interface CoveredEntry {
  showId: string;
  topic: string;
  runId: string;
  madeAt: string;
}

export interface CoveredView {
  entries: CoveredEntry[];
  matches: Array<{ entry: CoveredEntry; score: number; sameShow: boolean }>;
}

export const api = {
  me: () => call<{ signedIn: boolean; name?: string }>('/api/me'),
  signIn: (password: string) =>
    call<{ ok: true; name: string }>('/api/session', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  signOut: () => call<{ ok: true }>('/api/session', { method: 'DELETE' }),

  catalogue: () => call<{ lanes: Lane[] }>('/api/catalogue'),

  /* --- The library: beats, season plans, and what has been covered ------- */

  beats: () =>
    call<{ controls: SynthControl[]; defaults: SynthSettings; beats: Beat[] }>('/api/beats'),

  makeBeat: (body: { name: string; note: string; settings: SynthSettings }) =>
    call<{ beat: Beat }>('/api/beats', { method: 'POST', body: JSON.stringify(body) }),

  /**
   * Settings for a description. Fills the form in and stops, so whoever asked
   * can see what was chosen and change it before anything is synthesised.
   */
  suggestBeat: (describe: string) =>
    call<{ settings: SynthSettings; reading: string; summary: string; pence: number }>(
      '/api/beats/suggest',
      { method: 'POST', body: JSON.stringify({ describe }) }
    ),

  /**
   * Not a fetch. It is the src of an audio element, and the point of the whole
   * beat library is that somebody hears one before choosing it.
   */
  beatAudio: (name: string) => `/api/beats/audio?name=${encodeURIComponent(name)}`,

  season: (channel: string, season = 1) =>
    call<SeasonView>(`/api/season?id=${encodeURIComponent(channel)}&season=${season}`),

  covered: (channel?: string, topic?: string) =>
    call<CoveredView>(
      `/api/covered${channel ? `?channel=${encodeURIComponent(channel)}` : ''}` +
        `${channel && topic ? `&topic=${encodeURIComponent(topic)}` : ''}`
    ),

  queue: () => call<QueueView>('/api/queue'),

  platform: () => call<Platform>('/api/platform'),

  freshness: () =>
    call<{
      startedAt: string;
      stale: boolean;
      newestFile: string | null;
      changedAt: string | null;
    }>('/api/freshness'),

  calendar: (month?: string) =>
    call<CalendarView>(`/api/calendar${month ? `?month=${encodeURIComponent(month)}` : ''}`),

  releaseStatus: () =>
    call<{
      enabled: boolean;
      due: Array<{ runId: string; channelName: string; title: string; releaseAt: string }>;
      held: Array<{ runId: string; reason: string }>;
    }>('/api/release'),

  releaseNow: () =>
    call<{
      released: Array<{ runId: string; audioId: string; url: string }>;
      failed: Array<{ runId: string; reason: string }>;
      remaining: number;
    }>('/api/release/now', { method: 'POST' }),

  /* --- The things that reach the platform ------------------------------- */

  publish: (id: string, confirmed: boolean) =>
    call<{ jobId: string }>(`/api/run/publish?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ confirmed }),
    }),

  setUpChannel: (id: string, adminEmail?: string, adminPassword?: string, redraw = false) =>
    call<{ jobId: string }>(`/api/channel/setup?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ adminEmail, adminPassword, redraw }),
    }),

  recordToken: (id: string, token: string) =>
    call<{ ok: true; handle: string; file: string }>(
      `/api/channel/token?id=${encodeURIComponent(id)}`,
      { method: 'POST', body: JSON.stringify({ token }) }
    ),

  // --- Artwork somebody chose ---------------------------------------------
  //
  // RAW BYTES, NOT FormData. The studio server has no multipart parser, and a
  // File is already a Blob the body of a fetch will take as it is. The
  // content-type has to be set explicitly because `call` otherwise stamps
  // every request that has a body as JSON.
  channelArtState: (id: string) =>
    call<Record<ArtKind, ArtState>>(`/api/channel/art/state?id=${encodeURIComponent(id)}`),

  uploadChannelArt: (id: string, kind: ArtKind, image: Blob) =>
    call<{ ok: true; width: number; height: number }>(
      `/api/channel/art?id=${encodeURIComponent(id)}&kind=${kind}`,
      { method: 'POST', body: image, headers: { 'content-type': image.type || 'image/png' } }
    ),

  removeChannelArt: (id: string, kind: ArtKind) =>
    call<{ ok: true; removed: boolean }>(
      `/api/channel/art?id=${encodeURIComponent(id)}&kind=${kind}`,
      { method: 'DELETE' }
    ),

  runArtState: (id: string) => call<ArtState>(`/api/run/art/state?id=${encodeURIComponent(id)}`),

  uploadRunArt: (id: string, image: Blob) =>
    call<{ ok: true; width: number; height: number }>(
      `/api/run/art?id=${encodeURIComponent(id)}`,
      { method: 'POST', body: image, headers: { 'content-type': image.type || 'image/png' } }
    ),

  runSeriesArtState: (id: string) =>
    call<ArtState & { title: string; created: boolean }>(
      `/api/run/series-art/state?id=${encodeURIComponent(id)}`
    ),
  uploadRunSeriesArt: (id: string, image: Blob) =>
    call<{ ok: true; width: number; height: number }>(
      `/api/run/series-art?id=${encodeURIComponent(id)}`,
      { method: 'POST', body: image, headers: { 'content-type': image.type || 'image/png' } }
    ),
  removeRunSeriesArt: (id: string) =>
    call<{ ok: true; removed: boolean }>(`/api/run/series-art?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  removeRunArt: (id: string) =>
    call<{ ok: true; removed: boolean }>(`/api/run/art?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  createSeries: (id: string) =>
    call<{ jobId: string }>(`/api/channel/series?id=${encodeURIComponent(id)}`, { method: 'POST' }),

  recheck: (channelId: string) =>
    call<{ rechecked: true; changed: Array<{ runId: string; from: boolean; to: boolean }> }>(
      `/api/channel/recheck?id=${encodeURIComponent(channelId)}`,
      { method: 'POST' }
    ),

  // NOT `approve`: that already means releasing a held run so it can be
  // rendered. This one approves finished episodes to go out.
  approveForRelease: (channelId: string, runIds: string[]) =>
    call<{
      approved: Array<{ runId: string; releaseAt: string; kind: 'episode' | 'short' }>;
      unscheduled: string[];
      perWeek: { episodes: number; shorts: number };
      timezone: string;
    }>(`/api/channel/approve?id=${encodeURIComponent(channelId)}`, {
      method: 'POST',
      body: JSON.stringify({ runIds }),
    }),

  verifyPublished: (runId: string) =>
    call<{
      published: boolean;
      checked?: boolean;
      live?: boolean;
      audioId?: string;
      publishedAt?: string | null;
      title?: string | null;
      isAi?: boolean;
      status?: string | null;
      reason?: string;
    }>(`/api/run/verify?id=${encodeURIComponent(runId)}`),

  cancelRelease: (runId: string) =>
    call<{ ok: true }>(`/api/run/cancel?id=${encodeURIComponent(runId)}`, { method: 'POST' }),

  setHold: (runId: string, held: boolean) =>
    call<{ ok: true; held: boolean }>(`/api/run/hold?id=${encodeURIComponent(runId)}`, {
      method: 'POST',
      body: JSON.stringify({ held }),
    }),

  discard: (id: string) =>
    call<{ ok: true }>(`/api/run?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),

  channel: (id: string) =>
    call<{
      channel: Channel;
      topics: string[];
      sets: string[];
      runs: RunSummary[];
      budgetPence: number;
    }>(`/api/channel?id=${encodeURIComponent(id)}`),

  runs: (channelId?: string) =>
    call<{ runs: RunSummary[] }>(
      `/api/runs${channelId ? `?channel=${encodeURIComponent(channelId)}` : ''}`
    ),

  run: (id: string) => call<RunDetail>(`/api/run?id=${encodeURIComponent(id)}`),

  start: (body: {
    channelId: string;
    formatId: string;
    topic: string;
    renderNow?: boolean;
    /** Make it even though this channel has covered the subject. */
    again?: boolean;
    /** The named series a long episode is filed into. */
    seriesTitle?: string;
  }) =>
    call<{ runId: string; jobId: string }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  approve: (id: string) =>
    call<{ runId: string; jobId: string }>(`/api/run/approve?id=${encodeURIComponent(id)}`, {
      method: 'POST',
    }),

  cut: (id: string, only: number[] = []) =>
    call<{ runId: string; jobId: string }>(`/api/run/shorts?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ only }),
    }),

  saveScript: (id: string, script: Pick<Script, 'title' | 'description' | 'beats'>) =>
    call<{ run: RunSummary; gate: Gate | null; audioStale: boolean }>(
      `/api/run/script?id=${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify(script) }
    ),

  suggest: (channelId: string, formatId: string, count = 6) =>
    call<{ suggestions: Array<{ topic: string; why: string }> }>(
      `/api/channel/suggest?id=${encodeURIComponent(channelId)}`,
      { method: 'POST', body: JSON.stringify({ formatId, count }) }
    ),

  audioUrl: (id: string) => `/api/run/audio?id=${encodeURIComponent(id)}`,

  // --- Your own background music ------------------------------------------
  musicLibrary: () => call<{ tracks: Track[] }>('/api/music'),
  uploadTrack: (name: string, file: Blob) =>
    call<{ ok: true; track: Track }>(`/api/music?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'audio/mpeg' },
    }),
  removeTrack: (name: string) =>
    call<{ ok: true; removed: boolean }>(`/api/music?name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  trackUrl: (name: string) => `/api/music/file?name=${encodeURIComponent(name)}`,
  mixState: (id: string) => call<MixState>(`/api/run/mix?id=${encodeURIComponent(id)}`),
  mix: (id: string, body: { track: string; volume: number; duck: boolean }) =>
    call<MixState>(`/api/run/mix?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeMix: (id: string) =>
    call<MixState>(`/api/run/mix?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  useMix: (id: string) =>
    call<MixState>(`/api/run/mix/use?id=${encodeURIComponent(id)}`, { method: 'POST' }),
  voiceOnly: (id: string) =>
    call<MixState>(`/api/run/mix/use?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  mixUrl: (id: string, which: 'preview' | 'chosen', file: string) =>
    `/api/run/mix/audio?id=${encodeURIComponent(id)}&which=${which}&f=${encodeURIComponent(file)}`,
};

/**
 * Watch a job.
 *
 * The server replays everything the page missed before going live, so a view
 * opened halfway through a run fills in immediately rather than waiting for the
 * next thing to happen.
 */
export const watchJob = (
  jobId: string,
  handlers: { onEvent: (e: JobEvent) => void; onDone: (r: { error: string | null; produced: string[] }) => void }
): (() => void) => {
  const source = new EventSource(`/api/job/events?id=${encodeURIComponent(jobId)}`);

  source.addEventListener('progress', (e) => handlers.onEvent(JSON.parse((e as MessageEvent).data)));
  source.addEventListener('done', (e) => {
    handlers.onDone(JSON.parse((e as MessageEvent).data));
    source.close();
  });

  return () => source.close();
};

/* --- Formatting, shared because these appear on every page ---------------- */

export const money = (p: number): string =>
  p >= 100 ? `£${(p / 100).toFixed(2)}` : `${Math.round(p)}p`;

export const clock = (seconds: number | null): string => {
  if (seconds === null) return '-';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const ago = (iso: string): string => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

/**
 * A date and time, in the schedule's own zone.
 *
 * The zone comes from the server rather than the browser, because a slot is a
 * promise to listeners in one place and reading it in whatever zone the laptop
 * happens to be in would quietly show the wrong hour.
 */
export const when = (iso: string, timeZone: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** "in 3 days", "in 4 hours", for something that has not happened yet. */
export const until = (iso: string): string => {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
};
