/**
 * A casebook: how a business-story channel finds the ONE source a story is
 * told from.
 *
 * A channel is a business-story channel exactly when `casebooks/<id>.yaml`
 * exists, the same way a news channel is one when it has a desk. The lane
 * router (pipeline/lanes.ts) refuses a channel that has both, so the lanes can
 * never overlap.
 *
 * WHY ONE SOURCE. The owner's instruction: "dont need to get multiple sources,
 * get a source that has the complete story". A life story stitched from five
 * write-ups is five sets of emphases, five chronologies that disagree by a year,
 * and five names for the same deal; the myth lane learned that the hard way. One
 * complete, top-tier account, read whole, told in order.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';

export const casebookSchema = z.object({
  /** Must equal the persona id. */
  id: z.string().regex(/^[a-z0-9-]+$/),

  /** Said in the goodbye: "business stories". */
  beat: z.string().min(2),

  /**
   * The web searches run for a story. `{subject}` is replaced by the subject
   * pulled out of the topic ("how did Haldiram become Haldiram" -> "Haldiram").
   * Each is one Brave request; three is plenty to surface the encyclopedia
   * entry, the company's own history page and a long-form profile.
   */
  queries: z.array(z.string().includes('{subject}')).min(1).max(5),

  /**
   * Sources that tell a whole story well, with a bonus added to their score.
   * Encyclopedias first: they are complete and chronological by design, which
   * is exactly what a told life story needs.
   */
  preferred: z.array(z.object({ host: z.string().min(3), bonus: z.number().min(0).max(3) })),

  /** Never a source: social posts, Q&A sites, content farms, video. */
  refused: z.array(z.string().min(3)),

  /** Candidates fetched and scored per story. */
  candidates: z.number().int().min(1).max(10).default(6),

  /** Below this the source cannot carry the format. */
  minChars: z.object({ short: z.number().positive(), long: z.number().positive() }),

  /**
   * How much of the chosen source the writer reads. The only real cost lever on
   * the script: a short reads less so it fits ten pence.
   */
  readChars: z.object({ short: z.number().positive(), long: z.number().positive() }),
});

export type Casebook = z.infer<typeof casebookSchema>;

export const casebooksDir = (): string => path.resolve(__dirname, '..', '..', 'casebooks');

const fileFor = (id: string, dir: string) => path.join(dir, `${id}.yaml`);

/** True when this persona is a business-story channel. */
export const hasCasebook = (personaId: string, dir = casebooksDir()): boolean =>
  fs.existsSync(fileFor(personaId, dir));

export const parseCasebook = (source: string, label = '<inline>'): Casebook => {
  const result = casebookSchema.safeParse(YAML.parse(source));
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`
    );
    throw new Error(`${label} is not a valid casebook:\n  - ${problems.join('\n  - ')}`);
  }
  return result.data;
};

export const loadCasebook = (personaId: string, dir = casebooksDir()): Casebook => {
  const file = fileFor(personaId, dir);
  if (!fs.existsSync(file)) throw new Error(`no casebook for "${personaId}" (looked for ${file})`);
  const book = parseCasebook(fs.readFileSync(file, 'utf8'), file);
  if (book.id !== personaId) {
    throw new Error(`${file} says its id is "${book.id}", but it is the casebook for "${personaId}"`);
  }
  return book;
};
