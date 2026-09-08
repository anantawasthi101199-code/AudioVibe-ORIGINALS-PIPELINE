/**
 * Choosing which part of a document the extractor gets to read.
 *
 * THE PROBLEM THIS FIXES. Extraction used to receive the first 6000 characters
 * of each source, which is a documented way of missing evidence: the relevant
 * paragraph in a filing or an incident report is very often on page nine, under
 * a heading, after several pages of preamble. Truncating from the front does not
 * fail loudly; it silently produces a thinner ledger and an episode that had to
 * work around a fact that was sitting right there.
 *
 * WHY NOT A RERANKER API. That is the standard 2026 answer - hybrid retrieve,
 * cross-encoder rerank, keep the top few - and it is the right answer when you
 * are ranking thousands of candidates. Here the corpus is fourteen documents
 * that have already been fetched and tiered, so the ranking problem is not
 * "which documents" but "which PARAGRAPHS of these documents", and that is a
 * lexical problem a local scorer solves for nothing. Paying per call to rank
 * paragraphs inside a document we have already decided to use would buy very
 * little.
 *
 * It also sidesteps context rot: giving the model the passages that matter,
 * rather than everything up to a character limit, keeps the relevant text away
 * from the middle of a long context where attention measurably degrades.
 */

/** Words too common to carry any signal about what a passage is about. */
const STOP_WORDS = new Set(
  ('a about after all also an and any are as at be been but by can could did do does for from had has have ' +
    'he her his how i if in into is it its may might more most no not of on one only or other our out over ' +
    'said says she should so some such than that the their them then there these they this those through to ' +
    'under up was we were what when which who will with would you your')
    .split(' ')
);

const tokenise = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(
    (w) => w.length > 2 && !STOP_WORDS.has(w)
  );

export interface Passage {
  /** Index in document order, so selected passages can be reassembled in order. */
  index: number;
  text: string;
  score: number;
}

/**
 * Split a document into passages on paragraph boundaries.
 *
 * Boundaries, not fixed token counts. Cutting at 512 tokens splits a sentence
 * from the number it refers to and a heading from what it introduces, which is
 * the classic chunking failure - and here it would also break quote spans,
 * since a claim's quote has to occur verbatim in text the extractor was shown.
 */
export const splitPassages = (text: string, targetChars = 900): string[] => {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const passages: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    // A paragraph longer than the target stands alone rather than being cut:
    // splitting it would be the fixed-size failure by another route.
    if (paragraph.length >= targetChars) {
      if (current) {
        passages.push(current.trim());
        current = '';
      }
      passages.push(paragraph);
      continue;
    }
    if ((current + paragraph).length > targetChars && current) {
      passages.push(current.trim());
      current = '';
    }
    current += (current ? '\n\n' : '') + paragraph;
  }
  if (current.trim()) passages.push(current.trim());

  return passages;
};

/**
 * Score passages against what the episode is trying to establish.
 *
 * BM25-shaped rather than BM25 exactly: term frequency with saturation, inverse
 * document frequency across the passages of this one document, and a mild
 * length normalisation. Saturation is the part that matters - without it, a
 * passage that repeats one query word ten times outranks one that answers the
 * question, which is precisely the failure raw term counting has.
 */
export const scorePassages = (passages: string[], queries: string[]): Passage[] => {
  const queryTerms = [...new Set(queries.flatMap((q) => tokenise(q)))];
  const tokenised = passages.map((p) => tokenise(p));
  const lengths = tokenised.map((t) => t.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1) || 1;

  // How many passages contain each term, for IDF.
  const containing = new Map<string, number>();
  for (const term of queryTerms) {
    containing.set(term, tokenised.filter((t) => t.includes(term)).length);
  }

  const K1 = 1.4;
  const B = 0.7;

  return passages.map((text, index) => {
    const tokens = tokenised[index]!;
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      const n = containing.get(term) ?? 0;
      const idf = Math.log(1 + (passages.length - n + 0.5) / (n + 0.5));
      const norm = 1 - B + B * (tokens.length / avgLength);
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }

    return { index, text, score };
  });
};

/**
 * The parts of a document worth showing, in document order.
 *
 * The head is always included regardless of score. A document's opening carries
 * its thesis, its date and usually its headline figure, and a passage from the
 * middle arrives without any of that context - the extractor needs to know what
 * document it is reading before it can judge what a paragraph in it means.
 */
export const selectPassages = (
  text: string,
  queries: string[],
  budgetChars: number
): string => {
  if (text.length <= budgetChars) return text;

  const passages = splitPassages(text);
  if (passages.length <= 1) return text.slice(0, budgetChars);

  const scored = scorePassages(passages, queries);
  const chosen = new Set<number>();
  let used = 0;

  // Head first, always.
  const head = passages[0]!;
  chosen.add(0);
  used += head.length;

  for (const passage of [...scored].sort((a, b) => b.score - a.score)) {
    if (chosen.has(passage.index)) continue;
    // Only passages that matched something. A zero-scoring passage is padding
    // and spending budget on it pushes a real one out.
    if (passage.score <= 0) break;
    if (used + passage.text.length > budgetChars) continue;
    chosen.add(passage.index);
    used += passage.text.length;
  }

  return [...chosen]
    .sort((a, b) => a - b)
    .map((i, position, all) => {
      const previous = all[position - 1];
      // Mark where text was dropped, so the extractor does not read two
      // unrelated paragraphs as continuous and quote across the join.
      const gap = previous !== undefined && i > previous + 1 ? '\n\n[...]\n\n' : '';
      return gap + passages[i]!;
    })
    .join('\n\n');
};
