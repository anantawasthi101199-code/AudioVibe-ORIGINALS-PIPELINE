import fs from 'fs';
import path from 'path';
import { Run } from '../src/run/store';
import { regate } from '../src/qa/regate';
import { scriptSchema } from '../src/script/write';
import { loadFormat } from '../src/formats/load';

for (const id of Run.list()) {
  const run = Run.open(id);
  const m = run.manifest;

  let sourceOnly = false;
  try {
    sourceOnly = Boolean(loadFormat(m.formatId).sourceOnly);
  } catch {
    /* format gone */
  }

  const hasAudio = fs.existsSync(path.join(run.dir, 'media', 'episode.wav'));
  const published = run.isComplete('publish');

  let verdict = 'no-gate';
  if (run.hasArtifact('qa') && run.hasArtifact('script')) {
    const fresh = regate(run, run.readArtifact('script', scriptSchema));
    verdict = fresh ? (fresh.passed ? 'PASS' : 'FAIL') : 'UNGATEABLE';
  } else if (sourceOnly && m.story === undefined && run.hasArtifact('script')) {
    verdict = 'source';
  }

  console.log(
    [
      id.padEnd(66),
      verdict.padEnd(11),
      (sourceOnly && m.story === undefined ? 'SOURCE' : m.story ? `story${m.story}` : 'episode').padEnd(9),
      hasAudio ? 'audio' : '  -  ',
      published ? 'published' : '',
      `${m.spentPence}p`,
    ].join(' ')
  );
}
