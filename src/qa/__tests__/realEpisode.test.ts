/**
 * The check, against the whole episode and the whole corpus that fooled it.
 *
 * A unit test on four hand-picked sentences passed while the check was doing
 * nothing on the real thing, because attribution drifted across a 1,446 word
 * script in a way four sentences cannot show. This test is the reason that was
 * found, and it stays so the next refinement has to survive the real input too.
 *
 * IT IS A FIXTURE NOW, NOT A LIVE RUN. It used to read out of runs/, which
 * meant the one test proving this works on a real episode went quietly green by
 * skipping the moment that run was archived - which is exactly what happened.
 * The script and its corpus are committed here instead, 190KB, and the test
 * cannot skip.
 */
import fs from 'fs';
import path from 'path';
import { checkPronouns } from '../pronouns';

const RUN = path.join(__dirname, 'fixtures', 'the-long-way-round');

describe('the episode that misgendered the sentencing judge', () => {
  const load = () => {
    const script = JSON.parse(fs.readFileSync(path.join(RUN, 'script.json'), 'utf8')) as {
      beats: Array<{ turns: Array<{ text: string }> }>;
    };
    const corpus = JSON.parse(fs.readFileSync(path.join(RUN, 'corpus.json'), 'utf8')) as
      | { sources: Array<{ text: string }> }
      | Array<{ text: string }>;
    const sources = Array.isArray(corpus) ? corpus : corpus.sources;
    return {
      text: script.beats.flatMap((b) => b.turns.map((t) => t.text)).join(' '),
      corpusText: sources.map((x) => x.text).join('\n'),
    };
  };

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
    const { text, corpusText } = load();
    const problems = checkPronouns(text, corpusText, CAST);
    expect(problems.map((p) => p.name)).toEqual(['Kinch']);
    expect(problems[0]!.used).toBe('she');
    expect(problems[0]!.supported).toBe('he');
  });

  it('does not accuse the six men, whom the episode got right', () => {
    // The expensive failure mode for this check is the false positive: one
    // wrong accusation and everybody learns to wave the finding through.
    const { text, corpusText } = load();
    const problems = checkPronouns(text, corpusText, CAST);
    for (const name of ['Reader', 'Perkins', 'Collins', 'Jones', 'Wood', 'Lincoln', 'Doyle']) {
      expect(problems.map((p) => p.name)).not.toContain(name);
    }
  });
});
