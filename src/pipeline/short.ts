/**
 * Cutting a short out of an episode that already exists.
 *
 * WHY THIS IS A SEPARATE PIPELINE AND NOT A FLAG ON THE EPISODE ONE. The two
 * share a name and almost nothing else. `runEpisode` is mostly research: brief,
 * search, corpus, extraction, verification, counter-evidence. A derived short
 * does NONE of that, because doing it again for seventy-five seconds of audio
 * would cost roughly nine times what the short is worth. It inherits the
 * parent's verified facts and spends one call deciding which of them to tell.
 *
 *   Standalone short  ~ £1.10   (research dominates)
 *   Derived short     ~ £0.12   (one selection call, five short beats, render)
 *
 * WHAT THE SHORT RUN STILL WRITES FOR ITSELF. It does not point at the parent's
 * artifacts, it writes its own - narrowed to the claims it actually states, the
 * sources those cite, and the verdicts for those claims. A run is a directory
 * somebody opens when an episode says something wrong, and one that answers
 * "where did that come from" with "read the other directory" has given up the
 * property the whole store exists for. `derivedFrom` on the manifest records
 * the lineage; the narrowed copies make the short answerable on its own.
 *
 * IT STILL PASSES THE FULL GATE. Cheap to produce must not mean cheaply
 * checked. A short is the format most likely to travel beyond the people who
 * chose to follow the show, so it is the one where being wrong costs most.
 */
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { loadFormat } from '../formats/load';
import { episodeBudgetPence } from '../config';
import { checkLedger, Claim, claimSchema } from '../evidence/claim';
import { corpusSchema } from '../evidence/research';
import { Source } from '../evidence/source';
import { verificationReportSchema } from '../evidence/verify';
import { renderResultSchema, renderScript } from '../render/assemble';
import { Script, scriptSchema, writeScript } from '../script/write';
import { redistributeClaims, selectShortAngle, shortSelectionSchema } from '../script/shorts';
import { runGate, GateReport } from '../qa/gate';
import { Run } from '../run/store';
import { PipelineDeps } from './episode';

export interface ShortResult {
  run: Run;
  gate: GateReport;
  script: Script;
}

/** Local join, to avoid importing the whole script module for one line. */
const fullTextOf = (script: Script): string =>
  script.beats.flatMap((b) => b.turns.map((t) => t.text)).join('\n\n');

/**
 * The parent's artifacts, read once and checked for the things that make a
 * short impossible to derive.
 *
 * Fails loudly rather than deriving from half an episode. A short cut from an
 * unverified parent would carry the parent's label and the parent's authority
 * with none of the parent's checking, which is the one way this lane could
 * quietly become the dishonest one.
 */
const readParent = (parent: Run) => {
  if (!parent.isComplete('verification')) {
    throw new Error(
      `run ${parent.id} has not finished verification, so there is nothing checked to derive from. ` +
        `A short inherits its parent's verification; it does not do its own.`
    );
  }
  if (!parent.hasArtifact('script')) {
    throw new Error(`run ${parent.id} has no script to cut a short out of`);
  }

  const script = parent.readArtifact('script', scriptSchema);
  const claimSet = parent.readArtifact('claims', z.object({ claims: z.array(claimSchema) }));
  const corpus = parent.readArtifact('corpus', corpusSchema);
  const { verification } = parent.readArtifact(
    'verification',
    z.object({ verification: verificationReportSchema })
  );

  // Only claims that survived verification are eligible, for the same reason
  // the episode writer never sees a rejected claim: if a rejected claim can
  // reach the writer, the gate becomes the only thing standing between it and
  // a publish, rather than the last of several.
  const eligible = claimSet.claims.filter(
    (c) => !verification.blocking.some((b) => b.claimId === c.id)
  );

  if (!eligible.length) {
    throw new Error(`run ${parent.id} has no verified claims left, so there is no short in it`);
  }

  return { script, eligible, corpus, verification };
};

/**
 * Derive a short from a finished episode, up to and including the gate.
 *
 * Like `runEpisode` this stops at the gate and never publishes, and for the
 * same reason: the two checks the gate hands to a person are exactly the ones
 * an automated pipeline waves through.
 */
