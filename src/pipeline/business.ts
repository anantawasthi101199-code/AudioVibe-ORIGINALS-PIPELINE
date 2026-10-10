/**
 * The business-story lane: how one business, or one businessperson, was built,
 * told complete and in order from ONE top-tier source. Episodes (12 to 15
 * minutes) and shorts (under three).
 *
 *   [free] SEARCH    the casebook's web queries for the subject
 *   [free] SOURCE    refused hosts dropped; up to six fetched and scored on
 *                    completeness, chronology, subject and tier. ONE wins.
 *   [paid] WRITE     one call writes the whole story and its title
 *                    short ~5p, episode ~10p
 *   [free] CHECK     figures, quotations, unknowns, follow ask, length, order
 *   [paid] RENDER    OpenAI voice. short ~3p, episode ~15p
 *   [free] GATE      again at publish
 *
 * Budgets set by the owner: a short under 10p, an episode under a pound.
 *
 * ITS OWN LANE. Nothing here is reached by the news, story or fiction lanes,
 * and nothing there is reached from here; pipeline/lanes.ts decides which lane
 * a run belongs to and refuses a format from another lane. What is shared is
 * the plumbing every lane shares: the run store, the renderer, the voice
 * registry, the gate, and the source-text checks in qa/sourceText.ts.
 */
import { formatForRun } from '../formats/forRun';
import { musicFor } from '../render/musicFor';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import {
  assertVoiceUnchanged,
  loadVoiceRegistry,
  recordVoices,
  saveVoiceRegistry,
} from '../canon/voiceRegistry';
import { budgetFor, targetFor } from './budget';
import { stageFlags, stagesOff } from '../config/stages';
import { claimSchema } from '../evidence/claim';
import { Source, sourceSchema } from '../evidence/source';
import { loadFormat } from '../formats/load';
import { GateReport } from '../qa/gate';
import { renderResultSchema, renderScript } from '../render/assemble';
import { Run } from '../run/store';
import { Script, scriptSchema } from '../script/write';
import { Casebook, loadCasebook } from '../business/casebook';
import { businessDraftProblems, businessGate, estimatedSeconds } from '../business/check';
import { cleanStoryText, pickStorySource, searchStory, subjectOf } from '../business/pickSource';
import { writeBusinessScript } from '../business/storyScript';
import type { PipelineDeps } from './episode';
import { withOutro } from '../script/outro';

export interface BusinessDeps {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  casebook?: Casebook;
}

/** What the run recorded about its source, on the otherwise unused `reference` artifact. */
export const businessRecordSchema = z.object({
  business: z.object({
    subject: z.string(),
    url: z.string(),
    title: z.string(),
    score: z.number(),
    reason: z.string(),
    considered: z.array(z.object({ url: z.string(), score: z.number().optional(), reason: z.string() })),
  }),
});

const corpusArtifactSchema = z.object({
  sources: z.array(sourceSchema),
  rejected: z.array(z.object({ url: z.string(), reason: z.string() })),
});

/** The one-entry ledger the Sources sheet is built from. Same reason as the news lane. */
const anchorClaim = (source: Source, text: string, subject: string, beatId: string) => {
  const sentence = (text.match(/[^.!?\n]{60,400}[.!?]/g) ?? [text.slice(0, 300)])[0]!.trim();
  return claimSchema.parse({
    id: 'story-1',
    text: `The story of ${subject}`,
    type: 'chronology',
    beatId,
    sourceId: source.id,
    quote: sentence,
    status: 'unverified',
  });
};

