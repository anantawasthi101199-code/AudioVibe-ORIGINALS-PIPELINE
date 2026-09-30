/**
 * A curriculum: what a psychology channel teaches, and where it is allowed to
 * read.
 *
 * A channel is a psychology channel exactly when `curricula/<id>.yaml` exists,
 * the same way a news channel has a desk and a business channel has a casebook.
 * `pipeline/lanes.ts` refuses a channel that qualifies for two lanes, so none
 * of them can ever overlap.
 *
 * WHY THE SOURCE LIST IS NOT OPTIONAL HERE. Psychology is the subject with the
 * widest gap between what the research says and what the internet says about
 * it. A general web search for "why we procrastinate" returns productivity
 * blogs, supplement sellers and life coaches long before it returns anything
 * that has read a study. The preferred list is what makes this an explainer
 * with something behind it rather than a confident voice repeating the same
 * folklore back.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';

export const curriculumSchema = z.object({
  /** Must equal the persona id. */
  id: z.string().regex(/^[a-z0-9-]+$/),

  /** Said in the goodbye: "how your mind works". */
  beat: z.string().min(2),

  /**
   * The searches run for a topic. `{topic}` is replaced by the subject.
   *
   * ONE QUERY PER QUESTION THE EPISODE ASKS, because `gatherCorpus` keeps each
   * query's candidates separate. A single pooled search on a psychology topic
   * returns six documents explaining the mechanism and nothing at all about
   * what helps, since that is how the internet is weighted.
   */
  queries: z.array(z.string().includes('{topic}')).min(2).max(6),

  /** Shorts read one article, so they search less. Same substitution. */
  shortQueries: z.array(z.string().includes('{topic}')).min(1).max(3),

  /**
   * Sources worth reading on this subject, best first. Clinical and academic
   * bodies lead; the good explainer press follows, because it is where the
   * lived experience and the worked examples actually are.
   */
  preferred: z.array(z.object({ host: z.string().min(3), bonus: z.number().min(0).max(3) })),

  /** Never a source: supplement sellers, coaching funnels, forums, video. */
  refused: z.array(z.string().min(3)),

  /** Documents to end up with for an episode. */
  sources: z.number().int().min(3).max(12).default(6),

  /**
   * How much of each document the extractor is shown, chosen for free by BM25
   * against the queries. The single biggest cost lever on an episode.
   */
  extractCharsPerSource: z.number().positive().default(7000),

  /** How much of the one article a short is written from. */
  shortReadChars: z.number().positive().default(24000),

  /** Below this a document cannot carry a short on its own. */
  shortMinChars: z.number().positive().default(3000),
});

export type Curriculum = z.infer<typeof curriculumSchema>;

export const curriculaDir = (): string => path.resolve(__dirname, '..', '..', 'curricula');

const fileFor = (id: string, dir: string) => path.join(dir, `${id}.yaml`);

/** True when this persona is a psychology channel. The one routing decision. */
export const hasCurriculum = (personaId: string, dir = curriculaDir()): boolean =>
  fs.existsSync(fileFor(personaId, dir));

export const parseCurriculum = (source: string, label = '<inline>'): Curriculum => {
  const result = curriculumSchema.safeParse(YAML.parse(source));
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`
    );
    throw new Error(`${label} is not a valid curriculum:\n  - ${problems.join('\n  - ')}`);
  }
  return result.data;
};

export const loadCurriculum = (personaId: string, dir = curriculaDir()): Curriculum => {
  const file = fileFor(personaId, dir);
  if (!fs.existsSync(file)) {
    throw new Error(`no curriculum for "${personaId}" (looked for ${file})`);
  }
  const found = parseCurriculum(fs.readFileSync(file, 'utf8'), file);
  if (found.id !== personaId) {
    throw new Error(`${file} says its id is "${found.id}", but it is the curriculum for "${personaId}"`);
  }
  return found;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const matches = (host: string, want: string) => host === want || host.endsWith(`.${want}`);

/** Why this URL may not be read, or null when it may. */
export const refusedReason = (url: string, book: Curriculum): string | null => {
  const host = hostOf(url);
  if (!host) return 'not a valid address';
  const no = book.refused.find((r) => matches(host, r));
  if (no) return `${no} is on the curriculum's refused list`;
  if (/\.(mp4|mp3|zip)(\?|$)/i.test(url)) return 'not a readable page';
  return null;
};

/** Position on the preferred list, lower is better; unlisted sorts last. */
export const preferenceOf = (url: string, book: Curriculum): number => {
  const host = hostOf(url);
  const at = book.preferred.findIndex((p) => matches(host, p.host));
  return at === -1 ? book.preferred.length : at;
};

export const bonusOf = (url: string, book: Curriculum): number => {
  const host = hostOf(url);
  return book.preferred.find((p) => matches(host, p.host))?.bonus ?? 0;
};
