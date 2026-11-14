/**
 * One refused run must not hold back every run behind it (2026-11-14: an
 * OWN_DUPLICATE at the head of the queue stopped all releases for six days).
 */
jest.mock('../publishRun', () => {
  class PublishRefused extends Error {
    constructor(public reason: string) {
      super(reason);
    }
  }
  return { PublishRefused, publishRun: jest.fn() };
});
jest.mock('../../qa/regate', () => ({ regate: () => ({ passed: true, findings: [] }) }));
jest.mock('../releaseLock', () => ({ takeReleaseLock: () => ({ release: () => undefined }) }));
jest.mock('../../canon/load', () => ({ loadPersona: () => ({ name: 'Show' }) }));

const runs: Record<string, { noteFailure: jest.Mock; clearFailure: jest.Mock }> = {};
jest.mock('../../run/store', () => ({
  Run: {
    list: () => ['a', 'b', 'c'],
    open: (id: string) => {
      runs[id] ??= { noteFailure: jest.fn(), clearFailure: jest.fn() };
      return {
        ...runs[id],
        id,
        manifest: {
          personaId: 'root-health',
          releaseAt: `2026-11-0${['a', 'b', 'c'].indexOf(id) + 1}T08:00:00Z`,
          releaseApprovedAt: '2026-10-01T00:00:00Z',
        },
        isComplete: () => false,
        hasArtifact: () => true,
        readArtifact: () => ({ title: id }),
      };
    },
  },
}));
jest.mock('../../script/write', () => ({ scriptSchema: {} }));

import { PublishRefused, publishRun } from '../publishRun';
import { releaseDue } from '../release';

it('skips a refused run, notes why on it, and releases the next one', async () => {
  (publishRun as jest.Mock)
    .mockRejectedValueOnce(new PublishRefused('OWN_DUPLICATE'))
    .mockResolvedValueOnce({ audioId: 'x', url: 'u' });

  const result = await releaseDue(new Date('2026-11-14T00:00:00Z'));

  expect(result.failed.map((f) => f.runId)).toEqual(['a']);
  expect(result.released.map((r) => r.runId)).toEqual(['b']);
  expect(result.remaining).toBe(1);
  expect(runs.a!.noteFailure).toHaveBeenCalledWith(expect.stringContaining('OWN_DUPLICATE'), 'publish');
  expect(publishRun).toHaveBeenCalledTimes(2);
});
