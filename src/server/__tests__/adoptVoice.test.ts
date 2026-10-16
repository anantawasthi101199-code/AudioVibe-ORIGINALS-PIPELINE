/**
 * A published run takes another run's voice only when nothing could go wrong:
 * it is published, the other run finished voicing, and the words match.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { scriptSchema } from '../../script/write';
import { adoptVoice } from '../routes';

const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'biz-short-story-route');
const ID = 'business-decoded/e001-20261004-did-airbnb-go-from-renting-air';
const COPY = 'business-decoded/e099-20261016-did-airbnb-go-from-renting-air';

describe('taking another run\'s voice', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.cpSync(path.join(root, ID), path.join(root, COPY), { recursive: true });
    process.env.FOUNDRY_RUNS_DIR = root;
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('REFUSES an unpublished run, and two scripts that differ by a word', () => {
    const target = Run.open(ID, { root });
    target.uncomplete('publish');
    expect(() => adoptVoice(ID, { from: COPY })).toThrow(/only a published run/);

    target.markComplete('publish');
    Run.open(COPY, { root }).markComplete('render');
    const copy = Run.open(COPY, { root });
    const s = copy.readArtifact('script', scriptSchema);
    s.beats[0]!.turns[0]!.text += ' extra';
    copy.writeArtifact('script', s);
    expect(() => adoptVoice(ID, { from: COPY })).toThrow(/not word for word the same/);
    expect(Run.open(COPY, { root }).manifest.abandoned).toBeFalsy();
  });
});
