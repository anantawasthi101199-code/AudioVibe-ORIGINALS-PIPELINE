/** Where the money went: the voice log and the breakdown (owner, 2026-10-09). */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { renderScript } from '../../render/assemble';
import { Run } from '../../run/store';
import { costBreakdown, voiceCallsFor } from '../costs';
import type { TtsProvider } from '../../render/tts';

const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'biz-short-story-route');
const RUN_ID = 'business-decoded/e001-20261004-did-airbnb-go-from-renting-air';

describe('the voice log and the cost breakdown', () => {
  let root: string;
  let run: Run;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'costs-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    run = Run.open(RUN_ID, { root });
    fs.rmSync(path.join(run.dir, 'media'), { recursive: true, force: true });
    fs.writeFileSync(path.join(run.dir, 'journal.jsonl'), '');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const tts: TtsProvider = {
    name: 'elevenlabs',
    understandsTags: true,
    async synthesise({ text }) {
      return { audio: Buffer.from(text), provider: 'elevenlabs', model: 'm', voiceId: 'v', costPence: (text.length / 1000) * 6 };
    },
  };
  const beats = (close: string) => [
    { beatId: 'story', beatType: 'escalation', turns: [{ speaker: 'host', text: '[warmly] ' + 'Words here. '.repeat(100) }] },
    { beatId: 'close', beatType: 'button', turns: [{ speaker: 'host', text: close }] },
  ];
  const voice = { provider: 'elevenlabs', voiceId: 'v', settings: {} };
  const render = (close: string, trailing = 0.2) =>
    renderScript(
      { beats: beats(close), voices: { host: voice }, beatPathFor: (n) => run.mediaPath(n), outputPath: run.mediaPath('episode.wav') },
      tts,
      { probe: async () => 30, trailing: async () => trailing, concat: async () => undefined },
      (p) => run.spend(p, 10_000)
    );

  it('logs every call: voiced, re-taken in full, and reused free, with characters and tags', async () => {
    await render('The end.', 2.5); // every part "ends in silence": each is re-taken
    run.journal({ stage: 'script', event: 'edited in the studio' });
    await new Promise((r) => setTimeout(r, 5));
    await render('A new end.');
    const calls = voiceCallsFor(run);
    expect(calls.filter((c) => c.attempt === 'retake')).toHaveLength(2);
    expect(calls.filter((c) => c.attempt === 'reused').map((c) => c.beats)).toEqual([['story']]);
    const story = calls.find((c) => c.beats[0] === 'story' && c.attempt === 'voiced')!;
    expect(story.tags).toBe(1);
    expect(story.tagChars).toBe('[warmly]'.length + 1);
    expect(story.chars).toBeGreaterThan(1000);
  });

  it('splits the total by what caused it, and the parts add up to the total', async () => {
    run.journal({ stage: 'corpus', event: 'spend', pence: 3 });
    run.spend(3, 10_000);
    run.journal({ stage: 'script', event: 'spend', pence: 4 });
    run.spend(4, 10_000);
    await render('The end.', 2.5);
    run.journal({ stage: 'script', event: 'edited in the studio' });
    await new Promise((r) => setTimeout(r, 5));
    await render('A different end.');
    run.journal({ stage: 'render', event: 'regenerating as a new take' });
    await new Promise((r) => setTimeout(r, 5));
    // Regenerate deletes every voiced part and its key (the log stays).
    for (const f of fs.readdirSync(path.join(run.dir, 'media'))) {
      if (/^\d{2}-.+\.mp3(\.key)?$/.test(f)) fs.rmSync(path.join(run.dir, 'media', f));
    }
    await render('A different end.');

    const b = costBreakdown(Run.open(RUN_ID, { root }));
    const by = Object.fromEntries(b.segments.map((s) => [s.key, s.pence]));
    expect(by.research).toBe(3);
    expect(by.writing).toBe(4);
    expect(by.voiceRetake).toBeGreaterThan(0);
    expect(by.voiceAgain).toBeGreaterThan(0); // only the edited part, after the edit
    expect(by.voiceRegenerate).toBeGreaterThan(by.voiceAgain!); // everything, after the regeneration
    expect(b.voice.sessions.map((s) => s.reason)).toEqual([
      'the first voicing',
      'the script changed after it was voiced',
      'a regeneration (new take)',
    ]);
    const sum = b.segments.reduce((a, s) => a + s.pence, 0);
    expect(Math.abs(sum - b.totalPence)).toBeLessThan(0.3);
  });

  it('names what made the voice cost twice, from the journal, even for runs voiced before the log', () => {
    run.journal({ stage: 'render', event: '2/3: story ended on 2.1s of silence. Taking it again.' });
    run.journal({ stage: 'render', event: 'voice engine set to elevenlabs by anant' });
    run.journal({ stage: 'render', event: 'discarded: the script changed under it' });
    const f = costBreakdown(Run.open(RUN_ID, { root })).findings.join(' ');
    expect(f).toMatch(/1 part was re-taken/);
    expect(f).toMatch(/switched 1 time/);
    expect(f).toMatch(/changed after it was voiced 1 time/);
  });
});
