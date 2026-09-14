/**
 * The verifier's job is to be strict and isolated. These tests pin both: that
 * weakened support blocks, and that the model is never handed context it could
 * reason around instead of checking the text.
 */
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { Claim } from '../claim';
import { Source } from '../source';
import { BLOCKING_VERDICTS, verifyAll, verifyClaim ,
  shouldVerify,
  verifyMode,
} from '../verify';

const fakeVerifier = (reply: string | ((r: LlmRequest) => string)): LlmClient & { seen: LlmRequest[] } => {
  const seen: LlmRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-verifier-1',
    seen,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      seen.push(req);
      return {
        text: typeof reply === 'function' ? reply(req) : reply,
        inputTokens: 10,
        outputTokens: 5,
        costPence: 0.1,
        model: 'fake-verifier-1',
      };
    },
  };
};

const source: Source = {
  id: 'src1',
  url: 'https://www.nature.com/articles/x',
  title: 'A Paper',
  publisher: 'Nature',
  retrievedAt: '2026-09-07T12:00:00.000Z',
  contentHash: 'a'.repeat(64),
  tier: 'T1',
  text: 'Shorter shifts were associated with fewer incidents.',
  httpStatus: 200,
} as Source;

const claim: Claim = {
  id: 'c1',
  text: 'Shorter shifts caused fewer incidents.',
  type: 'causal',
  beatId: 'mechanism',
  sourceId: 'src1',
  quote: 'Shorter shifts were associated with fewer incidents.',
  contested: false,
};

describe('verifyClaim', () => {
  it('passes an entailed claim', async () => {
    const { verification } = await verifyClaim(claim, source, fakeVerifier('{"verdict":"entailed","reason":"yes"}'));
    expect(verification.verdict).toBe('entailed');
  });

  it('gives the verifier ONLY the claim and the quote', async () => {
    // The most important property here and the easiest to undo by accident.
    // Given the surrounding argument, a verifier starts judging whether the
    // argument is reasonable, which is a different and much easier question.
    const v = fakeVerifier('{"verdict":"entailed","reason":"y"}');
    await verifyClaim(claim, source, v);

    const prompt = v.seen[0]!.prompt;
    expect(prompt).toContain(claim.text);
    expect(prompt).toContain(claim.quote);
    // Authority is not what is being judged; telling it the quote came from
    // Nature would bias it toward accepting.
    expect(prompt).not.toContain('Nature');
    expect(prompt).not.toContain(source.url);
    expect(prompt).not.toContain(claim.beatId);
  });

  it('asks with temperature 0, because judgement should not wander', async () => {
    const v = fakeVerifier('{"verdict":"entailed","reason":"y"}');
    await verifyClaim(claim, source, v);
    expect(v.seen[0]!.temperature).toBe(0);
  });

  it('FAILS CLOSED on unparseable output', async () => {
    // An unparseable verdict is not a pass, and failing closed matters more
    // here than almost anywhere else in the pipeline.
    const { verification } = await verifyClaim(claim, source, fakeVerifier('I think probably yes'));
    expect(verification.verdict).toBe('not_entailed');
    expect(verification.reason).toMatch(/unparseable/);
  });

  it('fails closed on an unknown verdict word', async () => {
    const { verification } = await verifyClaim(claim, source, fakeVerifier('{"verdict":"probably","reason":"x"}'));
    expect(verification.verdict).toBe('not_entailed');
    expect(verification.reason).toMatch(/unknown verdict/);
  });
});

describe('blocking verdicts', () => {
  /**
   * PARTIAL ENTAILMENT USED TO BLOCK, and this test used to insist on it.
   *
   * The reasoning was sound - "supports it more weakly than stated" is how a
   * sourced episode ends up overclaiming - and the machinery built to handle it
   * cost more than the problem. The narrower rewrote twenty-nine claims on one
   * ten-story set and lost a proper noun, lost a causal link, and produced one
   * claim about a different subject. A listener lost an elephant's name to be
   * protected from a quote that was slightly narrower than its sentence.
   *
   * What blocks now is only what a reader cannot catch: a document that says
   * the opposite, and a document that does not exist.
   */
  it('blocks only what a person reading the script could not catch', () => {
    expect(BLOCKING_VERDICTS).toContain('contradicted');
    expect(BLOCKING_VERDICTS).toContain('unsourced');

    // Both still RECORDED, and both still on the run's page. What changed is
    // what they do, not whether anybody can see them.
    expect(BLOCKING_VERDICTS).not.toContain('partially_entailed');
    expect(BLOCKING_VERDICTS).not.toContain('not_entailed');
    expect(BLOCKING_VERDICTS).not.toContain('entailed');
  });
});

