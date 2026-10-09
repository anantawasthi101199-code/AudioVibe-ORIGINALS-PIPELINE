/**
 * Where a run's money went (owner, 2026-10-09), so "why did this cost so
 * much" can be answered from the page instead of guessed.
 *
 * TWO RECORDS, READ TOGETHER:
 *   - media/voice-calls.jsonl: every request to the voice engine (written by
 *     renderScript), with the parts it carried, characters, tags and cost, and
 *     whether it was a first take, a re-take, or a part reused for free;
 *   - journal.jsonl: the run's own story, with every model call's spend by
 *     stage, and the events that explain a voicing (an edit, an engine switch,
 *     a regeneration).
 * The total is always the run's recorded spend; anything neither record can
 * place is shown as "not itemised", never silently dropped.
 */
import fs from 'fs';
import path from 'path';
import { Run } from '../run/store';
import { ELEVENLABS_PENCE_PER_1K_CHARS } from '../render/tts';
import { PENCE_PER_MCHAR as OPENAI_PENCE_PER_MCHAR } from '../render/openaiTts';

export interface VoiceCall {
  at: string;
  session: string;
  engine: string;
  beats: string[];
  attempt: 'voiced' | 'retake' | 'reused';
  chars: number;
  tags: number;
  tagChars: number;
  words: number;
  pence: number;
  note?: string;
}

export type CostKey =
  | 'research'
  | 'writing'
  | 'tagPass'
  | 'voiceFirst'
  | 'voiceAgain'
  | 'voiceRegenerate'
  | 'voiceRetake'
  | 'voiceUnlogged'
  | 'other';

const LABEL: Record<CostKey, string> = {
  research: 'Research (finding and checking sources)',
  writing: 'Writing the script',
  tagPass: 'Tag pass',
  voiceFirst: 'Voice: first voicing',
  voiceAgain: 'Voice: voiced again (an edit, an engine switch, a resume)',
  voiceRegenerate: 'Voice: regenerations',
  voiceRetake: 'Voice: re-takes (a part that ended in silence, voiced again in full)',
  voiceUnlogged: 'Voice (before the voice log existed)',
  other: 'Not itemised (model calls this run type does not label)',
};

const RESEARCH = new Set([
  'corpus', 'source', 'claims', 'verification', 'repair', 'gaps', 'counterEvidence', 'reference',
  'casefile', 'article', 'wire', 'extract', 'fuse', 'story', 'belief', 'research', 'continuity',
  'selection', 'brief',
]);

const readLines = <T>(file: string): T[] => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
};

export const voiceCallsFor = (run: Run): VoiceCall[] => readLines<VoiceCall>(path.join(run.dir, 'media', 'voice-calls.jsonl'));

/** What made a voicing happen: the last telling journal event before it began. */
const reasonFor = (
  sessionAt: string,
  journal: Array<{ at: string; event: string }>,
  earlierVoiced: boolean
): { key: CostKey; reason: string } => {
  const before = journal.filter((e) => e.at <= sessionAt).reverse();
  for (const e of before) {
    if (/regenerating as a new take/.test(e.event)) return { key: 'voiceRegenerate', reason: 'a regeneration (new take)' };
    if (/voice engine set to/.test(e.event)) return { key: 'voiceAgain', reason: e.event.replace(/^voice /, 'the ') };
    if (/edited in the studio|outro .*(attached|removed)|discarded: the script changed/.test(e.event)) {
      return { key: 'voiceAgain', reason: 'the script changed after it was voiced' };
    }
    if (/^approved|resumed/.test(e.event)) break;
  }
  return earlierVoiced
    ? { key: 'voiceAgain', reason: 'voiced again (a resume or a retry after a stop)' }
    : { key: 'voiceFirst', reason: 'the first voicing' };
};

