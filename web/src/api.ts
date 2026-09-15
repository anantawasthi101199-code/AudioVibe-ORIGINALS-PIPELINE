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
  queued: { topics: number; sets: number };
  runs: { total: number; awaitingApproval: number; lastAt: string | null };
  account: {
    exists: boolean;
    handle: string | null;
    canPublish: boolean;
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

export interface Job {
  id: string;
  kind: 'run' | 'shorts';
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

export const api = {
  me: () => call<{ signedIn: boolean }>('/api/me'),
  signIn: (password: string) =>
    call<{ ok: true }>('/api/session', { method: 'POST', body: JSON.stringify({ password }) }),
  signOut: () => call<{ ok: true }>('/api/session', { method: 'DELETE' }),

  catalogue: () => call<{ lanes: Lane[] }>('/api/catalogue'),

  queue: () => call<QueueView>('/api/queue'),

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

  start: (body: { channelId: string; formatId: string; topic: string; renderNow?: boolean }) =>
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