describe('verifyAll', () => {
  it('collects blocking results separately', async () => {
    const v = fakeVerifier((req) =>
      req.prompt.includes('caused')
        ? '{"verdict":"contradicted","reason":"the document says the opposite"}'
        : '{"verdict":"entailed","reason":"yes"}'
    );
    const other: Claim = { ...claim, id: 'c2', text: 'Incidents fell.', type: 'chronology' };
    const report = await verifyAll([claim, other], [source], v);

    expect(report.results).toHaveLength(2);
    expect(report.blocking).toHaveLength(1);
    expect(report.blocking[0]!.claimId).toBe('c1');
    expect(report.verifierModel).toBe('fake-verifier-1');
  });

  it('reports cost per claim so a budget trips at the claim that tripped it', async () => {
    const costs: number[] = [];
    await verifyAll([claim, { ...claim, id: 'c2' }], [source], fakeVerifier('{"verdict":"entailed","reason":"y"}'), (c) =>
      costs.push(c)
    );
    expect(costs).toHaveLength(2);
  });

  it('fails a claim citing a source outside the corpus without calling the model', async () => {
    const v = fakeVerifier('{"verdict":"entailed","reason":"y"}');
    const report = await verifyAll([{ ...claim, sourceId: 'ghost' }], [source], v);
    expect(report.blocking).toHaveLength(1);
    expect(v.seen).toHaveLength(0);
  });
});

/**
 * Sampling the model check.
 *
 * The deterministic quote check runs on every claim and costs nothing; it is
 * the anti-fabrication guarantee. Asking a model whether that quote ENTAILS the
 * claim is a call per claim and the largest line on a run's bill - and every
 * script now goes in front of a person before a word of it is voiced, with the
 * claims sitting next to their quotes.
 */
describe('shouldVerify', () => {
  const claim = (id: string, contested = false) =>
    ({ id, contested }) as never;

  afterEach(() => {
    delete process.env.FOUNDRY_VERIFY;
  });

  it('checks everything when asked to', () => {
    const ids = ['c1', 'c2', 'c3', 'c17', 'c93'];
    expect(ids.every((id) => shouldVerify(claim(id), 'all'))).toBe(true);
  });

  it('ALWAYS checks a contested claim, whatever the mode', () => {
    // Contested is where being wrong is both likely and costly, so it is the
    // one thing sampling may never skip.
    expect(shouldVerify(claim('c1', true), 'sample')).toBe(true);
    expect(shouldVerify(claim('c99', true), 'sample')).toBe(true);
  });

  it('samples roughly a quarter of the rest', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `c${i}`);
    const checked = ids.filter((id) => shouldVerify(claim(id), 'sample')).length;

    expect(checked).toBeGreaterThan(400 * 0.15);
    expect(checked).toBeLessThan(400 * 0.4);
  });

  it('is DETERMINISTIC, so a resume checks the same quarter', () => {
    // Math.random would give a different answer on a resume, so an interrupted
    // run would check a different sample and its checkpoint would disagree with
    // itself about what had been done.
    const ids = Array.from({ length: 50 }, (_, i) => `c${i}`);
    const once = ids.map((id) => shouldVerify(claim(id), 'sample'));
    const twice = ids.map((id) => shouldVerify(claim(id), 'sample'));

    expect(once).toEqual(twice);
  });

  it('reads the mode from the environment, defaulting to sampling', () => {
    process.env.FOUNDRY_VERIFY = 'all';
    expect(verifyMode()).toBe('all');

    delete process.env.FOUNDRY_VERIFY;
    expect(verifyMode()).toBe('sample');
  });
});
