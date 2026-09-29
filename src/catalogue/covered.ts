/**
 * What the studio has already made, so it does not make it twice.
 *
 * THE FAILURE THIS EXISTS FOR. A topic queue is consumed, a run is made, and
 * nothing anywhere remembers the subject afterwards. Put "The Descent of
 * Inanna" back on the queue, or type it again with two words different, and the
 * studio researches it, writes it, voices it and bills for it a second time
 * without one thing in the pipeline noticing. `runs/` is not the answer either:
 * it is gitignored, so on any other machine the record does not exist at all.
 *
 * So this is a small COMMITTED ledger, on the same argument bibles/ is
 * committed. A run is reproducible from its inputs; the knowledge that a
 * subject has been done is not, and losing it costs real money rather than
 * effort.
 *
 * FREE, AND IT RUNS BEFORE THE FIRST PAID STAGE. Everything here is arithmetic
 * over a few hundred short strings. That is the whole design: the check has to
 * be cheap enough that there is no argument for skipping it, and early enough
 * that a duplicate costs nothing rather than the price of an episode.
 *
 * WHAT IT DELIBERATELY IS NOT. A model. Asking a model "have we covered this"
 * would be more accurate at the margins and would cost a call on every single
 * run, to answer a question that is usually obvious. The heuristic below is
 * blunt, it is explained in the message when it fires, and `--again` overrides
 * it in one word.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { repoRoot } from '../config';

/**
 * Words that carry no subject.
 *
 * SMALL ON PURPOSE. Every word removed here is a word that can no longer
 * distinguish two topics, so the list holds only words that are genuinely
 * never the subject of anything. "War" and "death" are not in it and must not
 * be: they are ordinary words and they are also what an episode is about.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'from', 'by', 'with', 'about', 'into', 'over', 'after', 'before', 'between',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this',
  'that', 'these', 'those', 'as', 'how', 'why', 'what', 'who', 'when', 'where',
  'his', 'her', 'their', 'our', 'we', 'they',
]);

/**
 * The crudest possible stemmer, and deliberately so.
 *
 * It exists to make "stories" and "story" the same token, nothing more. A real
 * stemmer would be more accurate and would also fold words that genuinely
 * distinguish two episodes, which is the expensive direction to be wrong in.
 *
 * The ss guard is load-bearing: without it "goddess" becomes "goddes" and
 * "goddesses" becomes "goddesse", so the two words this is supposed to unify
 * end up further apart than they started.
 */
const singular = (w: string): string => {
  // Order matters. "goddesses" has to be caught before the bare s rule, which
  // would leave "goddesse", and before the ss guard, which would leave it whole.
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ss')) return w;
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
};

/**
 * A topic reduced to the words that identify it.
 *
 * Lowercased, stripped of punctuation, possessives folded ("Anansi's" and
 * "Anansi" are one word), stopwords dropped, deduplicated. A trailing "s" is
 * removed from anything over four letters, which turns "stories" and "story"
 * into near neighbours without needing a stemmer.
 */
export const subjectKey = (topic: string): string[] => {
  const words = topic
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(singular);

  return [...new Set(words)].sort();
};

/**
 * How much two subjects overlap, from 0 to 1.
 *
 * CONTAINMENT, NOT JACCARD, and the difference matters here. Jaccard divides by
 * the union, so "Inanna" against "The Descent of Inanna to the Underworld"
 * scores low purely because the second is longer, which is the commonest shape
 * a duplicate actually takes: the same subject typed at two different lengths.
 * Dividing by the shorter of the two asks the right question, which is whether
 * the smaller topic is contained in the larger one.
 */
export const overlap = (a: string[], b: string[]): number => {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  const shared = a.filter((w) => set.has(w)).length;
  return shared / Math.min(a.length, b.length);
};

/**
 * Enough overlap to stop a run.
 *
 * 0.6 rather than something higher because the expensive mistake is
 * asymmetric. A false block costs one word, `--again`, and the message says so.
 * A missed duplicate costs a whole episode and is discovered by a listener.
 */
export const BLOCK_AT = 0.6;