export const costBreakdown = (run: Run) => {
  const total = run.manifest.spentPence;
  const journal = run.readJournal();
  const calls = voiceCallsFor(run);

  const pence: Record<CostKey, number> = {
    research: 0, writing: 0, tagPass: 0, voiceFirst: 0, voiceAgain: 0, voiceRegenerate: 0,
    voiceRetake: 0, voiceUnlogged: 0, other: 0,
  };

  // MODEL CALLS, by the stage that made them (render spends are voice, below).
  for (const e of journal) {
    if (typeof e.pence !== 'number' || e.event !== 'spend' || e.stage === 'render') continue;
    pence[RESEARCH.has(e.stage) ? 'research' : 'writing'] += e.pence;
  }
  for (const e of journal) if (e.event === 'tag pass' && typeof e.pence === 'number') pence.tagPass += e.pence;

  // VOICE, from the log when there is one; from the journal before it existed.
  const sessions = [...new Set(calls.map((c) => c.session))].sort();
  const sessionViews = sessions.map((session, n) => {
    const mine = calls.filter((c) => c.session === session);
    const earlierVoiced = sessions.slice(0, n).some((s) => calls.some((c) => c.session === s && c.attempt === 'voiced'));
    const why = reasonFor(session, journal, earlierVoiced);
    for (const c of mine) pence[c.attempt === 'retake' ? 'voiceRetake' : why.key] += c.pence;
    return {
      at: session,
      reason: why.reason,
      engine: mine[0]?.engine ?? '',
      pence: mine.reduce((a, c) => a + c.pence, 0),
      calls: mine,
    };
  });
  if (!calls.length) {
    for (const e of journal) if (e.stage === 'render' && e.event === 'spend' && typeof e.pence === 'number') pence.voiceUnlogged += e.pence;
  }

  const placed = (Object.keys(pence) as CostKey[]).reduce((a, k) => a + pence[k], 0);
  pence.other = Math.max(0, total - placed);

  const round = (n: number) => Math.round(n * 10) / 10;

  // WHAT THE JOURNAL SAYS, for every run including those voiced before the
  // voice log existed: each of these means part of the voice was paid twice.
  const count = (re: RegExp) => journal.filter((e) => re.test(`${e.event} ${e.detail ?? ''}`)).length;
  const retakes = count(/Taking it again/);
  const engineSwitches = count(/voice engine set to/);
  const editsAfterVoice = count(/discarded: the script changed/);
  const regenerations = count(/regenerating as a new take/);
  const tagPasses = count(/^tag pass/);
  const findings: string[] = [];
  if (retakes) findings.push(`${retakes} part${retakes === 1 ? ' was' : 's were'} re-taken in full because the first take ended in silence: each is paid twice.`);
  if (engineSwitches) findings.push(`The voice engine was switched ${engineSwitches} time${engineSwitches === 1 ? '' : 's'}: every switch throws away everything voiced, so the whole script is paid for again.`);
  if (editsAfterVoice) findings.push(`The script was changed after it was voiced ${editsAfterVoice} time${editsAfterVoice === 1 ? '' : 's'}: the changed parts were voiced again${calls.length ? '' : ' (before 2026-10-08, every part was)'}.`);
  if (regenerations) findings.push(`Regenerated ${regenerations} time${regenerations === 1 ? '' : 's'}: each regeneration voices the whole script again.`);
  if (tagPasses) findings.push(`A tag pass ran ${tagPasses} time${tagPasses === 1 ? '' : 's'} (a small model call; tags then add about 10 characters each to the voice).`);
  return {
    totalPence: round(total),
    segments: (Object.keys(pence) as CostKey[])
      .filter((k) => pence[k] > 0.05)
      .map((k) => ({ key: k, label: LABEL[k], pence: round(pence[k]) })),
    findings,
    voice: {
      sessions: sessionViews.map((s) => ({ ...s, pence: round(s.pence) })),
      /** The engines' rates the studio charges by, in pence per 1,000 characters. */
      ratePer1k: { elevenlabs: ELEVENLABS_PENCE_PER_1K_CHARS, openai: OPENAI_PENCE_PER_MCHAR / 1000 },
    },
  };
};
