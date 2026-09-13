/**
 * A listener finds a show by its voice long before they read its name, so the
 * question this answers is not "what is configured" but "what have people
 * already heard".
 */
import { parsePersona } from '../load';
import {
  VoiceChangedError,
  assertVoiceUnchanged,
  recordVoices,
  retireVoices,
  voiceChanges,
  voiceFor,
  VoiceRegistry,
} from '../voiceRegistry';

const show = (voiceId = 'v-eleven', draft = 'fable') =>
  parsePersona(`
id: s
handle: s
name: The Show
category: Storytelling
thesis: A thesis.
audience: An audience.
register: Plain.
hosts:
  - id: narrator
    name: Wren
    role: Narrates.
    voice: {provider: elevenlabs, voiceId: ${voiceId}, draftVoiceId: ${draft}}
styleCard:
  sentenceWordsMean: 15
  sentenceWordsStdDevMin: 5
  questionsPer100Words: 1
  secondPersonPer100Words: 1
  hedgesPer100WordsMax: 3
  metaphorDomains: [weather]
  forbiddenPhrases: [cautionary tale]
canon:
  - {kind: belief, text: Something.}
formats: [f]
episodeSeconds: [300, 400]
allowedRiskTiers: [general]
`);

const pinned = (voiceId: string, provider = 'elevenlabs'): VoiceRegistry => ({
  s: {
    narrator: {
      [provider]: {
        provider,
        voiceId,
        firstUsedAt: '2026-09-01T00:00:00.000Z',
        firstRunId: '20260901-first',
      },
    },
  },
});

describe('voiceFor', () => {
  it('gives the publishing voice for the publishing provider', () => {
    expect(voiceFor(show(), 'narrator', 'elevenlabs')?.voiceId).toBe('v-eleven');
  });

  it('gives the DRAFT voice for any other provider', () => {
    // A voice id belongs to a provider. "fable" means nothing to Eleven and a
    // twenty-character Eleven id means nothing to OpenAI.
    expect(voiceFor(show(), 'narrator', 'openai')?.voiceId).toBe('fable');
  });

  it('returns nothing rather than substituting when a show cannot be drafted', () => {
    const noDraft = parsePersona(
      `id: s\nhandle: s\nname: S\ncategory: Storytelling\nthesis: t\naudience: a\nregister: r\n` +
        `hosts:\n  - {id: narrator, name: W, role: N., voice: {provider: elevenlabs, voiceId: v}}\n` +
        `styleCard:\n  sentenceWordsMean: 15\n  sentenceWordsStdDevMin: 5\n  questionsPer100Words: 1\n` +
        `  secondPersonPer100Words: 1\n  hedgesPer100WordsMax: 3\n  metaphorDomains: [weather]\n` +
        `  forbiddenPhrases: [x]\ncanon:\n  - {kind: belief, text: Something.}\nformats: [f]\n` +
        `episodeSeconds: [300, 400]\nallowedRiskTiers: [general]\n`
    );
    expect(voiceFor(noDraft, 'narrator', 'openai')).toBeNull();
  });
});

describe('voiceChanges', () => {
  it('says nothing when the persona still agrees with what was heard', () => {
    expect(voiceChanges(show('v-eleven'), 'elevenlabs', pinned('v-eleven'))).toEqual([]);
  });

  it('catches a persona edited to a different voice', () => {
    const problems = voiceChanges(show('v-something-else'), 'elevenlabs', pinned('v-eleven'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/has spoken as "v-eleven"/);
    expect(problems[0]).toMatch(/now says "v-something-else"/);
  });

  it('does not confuse one provider with another', () => {
    // A show drafted on OpenAI and published on Eleven legitimately has two
    // voices, and a change to one is not a change to the other.
    expect(voiceChanges(show('v-eleven', 'nova'), 'elevenlabs', pinned('v-eleven'))).toEqual([]);
  });

  it('says nothing about a channel that has never been heard', () => {
    expect(voiceChanges(show(), 'elevenlabs', {})).toEqual([]);
  });
});

describe('assertVoiceUnchanged', () => {
  it('throws before any work is done, and says how to do it on purpose', () => {
    // An error that only forbids is an error somebody works around by deleting
    // the file.
    try {
      assertVoiceUnchanged(show('v-new'), 'elevenlabs', pinned('v-old'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceChangedError);
      expect((err as Error).message).toMatch(/voice-retire --show s/);
    }
  });
});

describe('recordVoices', () => {
  it('pins a voice the first time a channel uses one', () => {
    const { registry, recorded } = recordVoices(show(), 'elevenlabs', 'run-1', {});
    expect(recorded).toEqual([{ hostId: 'narrator', voiceId: 'v-eleven' }]);
    expect(registry.s!.narrator!.elevenlabs!.firstRunId).toBe('run-1');
  });

  it('NEVER re-points one that is already committed', () => {
    // The first use is the commitment. A later run quietly overwriting it is
    // exactly the failure the registry exists to prevent.
    const { registry, recorded } = recordVoices(show('v-new'), 'elevenlabs', 'run-2', pinned('v-old'));
    expect(recorded).toEqual([]);
    expect(registry.s!.narrator!.elevenlabs!.voiceId).toBe('v-old');
  });

  it('does not pin a placeholder', () => {
    // A string that exists to be replaced is not a commitment.
    const { recorded } = recordVoices(show('REPLACE_BEFORE_FIRST_PUBLISH'), 'elevenlabs', 'r', {});
    expect(recorded).toEqual([]);
  });

  it('records each provider separately', () => {
    const first = recordVoices(show(), 'openai', 'r1', {});
    const second = recordVoices(show(), 'elevenlabs', 'r2', first.registry);
    expect(second.registry.s!.narrator!.openai!.voiceId).toBe('fable');
    expect(second.registry.s!.narrator!.elevenlabs!.voiceId).toBe('v-eleven');
  });
});

describe('retireVoices', () => {
  it('releases one provider and leaves the other committed', () => {
    const both = recordVoices(show(), 'elevenlabs', 'r', recordVoices(show(), 'openai', 'r', {}).registry).registry;
    const after = retireVoices('s', both, 'openai');
    expect(after.s!.narrator!.openai).toBeUndefined();
    expect(after.s!.narrator!.elevenlabs).toBeDefined();
  });

  it('releases the whole show when no provider is named', () => {
    expect(retireVoices('s', pinned('v'))).toEqual({});
  });

  it('is harmless on a show that was never pinned', () => {
    expect(retireVoices('other', pinned('v'))).toEqual(pinned('v'));
  });
});
