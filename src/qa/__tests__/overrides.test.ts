import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { ignoreFinding, readOverrides, unignoreFinding, withOverrides } from '../overrides';

const report = (findings: Array<{ check: string; detail: string; blocking: boolean }>) => ({
  passed: !findings.some((f) => f.blocking),
  findings,
});

describe('ignoring a blocking gate finding', () => {
  let run: Run;
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-'));
    run = Run.create({ personaId: 'business-decoded', formatId: 'biz-short', topic: 'Airbnb' }, { root });
  });

  const year = { check: 'yearCheck', detail: 'the script says 2009; the source never does', blocking: true };
  const quote = { check: 'quoteCheck', detail: 'a quotation the source does not contain', blocking: true };

  it('passes once every blocking finding is ignored, and records who', () => {
    ignoreFinding(run, year, 'operator');
    const half = withOverrides(run, report([year, quote]));
    expect(half.passed).toBe(false);
    expect(half.findings[0]).toMatchObject({ blocking: false, ignored: { by: 'operator' } });

    ignoreFinding(run, quote, 'operator');
    expect(withOverrides(run, report([year, quote])).passed).toBe(true);
    expect(readOverrides(run)).toHaveLength(2);
  });

  it('matches the exact finding: an edit that changes it blocks again', () => {
    ignoreFinding(run, year, 'operator');
    const changed = { ...year, detail: 'the script says 2011; the source never does' };
    expect(withOverrides(run, report([changed])).passed).toBe(false);
  });

  it('blocks again after Undo, even from a report saved while it was ignored', () => {
    ignoreFinding(run, year, 'operator');
    const saved = withOverrides(run, report([year]));
    expect(saved.passed).toBe(true);
    unignoreFinding(run, year, 'operator');
    expect(withOverrides(run, saved).passed).toBe(false);
  });

  it('never touches a finding that was not blocking', () => {
    const note = { check: 'style', detail: 'long sentence', blocking: false };
    ignoreFinding(run, note, 'operator');
    expect(withOverrides(run, report([note])).findings[0]).toEqual(note);
  });
});
