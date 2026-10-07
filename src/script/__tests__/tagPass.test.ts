import { channelVoice } from '../../canon/voiceMaster';
import { LlmClient } from '../../models/client';
import { tagPass, wordsOf } from '../tagPass';
import { Script } from '../write';

const channel = channelVoice('mythic-archives')!;

const script = (texts: string[], fixedLast = false): Script =>
  ({
    personaId: 'mythic-archives',
    formatId: 'myth-story',
    title: 't',
    description: 'd',
    writerModel: 'm',
    beats: [
      {
        beatId: 'b1',
        beatType: 'story',
        claimIds: [],
        revisions: 0,
        turns: texts.map((text, i) => ({
          speaker: 'narrator',
          text,
          ...(fixedLast && i === texts.length - 1 ? { fixed: true } : {}),
        })),
      },
    ],
  }) as Script;

const replying = (lines: Array<{ i: number; text: string }>) => {
  const seen: string[] = [];
  const client: LlmClient = {
    name: 'fake',
    model: 'fake',
    complete: async (req) => {
      seen.push(req.prompt);
      return { text: JSON.stringify({ lines }), inputTokens: 1, outputTokens: 1, costPence: 0.4, model: 'fake' };
    },
  };
  return { client, seen };
};

describe('the tag pass', () => {
  it('compares words with tags, case and punctuation set aside', () => {
    expect(wordsOf('[hushed] And THEN... it spoke.')).toEqual(['and', 'then', 'it', 'spoke']);
    // Found on a real Root Health script: a curly apostrophe came back straight.
    expect(wordsOf('a bad night’s sleep')).toEqual(wordsOf("a bad night's sleep"));
  });

  it('keeps tags and emphasis that leave every word in place', async () => {
    const { client } = replying([{ i: 0, text: '[hushed] And THEN... the corpse spoke.' }]);
    const out = await tagPass(script(['And then the corpse spoke.']), channel, client);
    expect(out.script.beats[0]!.turns[0]!.text).toBe('[hushed] And THEN... the corpse spoke.');
    expect(out.tagged).toBe(1);
  });

  it('throws away any line where a word changed, keeping the original', async () => {
    const { client } = replying([{ i: 0, text: '[hushed] And then the dead body spoke.' }]);
    const out = await tagPass(script(['And then the corpse spoke.']), channel, client);
    expect(out.script.beats[0]!.turns[0]!.text).toBe('And then the corpse spoke.');
    expect(out.rejected).toBe(1);
  });

  it('removes tags the channel never uses or did not list', async () => {
    const { client } = replying([{ i: 0, text: '[laughs] And then [thunder rumbling] the corpse spoke.' }]);
    const out = await tagPass(script(['And then the corpse spoke.']), channel, client);
    expect(out.script.beats[0]!.turns[0]!.text).toBe('And then the corpse spoke.');
  });

  it('never sends the fixed outro, and leaves it exactly as written', async () => {
    const { client, seen } = replying([{ i: 0, text: '[slowly] The end.' }]);
    const out = await tagPass(script(['The end.', 'Thank you for listening.'], true), channel, client);
    expect(seen[0]).not.toContain('Thank you for listening');
    expect(out.script.beats[0]!.turns[1]!.text).toBe('Thank you for listening.');
  });
});
