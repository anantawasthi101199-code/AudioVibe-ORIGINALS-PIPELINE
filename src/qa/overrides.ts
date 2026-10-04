/**
 * A person overriding a blocking gate finding, one finding at a time.
 *
 * THE GATE IS ARITHMETIC AND SOMETIMES WRONG ABOUT A HUMAN EDIT. A script
 * edited in the studio with facts the source never contained is blocked by
 * the free checks - correctly, by their rules - while the person who added
 * them knows they are right. The person may say so, finding by finding.
 *
 * MATCHED ON THE EXACT FINDING, check and detail. An override answers the
 * finding that was on screen when somebody pressed Ignore. Edit the script
 * again and a check that now fails differently has a different detail, so it
 * blocks again until somebody looks - an override is never a blanket pass.
 *
 * RECORDED ON THE RUN, who and when, in overrides.json beside the artifacts,
 * so the journal of a published episode can say who let it past which check.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { Run } from '../run/store';

const overrideSchema = z.object({
  check: z.string(),
  detail: z.string(),
  by: z.string().nullable(),
  at: z.string(),
});

export type Override = z.infer<typeof overrideSchema>;

const file = (run: Run) => path.join(run.dir, 'overrides.json');

export const readOverrides = (run: Run): Override[] => {
  if (!fs.existsSync(file(run))) return [];
  const parsed = z.array(overrideSchema).safeParse(JSON.parse(fs.readFileSync(file(run), 'utf8')));
  return parsed.success ? parsed.data : [];
};

const write = (run: Run, list: Override[]) => {
  if (list.length) fs.writeFileSync(file(run), JSON.stringify(list, null, 2));
  else fs.rmSync(file(run), { force: true });
};

const same = (a: { check: string; detail: string }, b: { check: string; detail: string }) =>
  a.check === b.check && a.detail === b.detail;

export const ignoreFinding = (run: Run, finding: { check: string; detail: string }, by: string | null) => {
  const list = readOverrides(run).filter((o) => !same(o, finding));
  write(run, [...list, { ...finding, by, at: new Date().toISOString() }]);
  run.journal({ stage: 'qa', event: `${by ?? 'somebody'} ignored [${finding.check}]: ${finding.detail}` });
};

export const unignoreFinding = (run: Run, finding: { check: string; detail: string }, by: string | null) => {
  write(run, readOverrides(run).filter((o) => !same(o, finding)));
  run.journal({ stage: 'qa', event: `${by ?? 'somebody'} stopped ignoring [${finding.check}]` });
};

export interface Finding {
  check: string;
  detail: string;
  blocking: boolean;
}

/**
 * The report as a person has ruled on it: every ignored blocking finding stops
 * blocking (and says who ignored it), and `passed` is recomputed from what is
 * left. A finding that is not blocking is never touched.
 */
export const withOverrides = <R extends { passed: boolean; findings: Finding[] }>(
  run: Run,
  report: R
): R & { findings: Array<Finding & { ignored?: { by: string | null; at: string } }> } => {
  const overrides = readOverrides(run);
  const findings = report.findings.map((stored) => {
    // A report saved after an override carries `ignored`; take it back to
    // what the gate said, so an undone override blocks again.
    const { ignored, ...plain } = stored as Finding & { ignored?: unknown };
    const f = ignored ? { ...plain, blocking: true } : stored;
    const o = f.blocking ? overrides.find((x) => same(x, f)) : undefined;
    return o ? { ...f, blocking: false, ignored: { by: o.by, at: o.at } } : f;
  });
  return { ...report, findings, passed: !findings.some((f) => f.blocking) };
};