export const runBusiness = async (
  run: Run,
  deps: PipelineDeps,
  bizDeps: BusinessDeps = {}
): Promise<{ run: Run; script: Script; gate: GateReport }> => {
  const budget = budgetFor(run);
  const now = bizDeps.now ?? (() => new Date());
  const say = (stage: string) => (message: string) => {
    (deps.log ?? (() => undefined))(message, stage);
    run.journal({ stage, event: message });
  };
  let stage = 'pipeline';
  const spend = (pence: number) => {
    run.journal({ stage, event: 'spend', pence });
    run.spend(pence, budget, targetFor(run));
  };

  const flags = stageFlags(deps.stages);
  const skipped = stagesOff(flags);
  const persona = loadPersona(run.manifest.personaId);
  const format = formatForRun(run);
  const book = bizDeps.casebook ?? loadCasebook(persona.id);
  const kind = format.kind;
  run.journal({ stage: 'pipeline', event: 'start', detail: run.manifest.topic });
  assertVoiceUnchanged(persona, deps.tts.name, loadVoiceRegistry());

  // --- 1. The one source ------------------------------------------------------
  let source: Source;
  let subject: string;
  if (run.hasArtifact('corpus') && run.hasArtifact('reference')) {
    source = run.readArtifact('corpus', corpusArtifactSchema).sources[0]!;
    // A RUN MADE BEFORE THIS LANE EXISTED (the first Business Decoded shorts
    // came off the single-story lane) has a reference without the business
    // record. Its source is still in the corpus, so reuse that rather than
    // refusing a run whose script and source are both on disk.
    const rec = run.readArtifact('reference', businessRecordSchema.partial()).business;
    subject = rec?.subject ?? subjectOf(run.manifest.topic);
    say('source')(`reusing ${rec?.title ?? source.title ?? source.url}`);
  } else {
    stage = 'source';
    subject = subjectOf(run.manifest.topic);
    say('source')(`searching for the whole story of "${subject}"`);
    const candidates = await searchStory(subject, book, deps.search, bizDeps.sleep, say('source'));
    const { best, considered } = await pickStorySource(
      candidates,
      subject,
      book,
      kind,
      deps.fetchDeps,
      now()
    );
    for (const c of considered.filter((x) => x.score !== undefined).sort((a, b) => b.score! - a.score!)) {
      say('source')(`${c.score?.toFixed(2)}  ${c.url}  (${c.reason})`);
    }
    if (!best) {
      const reason = `no source told the whole story of "${subject}" well enough for a ${kind === 'short' ? 'short' : 'episode'}`;
      run.abandon(reason);
      throw new Error(`abandoned ${run.id}: ${reason}`);
    }
    source = best.source;
    say('source')(`telling it from ${source.title} (${best.reason})`);

    run.writeArtifact('corpus', {
      sources: [source],
      rejected: considered.filter((c) => c.url !== source.url).map((c) => ({ url: c.url, reason: c.reason })),
    });
    run.markComplete('corpus');
    run.writeArtifact('reference', {
      business: {
        subject,
        url: source.url,
        title: source.title,
        score: best.score,
        reason: best.reason,
        considered,
      },
    });
    run.markComplete('reference');
    run.writeArtifact('claims', {
      claims: [anchorClaim(source, best.text, subject, format.beats[0]!.id)],
      unsupported: [],
    });
    run.markComplete('claims');
    run.writeArtifact('verification', {
      verification: {
        results: [],
        blocking: [],
        costPence: 0,
        verifierModel: 'none: one source, figures and quotations checked against it deterministically',
      },
      counterEvidence: [],
    });
    run.markComplete('verification');
  }
  const text = cleanStoryText(source.text);

  // --- 2. Write the whole story at once --------------------------------------
  let script: Script;
  if (run.hasArtifact('script')) {
    script = run.readArtifact('script', scriptSchema);
    say('script')(`reusing "${script.title}"`);
  } else {
    stage = 'script';
    say('script')(`writing the whole ${kind === 'short' ? 'short' : 'episode'} in one go`);
    const written = await writeBusinessScript(
      {
        persona,
        format,
        subject,
        source: { title: source.title, url: source.url, text },
        readChars: book.readChars[kind],
      },
      deps.writer,
      (draft) => businessDraftProblems(withOutro(draft, persona, format.kind, run.manifest.topic).beats, { source: text, now: now(), kind }),
      spend,
      say('script'),
      flags.scriptRevisions
    );
    script = withOutro(written.script, persona, format.kind, run.manifest.topic);
    run.writeArtifact('script', script);
    run.markComplete('script');
    say('script')(`"${script.title}", about ${Math.round(estimatedSeconds(script))}s read aloud`);
  }

  const priorTexts = deps.priorTexts;
  const gateFor = (durationS: number, measured: boolean) =>
    businessGate({
      persona,
      format,
      script,
      source,
      text,
      durationS,
      measured,
      now: now(),
      priorTexts,
      stagesOff: skipped,
    });

  // --- 3. The approval break --------------------------------------------------
  if (run.awaitingApproval) {
    const held = gateFor(estimatedSeconds(script), false);
    const gate: GateReport = {
      ...held,
      needsHumanReview: true,
      humanReviewReasons: [...held.humanReviewReasons, 'held before the render; approve to voice it.'],
    };
    run.writeArtifact('qa', gate);
    deps.next?.([
      'HELD before the render.',
      `  npm run foundry -- script  --run ${run.id}`,
      `  npm run foundry -- approve --run ${run.id}`,
    ]);
    return { run, script, gate };
  }

  // --- 4. Render --------------------------------------------------------------
  const rendered = run.hasArtifact('render')
    ? run.audioFile(run.readArtifact('render', renderResultSchema).audioFile)
    : null;
  let durationS: number;
  if (rendered) {
    durationS = run.readArtifact('render', renderResultSchema).durationS;
    say('render')(`reusing ${Math.round(durationS)}s of audio`);
  } else {
    stage = 'render';
    const render = await renderScript(
      {
        beats: script.beats,
        voices: Object.fromEntries(persona.hosts.map((h) => [h.id, h.voice])),
        beatPathFor: (name) => run.mediaPath(name),
        outputPath: run.mediaPath('episode.wav'),
        music: musicFor(deps.music, persona, run.manifest.formatId),
        musicPhraseFile: deps.musicPhraseFile,
        musicSeed: run.manifest.topic,
      },
      deps.tts,
      {},
      spend,
      say('render')
    );
    run.writeArtifact('render', render);
    run.markComplete('render');
    durationS = render.durationS;
    say('render')(`${Math.round(durationS)}s`);

    const { registry, recorded } = recordVoices(persona, deps.tts.name, run.id, loadVoiceRegistry());
    if (recorded.length) {
      saveVoiceRegistry(registry);
      for (const r of recorded) {
        say('voice')(`${persona.name} speaks as "${r.voiceId}" on ${deps.tts.name} from now on`);
      }
    }
  }

  // --- 5. Gate ----------------------------------------------------------------
  const gate = gateFor(durationS, true);
  run.writeArtifact('qa', gate);
  run.markComplete('qa');
  run.journal({
    stage: 'pipeline',
    event: gate.passed ? 'done' : 'gate-failed',
    detail: script.title,
    pence: run.manifest.spentPence,
  });
  return { run, script, gate };
};

/** The gate again from disk, for `gate --run`, the studio and publish. */
export const regateBusiness = (run: Run, script: Script, now: Date = new Date()): GateReport | null => {
  try {
    const persona = loadPersona(run.manifest.personaId);
    const format = loadFormat(run.manifest.formatId);
    const source = run.readArtifact('corpus', corpusArtifactSchema).sources[0];
    if (!source) return null;
    const render = run.hasArtifact('render') ? run.readArtifact('render', renderResultSchema) : null;
    return businessGate({
      persona,
      format,
      script,
      source,
      text: cleanStoryText(source.text),
      durationS: render?.durationS ?? estimatedSeconds(script),
      measured: !!render,
      now,
      stagesOff: stagesOff(stageFlags(run.manifest.stages as never)),
    });
  } catch {
    return null;
  }
};
