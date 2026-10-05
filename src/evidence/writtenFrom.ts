/**
 * Which documents a run was actually written from - ONE rule, read by the
 * publish-time gate and by the Sources sheet alike (2026-10-05).
 *
 * WHY ONE RULE. The single-story and case-file lanes keep no claim ledger;
 * they write from a reference article, a case file or one article. The gate
 * and the Sources sheet each had their own idea of what that meant, and
 * neither handled these lanes, so every short on four channels was refused
 * at publish. A run with a ledger uses the ledger; anything else uses this.
 */
import { z } from 'zod';
import { Run } from '../run/store';
import { caseFileSchema } from './casefile';
import { claimSchema, Claim } from './claim';
import { corpusSchema } from './research';
import { Source } from './source';
import { storyResearchSchema } from './story';

export const writtenFrom = (run: Run): Source[] => {
  const corpus = run.readArtifact('corpus', corpusSchema);
  // The news and business lanes keep a different shape under `reference`, so
  // this one is read only when it is the story lane's.
  const stored = run.hasArtifact('reference')
    ? storyResearchSchema.safeParse(run.readArtifact('reference', z.unknown())).data
    : undefined;
  const caseFile = run.hasArtifact('casefile') ? run.readArtifact('casefile', caseFileSchema) : undefined;
  const used = corpus.sources.filter(
    (src) =>
      stored?.reference?.sourceIds.includes(src.id) ||
      caseFile?.sourceIds.includes(src.id) ||
      src.id === stored?.article?.id
  );
  // Nothing recorded which: everything gathered, rather than nothing.
  return used.length ? used : corpus.sources;
};

/** The first real sentence of a document, for an anchor claim's quote. */
const firstSentence = (text: string): string =>
  ((text.match(/[^.!?\n]{60,400}[.!?]/g) ?? [])[0] ?? text.slice(0, 300)).trim();

/**
 * One claim per document, saying "this story rests on this document" and
 * marked unverified, because nothing checked it claim by claim. The same thing
 * the news lane does, so the Sources sheet lists what the story came from
 * instead of nothing.
 */
export const anchorClaims = (run: Run, title: string, beatId: string): Claim[] =>
  writtenFrom(run).map((src, i) =>
    claimSchema.parse({
      id: `source-${i + 1}`,
      text: title,
      type: 'attribution',
      beatId,
      sourceId: src.id,
      quote: firstSentence(src.text),
      status: 'unverified',
    })
  );
