/**
 * A news desk: what a news channel watches, and which outlets it trusts.
 *
 * WHY A SEPARATE FILE AND NOT MORE PERSONA FIELDS. A persona is how a show
 * SOUNDS - its host, its register, its goodbye - and every lane reads it. A desk
 * is how a news show FINDS THINGS: the searches it runs every morning, the
 * outlets it will build a report on, how old a story may be. Nothing outside the
 * news lane needs any of that, and a persona schema that grew a dozen optional
 * news fields would be carrying them for every myth and crime show too.
 *
 * So a channel is a news channel exactly when `desks/<persona-id>.yaml` exists.
 * That one fact routes `make`, `resume`, `approve` and `gate` to the news lane,
 * and there is no flag to forget.
 *
 * THE OUTLET LIST IS THE "ONE DEPENDABLE SOURCE" RULE. A report is built on one
 * article, and the only articles eligible are from outlets named here. The order
 * matters: it is the preference when several outlets carry the same story, and
 * outlets that reliably serve their text to a fetcher belong near the top.
 * Paywalled outlets can stay on the list - a fetch that returns a paywall stub
 * is rejected and the next outlet carrying the story is tried.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';

export const outletSchema = z.object({
  /** The hostname, without www. Subdomains match too. */
  host: z.string().min(3),
  /** How the reporter says it on air: "the BBC", "the Associated Press". */
  onAir: z.string().min(2),
});

export type Outlet = z.infer<typeof outletSchema>;

export const deskSchema = z.object({
  /** Must equal the persona id this desk belongs to. */
  id: z.string().regex(/^[a-z0-9-]+$/),

  /**
   * The beat, in two or three words, as the goodbye says it: "geopolitics",
   * "world markets". Also the default topic when `make` is given none.
   */
  beat: z.string().min(2),

  /**
   * The searches run when no specific topic is asked for. Each one is a Brave
   * News request, so five is a morning's sweep and fifty is a rate limit.
   */
  queries: z.array(z.string().min(2)).min(1).max(8),

  /** Outlets a report may be built on, most preferred first. */
  outlets: z.array(outletSchema).min(1),

  /**
   * How old a story may be when it is picked. Brave's own window is the last
   * twenty-four hours; this also rejects an old article that was re-indexed
   * today, which happens more than you would think.
   */
  maxAgeHours: z.number().positive().max(72).default(30),

  /**
   * How old the story may be when it is PUBLISHED. Checked again at publish
   * time, by the gate, so a report made on Monday and forgotten until Thursday
   * cannot go out as news.
   */
  publishWithinHours: z.number().positive().max(168).default(48),

  /** Headline words that mean "not this desk's story": sport, celebrity and so on. */
  excludeWords: z.array(z.string().min(2)).default([]),

  /** Brave's country code. `ALL` for a world desk. */
  country: z.string().default('ALL'),

  /** Brave's search_lang. */
  language: z.string().default('en'),

  /**
   * A music bed under the report. Off by default: the bed the renderer
   * synthesises is scored for storytelling, and under a news report it reads as
   * editorialising.
   */
  music: z.boolean().default(false),

  /**
   * THE RAPID-FIRE ROUNDUP, run when no topic is given (owner, 2026-10-05). One
   * search per region, the most-carried story from each, one article each.
   * Absent: this desk has no roundup and an empty topic means the top story.
   */
  roundup: z
    .object({
      regions: z.array(z.object({ name: z.string().min(2), query: z.string().min(2) })).min(2).max(8),
    })
    .optional(),
});

export type Desk = z.infer<typeof deskSchema>;

export const ROUNDUP_FORMAT = 'news-roundup';

/**
 * Which format a news run takes, decided in ONE place for the studio, `make`
 * and the schedule: no topic (the desk's beat) is the rapid-fire roundup when
 * the desk has one; a topic is the in-depth short on that story.
 */
export const newsFormatFor = (desk: Desk, topic: string, fallback: string): string =>
  desk.roundup && topic.trim().toLowerCase() === desk.beat.toLowerCase() ? ROUNDUP_FORMAT : fallback;

export const desksDir = (): string => path.resolve(__dirname, '..', '..', 'desks');

const fileFor = (id: string, dir: string) => path.join(dir, `${id}.yaml`);

/** True when this persona is a news channel. The one routing decision. */
export const hasNewsDesk = (personaId: string, dir = desksDir()): boolean =>
  fs.existsSync(fileFor(personaId, dir));

export const parseDesk = (source: string, label = '<inline>'): Desk => {
  const result = deskSchema.safeParse(YAML.parse(source));
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`
    );
    throw new Error(`${label} is not a valid news desk:\n  - ${problems.join('\n  - ')}`);
  }
  return result.data;
};

export const loadDesk = (personaId: string, dir = desksDir()): Desk => {
  const file = fileFor(personaId, dir);
  if (!fs.existsSync(file)) throw new Error(`no news desk for "${personaId}" (looked for ${file})`);
  const desk = parseDesk(fs.readFileSync(file, 'utf8'), file);
  if (desk.id !== personaId) {
    throw new Error(`${file} says its id is "${desk.id}", but it is the desk for "${personaId}"`);
  }
  return desk;
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** The desk's outlet for a URL, or null when the URL is not from a trusted outlet. */
export const outletFor = (desk: Desk, url: string): Outlet | null => {
  const host = hostOf(url);
  if (!host) return null;
  return desk.outlets.find((o) => host === o.host || host.endsWith(`.${o.host}`)) ?? null;
};

/** Position on the desk's list; lower is preferred. Unlisted is last. */
export const outletRank = (desk: Desk, url: string): number => {
  const outlet = outletFor(desk, url);
  return outlet ? desk.outlets.indexOf(outlet) : desk.outlets.length;
};