export const runShort = async (
  input: { parent: Run; formatId: string },
  deps: PipelineDeps
): Promise<ShortResult> => {
  const log = deps.log ?? (() => undefined);
  const { parent } = input;

  const { script: parentScript, eligible, corpus, verification } = readParent(parent);

  const persona = loadPersona(parent.manifest.personaId);
  const format = loadFormat(input.formatId);

  if (format.kind !== 'short') {
    throw new Error(
      `format "${format.id}" is a ${format.kind} format. runShort derives shorts; ` +
        `use runEpisode for anything else.`
    );
  }

  // Reuse an existing short run for this parent and format rather than making a
  // second one. Otherwise a rerun after a gate failure silently accumulates
  // half-finished shorts, each having paid for its own render.
  const existing = Run.list()
    .map((id) => Run.open(id))
    .find(
      (r) =>
        r.manifest.derivedFrom === parent.id &&
        r.manifest.formatId === format.id &&
        !r.manifest.abandoned
    );

  const run =
    existing ??
    Run.create({
      personaId: parent.manifest.personaId,
      formatId: format.id,
      topic: parent.manifest.topic,
      derivedFrom: parent.id,
    });

  log(existing ? `short: resuming ${run.id}` : `short: ${run.id}, derived from ${parent.id}`);

  const budget = episodeBudgetPence();
  const spend = (pence: number) => run.spend(pence, budget);

  // --- 1. Selection -------------------------------------------------------
  // Stored under `brief` because that is what it is: the plan for this piece of
  // audio. Reusing the stage keeps the run directory readable by anyone who
  // knows the episode one, and keeps the resume logic identical.
  let selection: z.infer<typeof shortSelectionSchema>;
  if (run.hasArtifact('brief')) {
    selection = run.readArtifact('brief', shortSelectionSchema);
    log(`selection: reusing "${selection.angle}"`);
  } else {
    log('selection: finding the one moment worth telling alone');
    selection = await selectShortAngle(parentScript, eligible, deps.writer, spend);
    run.writeArtifact('brief', selection);
    run.markComplete('brief');
    log(`selection: "${selection.angle}" on ${selection.claimIds.length} claim(s)`);
  }

  // --- 2. Inherited evidence, narrowed -----------------------------------
  // The beats that can carry facts, with their floors. The button is excluded
  // entirely: it is the last line landing, and handing it a claim produces a
  // beat that recites rather than lands.
  const factBeats = format.beats
    .filter((b) => b.type !== 'button')
    .map((b) => ({ id: b.id, minClaims: b.minClaims }));
  const claims: Claim[] = redistributeClaims(eligible, selection, factBeats);

  const usedSourceIds = new Set(claims.map((c) => c.sourceId));
  const sources: Source[] = corpus.sources.filter((s) => usedSourceIds.has(s.id));

  // The parent's verdicts, narrowed to the claims this short states.
  //
  // Carried through rather than replaced with an empty report, because the gate
  // reads the verifier's name out of it and an empty one would let a short
  // claim it had been checked by nobody while passing. `blocking` is empty by
  // construction: a blocked claim was never eligible in the first place.
  //
  // costPence is zeroed. The parent already paid for these verdicts and
  // counting them again would double-count the network's spend.
  const shortVerification = {
    ...verification,
    costPence: 0,
    results: verification.results.filter((r) => claims.some((c) => c.id === r.claimId)),
    blocking: [],
  };

  if (!run.hasArtifact('claims')) {
    // `unsupported` is not optional in claimSetSchema, and the publish command
    // reads this artifact through it. Writing the bare `{claims}` shape here
    // made every short unpublishable, which nothing in the short pipeline
    // itself would ever have noticed.
    run.writeArtifact('claims', { claims, unsupported: [] });
    run.markComplete('claims');
  }
  if (!run.hasArtifact('corpus')) {
    run.writeArtifact('corpus', { sources, rejected: [] });
    run.markComplete('corpus');
  }
  if (!run.hasArtifact('verification')) {
    // Narrowed to the claims this short states. Counter-evidence is empty by
    // construction rather than by omission: the gate refuses a contested claim
    // in a short at all, so there is never one here needing the other side.
    run.writeArtifact('verification', {
      verification: shortVerification,
      counterEvidence: [],
    });
    run.markComplete('verification');
  }

  // --- 3. Script ----------------------------------------------------------
  let script: Script;
  if (run.hasArtifact('script')) {
    script = run.readArtifact('script', scriptSchema);
    log(`script: reusing "${script.title}"`);
  } else {
    log('script: writing the short');
    script = await writeScript(
      {
        persona,
        format,
        claims,
        angle: selection.angle,
        isoDate: new Date().toISOString().slice(0, 10),
      },
      deps.writer,
      spend
    );
    run.writeArtifact('script', script);
    run.markComplete('script');
    log(`script: "${script.title}", ${script.beats.length} beats`);
  }

  // --- 4. Render ----------------------------------------------------------
  // The same voices as the parent, because they are the same people. A short in
  // a different voice is a different show, whatever the artwork says.
  let render: z.infer<typeof renderResultSchema>;
  if (run.hasArtifact('render')) {
    render = run.readArtifact('render', renderResultSchema);
    log(`render: reusing ${Math.round(render.durationS)}s of audio`);
  } else {
    log('render: synthesising');
    render = await renderScript(
      {
        beats: script.beats,
        voices: Object.fromEntries(persona.hosts.map((h) => [h.id, h.voice])),
        beatPathFor: (name) => run.mediaPath(name),
        outputPath: run.mediaPath('episode.wav'),
      },
      deps.tts,
      {},
      spend,
      (m) => {
        log(m);
        run.journal({ stage: 'render', event: m });
      }
    );
    run.writeArtifact('render', render);
    run.markComplete('render');
    log(`render: ${Math.round(render.durationS)}s across ${render.beatMap.length} beats`);
  }

  // --- 5. Gate ------------------------------------------------------------
  // The parent's script joins the self-similarity comparison. A short that
  // reuses its parent's sentences is the trailer this lane exists not to be,
  // and nothing else in the pipeline would notice.
  log('gate: checking');
  const gate = runGate({
    persona,
    format,
    script,
    claims,
    ledger: checkLedger(claims, sources),
    verification: shortVerification,
    counterEvidence: [],
    durationS: render.durationS,
    priorTexts: [
      { label: `its parent episode "${parentScript.title}"`, text: fullTextOf(parentScript) },
      ...(deps.priorTexts ?? []),
    ],
  });

  run.writeArtifact('qa', gate);
  run.markComplete('qa');
  log(
    gate.passed
      ? 'gate: passed'
      : `gate: FAILED (${gate.findings.filter((f) => f.blocking).length} blocking)`
  );

  return { run, gate, script };
};
