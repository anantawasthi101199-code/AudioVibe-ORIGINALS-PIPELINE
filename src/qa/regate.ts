/**
 * Run the gate again over what is on disk now.
 *
 * WHY THIS IS SHARED RATHER THAN DUPLICATED. Two callers need it - the `gate`
 * command and the studio's save-and-re-check - and a second copy of "how to
 * assemble a gate input from a run directory" would drift the moment either one
 * gained an argument. It is also the only thing in the repo that answers "would
 * this run still pass" after a check has changed, which is a question asked
 * every time one does.
 *
 * COSTS NOTHING. Everything it needs is already on disk and every check it runs
 * is deterministic arithmetic over the script and the ledger, which is why the
 * command that calls it can be run freely.
 *
 * `gate --run` USED TO PRINT THE STORED REPORT and call it a re-run. It said so
 * in the usage text. So a check changed this morning was invisible until the
 * next full run paid for research and a script to reveal it - and a fever
 * episode was re-gated against a claim floor that had already been lowered.
 */
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { loadFormat } from '../formats/load';
import { Claim, checkLedger, claimSchema } from '../evidence/claim';
import { corpusSchema, counterEvidenceSchema } from '../evidence/research';
import { verificationReportSchema } from '../evidence/verify';
import { renderResultSchema } from '../render/assemble';
import { priorEpisodeTexts } from '../deps';
import { Run } from '../run/store';
import { Script } from '../script/write';
import { GateReport, runGate } from './gate';

export const regate = (run: Run, script: Script): GateReport | null => {
  try {
    const persona = loadPersona(run.manifest.personaId);
    const format = loadFormat(run.manifest.formatId);

    // The repaired claims where there are any, because those are what the
    // script was written from - narrowed, rebound and hedged.
    const claims: Claim[] = run.hasArtifact('repair')
      ? run.readArtifact('repair', z.object({ claims: z.array(claimSchema) })).claims
      : run.hasArtifact('claims')
        ? run.readArtifact('claims', z.object({ claims: z.array(claimSchema) })).claims
        : [];

    if (!claims.length || !run.hasArtifact('verification')) return null;

    const corpus = run.readArtifact('corpus', corpusSchema);
    const stored = run.readArtifact(
      'verification',
      z.object({
        verification: verificationReportSchema,
        counterEvidence: counterEvidenceSchema.default([]),
      })
    );
    const render = run.hasArtifact('render')
      ? run.readArtifact('render', renderResultSchema)
      : null;

    return runGate({
      persona,
      format,
      script,
      claims,
      // RE-CHECKED, NOT REMEMBERED. An edited script can drop the sentence a
      // claim was carrying, and the ledger is the thing that notices.
      ledger: checkLedger(claims, corpus.sources),
      verification: stored.verification,
      // THE STORED SEARCHES, NOT AN EMPTY LIST. Passing none made every
      // contested claim report "no disconfirming search was run for it" - on a
      // run that had done twelve of them. A re-gate that invents failures is
      // worse than one that prints a stale report, because it looks like news.
      counterEvidence: stored.counterEvidence,
      // Zero duration where there is no audio, which reads as a large miss
      // against the format target - correctly, since there is nothing to hear.
      durationS: render?.durationS ?? 0,
      sources: corpus.sources,
      corpusText: corpus.sources.map((src) => src.text).join('\n'),
      castNames: script.plan?.cast.map((c) => c.name) ?? [],
      priorTexts: priorEpisodeTexts(run.id),
    });
  } catch {
    // A gate that cannot run is reported as ABSENT rather than as passing,
    // which would be the most dangerous default available here.
    return null;
  }
};
