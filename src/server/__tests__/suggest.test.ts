import { loadPersona } from '../../canon/load';
import { loadFormat } from '../../formats/load';
import { LlmClient, LlmRequest } from '../../models/client';
import { LENGTH_RULES, suggestTopics } from '../suggest';

const promptFor = async (formatId: string): Promise<string> => {
  let prompt = '';
  const writer = {
    name: 'fake',
    model: 'fake',
    async complete(req: LlmRequest) {
      prompt = req.prompt;
      return {
        text: '{"suggestions":[{"topic":"t","why":"w"}]}',
        inputTokens: 0,
        outputTokens: 0,
        costPence: 0,
        model: 'fake',
      };
    },
  } as LlmClient;
  await suggestTopics(
    { persona: loadPersona('crime-files'), format: loadFormat(formatId), queued: [], made: [], count: 1 },
    writer
  );
  return prompt;
};

describe('topic suggestions by length', () => {
  it('asks a short for one compact story and an episode for a deep one', async () => {
    const short = await promptFor('case-short');
    expect(short).toContain(LENGTH_RULES.short);
    expect(short).not.toContain(LENGTH_RULES.long);

    const long = await promptFor('case-in-full');
    expect(long).toContain(LENGTH_RULES.long);
    expect(long).not.toContain(LENGTH_RULES.short);
  });
});