/** Enough to mention without stopping anything. */
export const MENTION_AT = 0.34;

export const coveredEntrySchema = z.object({
  showId: z.string().min(1),
  /** The topic as it was typed, so the message can quote it back. */
  topic: z.string().min(1),
  runId: z.string().min(1),
  madeAt: z.string().min(1),
});

export type CoveredEntry = z.infer<typeof coveredEntrySchema>;

export const catalogueSchema = z.object({
  entries: z.array(coveredEntrySchema).default([]),
});

export type Catalogue = z.infer<typeof catalogueSchema>;

const cataloguePath = (dir?: string): string =>
  path.join(dir ?? repoRoot(), 'catalogue.json');

export const loadCatalogue = (dir?: string): Catalogue => {
  const file = cataloguePath(dir);
  if (!fs.existsSync(file)) return { entries: [] };
  return catalogueSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
};

export const saveCatalogue = (catalogue: Catalogue, dir?: string): string => {
  const file = cataloguePath(dir);
  fs.writeFileSync(
    file,
    `${JSON.stringify(catalogueSchema.parse(catalogue), null, 2)}\n`,
    'utf8'
  );
  return file;
};

export interface Match {
  entry: CoveredEntry;
  score: number;
  /** Whether this is the same show. A different show covering it is not a repeat. */
  sameShow: boolean;
}

/**
 * Everything already made that resembles this topic, closest first.
 *
 * ANOTHER SHOW COVERING A SUBJECT IS NOT A DUPLICATE, and that is why the
 * result says which is which rather than filtering. Two shows reaching the same
 * myth from different angles is the catalogue working; the same show reaching
 * it twice is the catalogue repeating itself.
 */
export const findCovered = (
  catalogue: Catalogue,
  showId: string,
  topic: string
): Match[] => {
  const key = subjectKey(topic);

  return catalogue.entries
    .map((entry) => ({
      entry,
      score: overlap(key, subjectKey(entry.topic)),
      sameShow: entry.showId === showId,
    }))
    .filter((m) => m.score >= MENTION_AT)
    .sort((a, b) => b.score - a.score);
};

/** The matches that should stop a run: close enough, and the same show. */
export const blocking = (matches: Match[]): Match[] =>
  matches.filter((m) => m.sameShow && m.score >= BLOCK_AT);

/**
 * Record that a subject has been made.
 *
 * WRITTEN WHEN THE RUN IS CREATED, NOT WHEN IT SUCCEEDS, on the same reasoning
 * takeTopic uses: a subject recorded only on success means a show that keeps
 * failing retries the same subject forever, spending money every time. Recorded
 * up front, a failure costs that subject, which is recoverable with `--again`
 * and is visible in the diff of this file rather than invisible in a loop.
 */
export const recordMade = (
  showId: string,
  topic: string,
  runId: string,
  now: Date = new Date(),
  dir?: string
): void => {
  const catalogue = loadCatalogue(dir);

  // A resumed run must not appear twice. The run id is the identity here, not
  // the topic, because the same subject CAN legitimately appear twice once
  // somebody has passed --again and that second run is a real second thing.
  if (catalogue.entries.some((e) => e.runId === runId)) return;

  catalogue.entries.push({
    showId,
    topic,
    runId,
    madeAt: now.toISOString(),
  });

  saveCatalogue(catalogue, dir);
};

/**
 * The refusal, as a person should read it.
 *
 * It names the earlier run so it can be listened to, gives the date so a very
 * old one can be judged differently from last week's, and says the override in
 * full rather than hinting at one.
 */
export const refusal = (showId: string, topic: string, matches: Match[]): string => {
  const lines = [
    `${showId} has already covered this.`,
    '',
    `  asked for   ${topic}`,
  ];

  for (const m of matches) {
    const when = m.entry.madeAt.slice(0, 10);
    lines.push(`  already     ${m.entry.topic}  (${when})`);
    lines.push(`              ${m.entry.runId}`);
  }

  lines.push(
    '',
    'Nothing has been spent. If this really is a different subject, or you want',
    'to make it again, add --again.'
  );

  return lines.join('\n');
};
