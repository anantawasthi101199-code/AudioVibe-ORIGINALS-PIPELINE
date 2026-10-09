/**
 * Topic suggestions kept for next time, and topics a person does not want
 * (owner, 2026-10-09).
 *
 * Pressing Suggest costs money and returned a list that vanished on the next
 * click, format switch or reload, so the same question was paid for again and
 * again. Now every suggestion is kept per channel and format until somebody
 * uses it or removes it, and a removed topic (a suggestion, or a pill from the
 * channel's topic queue) stays removed: it is not shown again and Suggest is
 * told not to offer it back.
 *
 * ON THE VOLUME, beside the runs, and shared by everybody using the studio. The
 * topic queues themselves (topics/*.yaml) are written by hand and ship with the
 * code, so they are never edited from here; hiding one is recorded here.
 */
import fs from 'fs';
import path from 'path';
import { runsDir } from '../config';

export interface SavedSuggestion {
  topic: string;
  why: string;
  at: string;
  by: string | null;
}

interface ChannelPicks {
  /** Suggestions kept, by format id, newest first. */
  saved: Record<string, SavedSuggestion[]>;
  /** Topics somebody removed: never shown or suggested again. */
  hidden: string[];
}

type Store = Record<string, ChannelPicks>;

const file = (): string => path.join(runsDir(), 'topic-picks.json');
const key = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

const read = (): Store => {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as Store;
  } catch {
    return {};
  }
};

const write = (store: Store): void => {
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.writeFileSync(file(), `${JSON.stringify(store, null, 2)}\n`, 'utf8');
};

const channelOf = (store: Store, channelId: string): ChannelPicks =>
  (store[channelId] ??= { saved: {}, hidden: [] });

export const picksFor = (channelId: string): ChannelPicks => {
  const c = read()[channelId];
  return { saved: c?.saved ?? {}, hidden: c?.hidden ?? [] };
};

/** Is this topic one somebody removed? */
export const isHidden = (channelId: string, topic: string): boolean =>
  picksFor(channelId).hidden.some((h) => key(h) === key(topic));

/** Keep new suggestions, newest first, never a duplicate or a removed one. */
export const keepSuggestions = (
  channelId: string,
  formatId: string,
  suggestions: Array<{ topic: string; why: string }>,
  by: string | null,
  now = new Date()
): SavedSuggestion[] => {
  const store = read();
  const c = channelOf(store, channelId);
  const list = c.saved[formatId] ?? [];
  const known = new Set([...list.map((s) => key(s.topic)), ...c.hidden.map(key)]);
  const fresh = suggestions
    .filter((s) => !known.has(key(s.topic)) && known.add(key(s.topic)))
    .map((s) => ({ topic: s.topic.trim(), why: s.why.trim(), at: now.toISOString(), by }));
  c.saved[formatId] = [...fresh, ...list];
  write(store);
  return c.saved[formatId]!;
};

/** Remove a topic for good: from every saved list, and hidden from the queue too. */
export const removeTopic = (channelId: string, topic: string): ChannelPicks => {
  const store = read();
  const c = channelOf(store, channelId);
  for (const f of Object.keys(c.saved)) c.saved[f] = c.saved[f]!.filter((s) => key(s.topic) !== key(topic));
  if (!c.hidden.some((h) => key(h) === key(topic))) c.hidden.push(topic.trim());
  write(store);
  return c;
};

/** A run was started on this topic: it is no longer waiting to be picked. */
export const topicUsed = (channelId: string, topic: string): void => {
  const store = read();
  const c = store[channelId];
  if (!c) return;
  let changed = false;
  for (const f of Object.keys(c.saved)) {
    const before = c.saved[f]!.length;
    c.saved[f] = c.saved[f]!.filter((s) => key(s.topic) !== key(topic));
    changed ||= c.saved[f]!.length !== before;
  }
  if (changed) write(store);
};
