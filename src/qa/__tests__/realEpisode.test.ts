/**
 * The check, against the whole episode and the whole corpus that fooled it.
 *
 * A unit test on four hand-picked sentences passed while the check was doing
 * nothing on the real thing, because attribution drifted across a 1,446 word
 * script in a way four sentences cannot show. This test is the reason that was
 * found, and it stays so the next refinement has to survive the real input too.
 *
 * It is skipped rather than failed when the run is not on disk, so a fresh
 * clone does not fail a suite over a directory it was never given.
 */
import fs from 'fs';
import path from 'path';
import { checkPronouns } from '../pronouns';

const RUN = path.join(__dirname, '../../../runs/20260912-140607-the-long-way-round');
const present = fs.existsSync(path.join(RUN, 'script.json'));

const maybe = present ? describe : describe.skip;

maybe('the episode that misgendered the sentencing judge', () => {
  const script = JSON.parse(fs.readFileSync(path.join(RUN, 'script.json'), 'utf8')) as {
    beats: Array<{ turns: Array<{ text: string }> }>;
  };
  const corpus = JSON.parse(fs.readFileSync(path.join(RUN, 'corpus.json'), 'utf8')) as
    | { sources: Array<{ text: string }> }
    | Array<{ text: string }>;

  const text = script.beats.flatMap((b) => b.turns.map((t) => t.text)).join(' ');
  const sources = Array.isArray(corpus) ? corpus : corpus.sources;
  const corpusText = sources.map((s) => s.text).join('\n');

  const CAST = [
    'HHJ Kinch',
    'Brian Reader',
    'Terry Perkins',
    'Kenny Collins',
    'Daniel Jones',
    'Carl Wood',
    'William Lincoln',
    'Hugh Doyle',
  ];

  it('reports the judge, and only the judge', () => {
    const problems = checkPronouns(text, corpusText, CAST);
    expect(problems.map((p) => p.name)).toEqual(['Kinch']);
    expect(problems[0]!.used).toBe('she');
    expect(problems[0]!.supported).toBe('he');
  });

  it('does not accuse the six men, whom the episode got right', () => {
    // The expensive failure mode for this check is the false positive: one
    // wrong accusation and everybody learns to wave the finding through.
    const problems = checkPronouns(text, corpusText, CAST);
    for (const name of ['Reader', 'Perkins', 'Collins', 'Jones', 'Wood', 'Lincoln', 'Doyle']) {
      expect(problems.map((p) => p.name)).not.toContain(name);
    }
  });
});
