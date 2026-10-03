/**
 * The pipeline: topic in, published episode out.
 *
 * RESUMABLE BY DESIGN. Every stage checks whether it has already run and skips
 * if so. That is not a nicety - rendering is the expensive step and scripting
 * the slow one, so a QA failure must not mean paying for both again. It also
 * means a run that dies halfway through a fifteen-minute render picks up where
 * it stopped rather than starting over.
 *
 * STOPS AT THE GATE, ALWAYS. `runEpisode` never publishes. Publishing is a
 * separate command a person invokes after reading the gate report, because the
 * two checks the gate defers to a human - has the script acknowledged the
 * counter-evidence, is that T4 source framed as an anecdote - are exactly the
 * ones an automated pipeline would wave through. A studio that publishes
 * without anyone reading the first episodes is the failure mode this whole
 * design exists to avoid.
 */
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import {
  assertVoiceUnchanged,
  loadVoiceRegistry,
  recordVoices,
  saveVoiceRegistry,
} from '../canon/voiceRegistry';
import { loadFormat } from '../formats/load';
import { nominalSeconds } from '../formats/schema';
import { episodeBudgetPence } from '../config';
import {
  OptionalStage,
  StageFlags,
  stageFlags,
  stagesOff,
} from '../config/stages';
import { checkLedger, Claim, claimSchema, locateQuote } from '../evidence/claim';
import { FetchDeps } from '../evidence/fetch';
import {
  Brief,
  briefSchema,
  buildBrief,
  ClaimSet,
  claimSetSchema,
  corpusSchema,
  extractClaims,
  gatherCorpus,
  gatherCounterEvidence,
  counterEvidenceSchema,
  gatherFor,
  storyForBeat,
  concentrateSources,
  enforceSourceTier,
  MAX_SOURCES_PER_SHORT,
} from '../evidence/research';
import { SearchProvider } from '../evidence/search';
import {
  buildReference,
  Reference,
  ReferenceReview,
  reviewReference,
  selectStorySources,
  SOURCE_CHARS_PER_SECOND,
  StoryResearch,
  topUpSelection,
  referenceSchema,
  storyResearchSchema,
} from '../evidence/story';
import { Source } from '../evidence/source';
import {
  BLOCKING_VERDICTS,
  verificationReportSchema,
  verificationSchema,
  verifyAll,
  verifyClaim,
} from '../evidence/verify';
import { repairAll, repairReportSchema } from '../evidence/repair';
import { fillGaps, findGaps, findSequenceGaps } from '../evidence/gaps';
import { GroundingReport, groundingReportSchema, reviewGrounding } from '../qa/grounding';
import { LlmClient } from '../models/client';
import { renderResultSchema, renderScript } from '../render/assemble';
import { TtsProvider } from '../render/tts';
import { checkDistinctStories } from '../script/forward';
import { countWords, measure } from '../script/style';
import { writeScriptOnePass } from '../script/onePass';
import { writeStoryScript } from '../script/storyScript';
import { writeShortScript } from '../script/shortScript';
import {
  CaseFile,
  buildCaseFile,
  caseFileSchema,
  checkCaseFile,
  reviewCaseFile,
} from '../evidence/casefile';
import { writeCaseScript, writeCaseShort } from '../script/caseScript';
import { performScript } from '../script/perform';
import {
  Script,
  WORDS_PER_SECOND,
  beatText,
  fullText,
  scriptProgressSchema,
  scriptSchema,
  writeScript,
} from '../script/write';
import { runGate, GateFinding, GateReport } from '../qa/gate';
import { Run } from '../run/store';

export interface PipelineDeps {
  writer: LlmClient;
  verifier: LlmClient;
  /**
   * A cheap model for mechanical work. See clerkConfig in config/index.ts for
   * the rule governing what may and may not be given to it.
   *
   * Optional, and falls back to the writer. A missing clerk must never be a
   * reason a run does not happen - it is a cost optimisation, not a dependency.
   */
  clerk?: LlmClient;
  /**
   * A cheap first pass over the claims, which may only ever confirm a clean
   * pass and must escalate everything else. See verifyAll.
   *
   * Optional. Without it every claim goes straight to the verifier, which is
   * more expensive and exactly as correct.
   */
  screener?: LlmClient;
  search: SearchProvider;
  tts: TtsProvider;
  fetchDeps: FetchDeps;
  /** Prior episodes to check self-similarity against. */
  priorTexts?: Array<{ label: string; text: string }>;
  /**
   * Mix a synthesised bed under each part. OFF unless true.
   *
   * A toggle, off by default on the owner's instruction. `--music`.
   */
  music?: boolean;
  /**
   * A rendered loop from the beat library, used under every part.
   *
   * Resolved to a path by the caller rather than looked up here, so the
   * pipeline never has to know the library exists. `--bed <name>`.
   */
  musicPhraseFile?: string;
  /**
   * Write the whole script in one call instead of a beat at a time.
   *
   * THE DEFAULT SINCE THE COMPARISON WAS RUN, and the numbers are worth keeping
   * because the trigger for switching was written down in advance. Same show,
   * same topic, same corpus size:
   *
   *   beat by beat  38 of 66 facts used (58%), one fact per 24s, mean sentence
   *                 29.5 words, 26% of sentences past one breath - AND the
   *                 evidence beat, the longest in the format, cited NONE of the
   *                 21 claims researched for it.
   *   one pass      47 of 59 facts used (80%), one fact per 16s, mean sentence
   *                 25.8 words, evenly spread across every beat.
   *
   * The starved beat is the decisive one. Writing a beat at a time, a beat can
   * write around its facts and report none, and nothing notices until the gate.
   * A writer producing the whole script at once distributes the material because
   * it can see all of it.
   *
   * What it gives up: the per-beat critique loop, and any checkpoint inside the
   * write. Set false to go back, which `--beat-by-beat` does.
   */
  onePass?: boolean;
  /**
   * Which optional stages run, overriding the defaults and the environment.
   *
   * See config/stages.ts. Absent means the defaults, which currently have the
   * grounding review OFF.
   */
  stages?: Partial<StageFlags>;
  /**
   * Where a message goes.
   *
   * The stage is passed alongside because the terminal wants to group by it and
   * the pipeline is the only thing that knows. It was already being recorded on
   * the journal entry and thrown away on the way to the screen, which is why
   * every line arrived with its stage spelled out in the text instead.
   */
  log?: (message: string, stage?: string) => void;
  /**
   * What to run next, printed outside any stage.
   *
   * A command somebody is meant to type is not something that happened during
   * the script stage, and printing it inside that stage's box said it was.
   */
  next?: (lines: string[]) => void;
}

export interface EpisodeResult {
  run: Run;
  gate: GateReport;
  script: Script;
}

/**
 * Run every stage up to and including the gate.
 *
 * The budget is checked after each costed call rather than at the end, so a run
 * that overspends stops at the call that overspent instead of after paying for
 * everything.
 */
export const runEpisode = async (run: Run, deps: PipelineDeps): Promise<EpisodeResult> => {
  const budget = episodeBudgetPence();

  // EVERY LINE THE PIPELINE PRINTS ALSO GOES TO THE RUN'S JOURNAL. A run that
  // dies leaves a journal ending exactly where it died, which is the single
  // most useful artifact for working out what happened - and it is readable
  // with `tail -f` while the run is still going.
  const say = (stage: string) => (message: string) => {
    (deps.log ?? (() => undefined))(message, stage);
    run.journal({ stage, event: message });
  };
  const log = say('pipeline');

  // A message and the stage it belongs to, so the terminal can group them and
  // the journal records the stage rather than repeating it inside the text.
  const report = (stage: string, message: string) => say(stage)(message);

  // Spend is journalled per call rather than only totalled, so "where did the
  // money go" is answerable after the fact rather than only in aggregate.
  let stage = 'pipeline';
  const spend = (pence: number) => {
    run.journal({ stage, event: 'spend', pence });
    run.spend(pence, budget);
  };

  // WHICH OPTIONAL PASSES RUN, decided once and recorded, because a run that
  // skipped a safety pass must carry that fact rather than look like one that
  // passed it. See config/stages.ts.
  const flags = stageFlags(deps.stages);
  const skipped = stagesOff(flags);
  const runs = (s: OptionalStage): boolean => flags[s];

  run.journal({ stage: 'pipeline', event: 'start', detail: run.manifest.topic });
  if (skipped.length) {
    report('pipeline', `stages OFF for this run: ${skipped.join(', ')}`);
    run.journal({ stage: 'pipeline', event: 'stages-off', detail: skipped.join(', ') });
  }

  const persona = loadPersona(run.manifest.personaId);
  const format = loadFormat(run.manifest.formatId);

  // BEFORE ANY MODEL CALL. A channel whose voice has changed under it is a
  // different show to everybody following it, and finding that out after paying
  // for research, a script and audio is finding it out too late. See
  // canon/voiceRegistry.ts.
  assertVoiceUnchanged(persona, deps.tts.name, loadVoiceRegistry());

  // --- 1. Brief -----------------------------------------------------------
  let brief: Brief;
  const researchMode = run.manifest.research ?? format.research;
  const singleStory = researchMode === 'single';
  /**
   * The true crime lane: one document, read whole, turned into a chronology.
   *
   * SHARES THE SELECTION WITH `single` AND NOTHING ELSE. Both need the same
   * thing first - the one document that actually carries the story, rather than
   * fourteen partial views of it - and after that they diverge completely: a
   * myth gets a fused reference article, a case gets a dated case file with
   * every event marked established, alleged or disputed.
   */
  const caseLane = researchMode === 'casefile';
  /** Either lane that reads documents whole instead of building a claim ledger. */
  const oneDocLane = singleStory || caseLane;

  if (run.hasArtifact('brief')) {
    brief = run.readArtifact('brief', briefSchema);
    report('brief', `reusing "${brief.angle}"`);
  } else {
    stage = 'brief';

    // A NAMED CASE IS ALREADY ITS OWN SEARCH QUERY, so a short does not pay a
    // model to invent one. The brief exists to narrow a broad subject to an
    // angle and turn it into queries; "The murder of Julia Wallace, Liverpool
    // 1931" is both already, and asking a model to rephrase it returned the
    // topic with different words for two pence.
    //
    // ONLY ON A SHORT. An episode has a pound to spend and a real brief is
    // worth two pence of it, because a fifteen-minute case does benefit from
    // queries aimed at the investigation and the aftermath separately.
    if (caseLane && format.kind === 'short') {
      brief = {
        angle: run.manifest.topic,
        mustEstablish: ['who it happened to', 'what happened', 'how it ended'],
        queries: [run.manifest.topic, `${run.manifest.topic} case`],
        // EMPTY, AND IT IS HONEST. This field exists for the counter-evidence
        // pass to aim at, that pass does not run on this lane, and guessing
        // what is contested without having read anything would be worse than
        // saying nothing. The case file marks what is actually disputed, from
        // the document.
        likelyContested: [],
      };
      run.writeArtifact('brief', brief);
      run.markComplete('brief');
      report('brief', 'the case is its own query, so no brief was paid for');
    } else {
      log('brief: planning the research');
      brief = await buildBrief(run.manifest.topic, persona, format, deps.writer, spend);
      run.writeArtifact('brief', brief);
      run.markComplete('brief');
      report('brief', `"${brief.angle}" with ${brief.queries.length} queries`);
    }
  }

  // --- 2. Corpus ----------------------------------------------------------
  let corpus: { sources: Source[]; rejected: Array<{ url: string; reason: string }> };
  if (run.hasArtifact('corpus')) {
    corpus = run.readArtifact('corpus', corpusSchema);
    report('corpus', `reusing ${corpus.sources.length} documents already fetched`);
  } else {
    stage = 'corpus';
    log('corpus: searching and fetching');
    corpus = await gatherCorpus(brief.queries, deps.search, deps.fetchDeps, gatherFor(format));
    run.writeArtifact('corpus', corpus);
    run.markComplete('corpus');
    report('corpus', `${corpus.sources.length} sources, ${corpus.rejected.length} rejected`);
  }

  // A corpus this thin cannot support an episode, and going on would produce a
  // script whose claims are all drawn from three documents. Abandoning here is
  // cheaper than discovering it at the gate.
  if (corpus.sources.length < 4) {
    const reason =
      `only ${corpus.sources.length} usable sources. ` +
      `Rejections: ${corpus.rejected.slice(0, 5).map((r) => r.reason).join('; ') || 'none'}`;
    run.abandon(reason);
    throw new Error(`abandoned ${run.id}: ${reason}`);
  }

  // WHICH LANE THIS EPISODE IS ON.
  //
  // `extensive` is everything below: claims bound to verbatim quotes, verified
  // against a different model family, repaired, gap-filled and concentrated.
  // `single` skips all of it and reads one to three documents whole instead,
  // fusing them into a reference article. See evidence/story.ts for the run
  // that forced the second lane to exist and the arithmetic behind it.
  //
  // THE RUN'S OVERRIDE WINS, AND IT IS ON THE MANIFEST RATHER THAN IN A FLAG
  // READ EACH TIME, so a resume continues the way the run started instead of
  // switching lanes halfway through an episode.
  if (run.manifest.research && run.manifest.research !== format.research) {
    report(
      'pipeline',
      `researching as "${researchMode}", overriding the "${format.research}" this format asks for`
    );
  }

  // DECLARED OUT HERE BECAUSE BOTH LANES REACH THE SAME GATE. On the single
  // lane these stay empty, which is not a gap being papered over: the gate is
  // told `evidence: 'reference'` and skips the sections that would read an
  // empty ledger as a failing one.
  let workingClaims: Claim[] = [];
  let verification: z.infer<typeof verificationReportSchema> = {
    results: [],
    blocking: [],
    costPence: 0,
    verifierModel: '',
  };
  let counterEvidence: z.infer<typeof counterEvidenceSchema> = [];

  // --- 3s. The single-story lane: select, then fuse. ------------------------
  //
  // REPLACES STAGES 3 AND 4 ENTIRELY. No claim extraction, no verification, no
  // repair, no gap-filling and no counter-evidence - one selection call and one
  // fusion call, against documents read at sixty thousand characters each
  // rather than six.
  let reference: Reference | undefined;
  let referenceReview: ReferenceReview | undefined;
  let shortArticle: Source | undefined;
  let caseFile: CaseFile | undefined;

  if (oneDocLane) {
    // THE CASE FILE IS ITS OWN ARTIFACT AND ITS OWN STAGE, so a resumed run
    // reads it back rather than paying thirty pence to build it a second time.
    if (caseLane && run.hasArtifact('casefile')) {
      caseFile = run.readArtifact('casefile', caseFileSchema);
      report('reference', `reusing the case file: ${caseFile.chronology.length} dated event(s)`);
    }

    let stored: StoryResearch | undefined;
    if (run.hasArtifact('reference')) {
      stored = run.readArtifact('reference', storyResearchSchema);
      report('reference', `reusing the reference built from ${stored.selection.chosen.length} document(s)`);
    } else {
      stage = 'reference';

      log('reference: choosing the documents that carry the story');
      const selection = await selectStorySources(
        run.manifest.topic,
        corpus.sources,
        // THE CLERK IS NOT ALLOWED THIS. Choosing which documents an episode is
        // built from decides what the episode can know, and clerkConfig's rule
        // is that the cheap model may only do work something other than a model
        // checks. Nothing checks this.
        deps.writer,
        spend,
        say('reference'),
        // ONE DOCUMENT ON THE CASE LANE. It reads only the first anyway, so
        // picking three meant paying to reason about two the episode never
        // opened and logging "using" them, which was untrue.
        caseLane ? 1 : undefined
      );

      // ENOUGH OF IT, NOT JUST THE RIGHT ONE. The selector judges which document
      // tells the story and is good at it; it has no sense of whether there is
      // enough there to fill the episode, and it once chose 13,191 characters
      // for a fifteen-minute slot. See topUpSelection.
      //
      // NOT ON THE CASE LANE, AND THE FIRST RUN THAT NEEDED IT SHOWED WHY. The
      // Croydon poisonings had one good 13,500-character account and a corpus
      // otherwise full of general arsenic toxicology, so topping up added a
      // toxicology page to reach the length. That lane reads only the first
      // document, so the page would never have been opened - but it was logged
      // as "using", which was untrue, and on a lane where the whole premise is
      // one source it is exactly the wrong repair.
      //
      // A thin source is a REAL FINDING here rather than a shortfall to pad.
      // It means this case has not been reported properly in one place, which
      // is the thing that decides whether it belongs in this format at all.
      if (caseLane) {
        const chars = selection.chosen[0]?.text.length ?? 0;
        const wanted = nominalSeconds(format) * SOURCE_CHARS_PER_SECOND;
        if (chars < wanted) {
          report(
            'reference',
            `the one document is ${chars.toLocaleString()} characters and this format wants ` +
              `about ${wanted.toLocaleString()}. Nothing was added to make up the difference, ` +
              `because this lane reads one source. Expect a thin episode, or tell it as a short.`
          );
        }
      } else {
        const sized = topUpSelection(
          selection.chosen,
          corpus.sources,
          nominalSeconds(format)
        );
        for (const extra of sized.added) {
          report(
            'reference',
            `the chosen document(s) are too thin for ${Math.round(nominalSeconds(format) / 60)} ` +
              `minutes, so ${extra.title} was added as well`
          );
        }
        selection.chosen = sized.chosen;
      }

      for (const source of selection.chosen) {
        report(
          'reference',
          `using ${source.title} (${source.tier}, ${source.text.length.toLocaleString()} chars)`
        );
      }
      const passedOver = corpus.sources.length - selection.chosen.length;
      if (passedOver > 0) {
        report(
          'reference',
          `passed over ${passedOver} other document(s): ${selection.reasoning || 'no reason given'}`
        );
      }

      // A SHORT SKIPS THE FUSION ENTIRELY, WHICH IS THE WHOLE COST ARGUMENT.
      //
      // The fusion measured 42p. A three-minute short has a budget of about
      // fourteen, so it is three times the whole thing - and with one document
      // there is nothing to fuse anyway. The article goes straight to the
      // writer and the script comes back in one call. See script/shortScript.ts
      // for what that gives up.
      if (format.kind === 'short') {
        const one = selection.chosen[0]!;
        stored = {
          selection: {
            chosen: [one.id],
            reasoning: selection.reasoning,
            fellBack: selection.fellBack,
            notUsed: corpus.sources
              .filter((src) => src.id !== one.id)
              .map((src) => ({ id: src.id, title: src.title })),
          },
          article: { id: one.id, title: one.title, url: one.url, chars: one.text.length },
          review: {
            unanswered: [],
            unsupported: [],
            checked: false,
            failure: 'a short has no reference to check - it is written from the article itself',
          },
        };
        run.writeArtifact('reference', stored);
        run.markComplete('reference');
        report('reference', `writing the short straight from ${one.title}, no fusion step`);
      } else {

      // CHECKPOINTED, BECAUSE IT IS THE MOST EXPENSIVE CALL ON THIS LANE. The
      // fusion reads three documents at a hundred thousand characters each -
      // roughly seventy-five thousand input tokens - and the review that runs
      // straight after it reads the same documents again. A run that dies
      // between the two (a budget ceiling is the likely way, since the review
      // is the single largest line on the estimate) would otherwise pay for
      // THE CASE LANE STOPS HERE AND BUILDS SOMETHING ELSE.
      //
      // One document, not two or three: the owner's instruction, and the right
      // one for a case. Fusing two accounts of a myth resolves a disagreement
      // about a story; fusing two accounts of a crime resolves a disagreement
      // about what a real person did, which is not a thing to do quietly.
      //
      // A SHORT NEVER REACHES HERE. The branch above has already stored its one
      // article and gone straight to the writer, because building a case file
      // is about thirty pence against a short's whole budget of ten.
      if (caseLane) {
        let file = run.readCheckpoint('casefile', caseFileSchema);
        if (file) {
          report('reference', 'reusing the case file from a run that stopped after it');
        } else {
          log('reference: reading the document and setting down the case');
          file = await buildCaseFile(
            {
              topic: run.manifest.topic,
              source: selection.chosen[0]!,
              targetSeconds: (format.targetSeconds[0] + format.targetSeconds[1]) / 2,
            },
            deps.writer,
            spend
          );
          // CHECKPOINTED IMMEDIATELY. This is the expensive call on the lane,
          // and a crash after it used to mean paying for it twice.
          run.writeCheckpoint('casefile', file);
        }

        caseFile = file;

        report(
          'reference',
          `${file.chronology.length} dated event(s), ${file.cast.filter((c) => c.carry).length} ` +
            `name(s) to carry, ended ${file.outcome.status}`
        );

        // FREE, AND EVERY ONE IS A REAL FAILURE OF THIS LANE rather than a
        // tidiness check. A case file with no victim is a file about whoever
        // did it, which is the thing the whole lane is written against.
        for (const problem of checkCaseFile(file)) report('reference', `  ${problem}`);

        if (file.contested.length) {
          report(
            'reference',
            `${file.contested.length} contested claim(s), shown to the writer to be attributed ` +
              `rather than hidden from it. These are real people.`
          );
        }

        // THE ONE PAID CHECK ON THIS LANE, and the one most worth turning on.
        //
        // `checked: false` is not a formality. It is what the gate reads to
        // fail closed, and it is the difference between "nothing was found"
        // and "nobody looked". On a lane about real people those are very
        // different states. See config/stages.ts.
        if (runs('referenceCheck')) {
          log('reference: checking the case file against the document it came from');
          const review = await reviewCaseFile(
            { file, source: selection.chosen[0]! },
            // THE VERIFIER, NOT THE WRITER, and here that matters more than
            // anywhere else in the studio: a checker sharing the builder's
            // priors reconstructs its reasoning instead of reading the
            // document, and a plausible-sounding case is exactly what the
            // builder is good at producing.
            deps.verifier,
            spend
          );

          for (const line of review.invented) {
            report('reference', `NOT IN THE DOCUMENT: ${line}`);
          }
          for (const line of review.overstated) {
            report('reference', `stated as established, but attributed in the source: ${line}`);
          }
          for (const line of review.missing) {
            report('reference', `the document establishes this and the file dropped it: ${line}`);
          }
          if (review.checked && !review.invented.length && !review.overstated.length) {
            report('reference', 'nothing in the file goes beyond the document');
          }
          if (!review.checked) {
            report('reference', `the check could not run: ${review.failure ?? 'unknown'}`);
          }

          referenceReview = {
            unanswered: review.missing,
            unsupported: [...review.invented, ...review.overstated],
            checked: review.checked,
            failure: review.failure,
          };
        } else {
          report(
            'reference',
            'the case file check is OFF, so nothing has verified this against its own ' +
              'source. On a lane about real people that is the check worth paying for: ' +
              '--reference-check.'
          );
        }

        run.writeArtifact('casefile', file);
        run.markComplete('casefile');
        run.clearCheckpoint('casefile');
      }

      // THE FUSION, WHICH THE CASE LANE DOES NOT DO. Two accounts of a myth
      // fused resolves a disagreement about a story. Two accounts of a crime
      // fused resolves a disagreement about what a real person did.
      if (!caseLane) {
      // the fusion twice. Same reason the claims stage checkpoints per chunk.
      let built = run.readCheckpoint('reference', referenceSchema);
      if (built) {
        report('reference', 'reusing the article from a run that stopped before the check');
      } else {
        log('reference: reading them whole and writing one article from them');
        built = await buildReference(
          { topic: run.manifest.topic, sources: selection.chosen, format, angle: brief.angle },
          deps.writer,
          spend
        );
        run.writeCheckpoint('reference', built);
      }
      report(
        'reference',
        `${built.sections.length} sections, ${built.cast.length} named, ` +
          `${built.glossary.length} thing(s) to explain`
      );
      if (built.variants.length) {
        report(
          'reference',
          `${built.variants.length} disagreement(s) between the documents, decided here and ` +
            `kept out of the script. They are in reference.json if you want to check them.`
        );
      }

      // THE ONE PAID CHECK ON THIS LANE, AND IT IS OFF BY DEFAULT.
      //
      // `checked: false` is not a formality here. It is the same shape the
      // review returns when it fails, it is what the gate reads to fail
      // closed, and it is the difference between "nothing was found" and
      // "nobody looked". A skipped check must never be able to read as a
      // clean one. See config/stages.ts.
      let review: ReferenceReview = {
        unanswered: [],
        unsupported: [],
        checked: false,
        failure: 'the reference check was switched off for this run',
      };

      if (runs('referenceCheck')) {
        log('reference: checking it against the documents it came from');
        review = await reviewReference(
          { reference: built, sources: selection.chosen },
          deps.verifier,
          spend
        );
        for (const question of review.unanswered) {
          report('reference', `the sources answer this and the article did not carry it: ${question}`);
        }
      } else {
        report(
          'reference',
          'the reference check is OFF, so nothing has verified the story this script ' +
            'is written from. Turn it on with --reference-check.'
        );
      }

      const chosenIds = new Set(selection.chosen.map((s) => s.id));
      stored = {
        selection: {
          chosen: selection.chosen.map((s) => s.id),
          reasoning: selection.reasoning,
          fellBack: selection.fellBack,
          notUsed: corpus.sources
            .filter((s) => !chosenIds.has(s.id))
            .map((s) => ({ id: s.id, title: s.title })),
        },
        reference: built,
        review,
      };
      run.writeArtifact('reference', stored);
      run.markComplete('reference');
      // The checkpoint has served its purpose the moment the artifact exists.
      run.clearCheckpoint('reference');
      }
      }
    }

    // ALL OPTIONAL, because a case-lane episode never writes this artifact: it
    // has a case file instead, and `stored` stays undefined for it.
    reference = stored?.reference;
    // ONLY FROM `stored`, WHICH THE CASE LANE NEVER WRITES. Without the guard
    // this line ran after the case review had already been assigned above and
    // set it back to undefined, which the gate reads as "nobody looked".
    referenceReview = stored?.review ?? referenceReview;
    // The article a short was written from, re-read so a resumed run does not
    // have to fetch or choose again.
    shortArticle = stored?.article
      ? corpus.sources.find((src) => src.id === stored!.article!.id)
      : shortArticle;
  }

  if (!oneDocLane) {
    // --- 3. Claims ----------------------------------------------------------
    let claimSet: ClaimSet;
    if (run.hasArtifact('claims')) {
      claimSet = run.readArtifact('claims', claimSetSchema);
      report('claims', `reusing ${claimSet.claims.length} claims already bound`);
    } else {
      stage = 'claims';
      log('claims: extracting and binding to quotes');
      claimSet = await extractClaims(
        brief,
        corpus,
        format,
        deps.writer,
        spend,
        say('claims'),
        // Chunk-level checkpointing, for the same reason beats have it: each
        // chunk is thousands of tokens over a corpus that had to be searched and
        // fetched first, and a real run lost three of four to the fourth coming
        // back in an unexpected shape.
        {
          done: run.readCheckpoint('claims', z.array(claimSetSchema)) ?? [],
          save: (done) => run.writeCheckpoint('claims', done),
        }
      );
      run.writeArtifact('claims', claimSet);
      run.markComplete('claims');
      run.clearCheckpoint('claims');
      report('claims', `${claimSet.claims.length} bound, ${claimSet.unsupported.length} unsupported`);
    }

    const claims: Claim[] = claimSet.claims.map((c) => claimSchema.parse(c));

    // --- 4. Verification + counter-evidence ---------------------------------
    // DEFAULTS TO NONE, because the counter-evidence pass is optional and "nothing
    // was found against these claims" and "nobody looked" have to be the same shape
    // here. The gate is told which stages were off, and says so separately.

    if (run.hasArtifact('verification')) {
      const stored = run.readArtifact(
        'verification',
        z.object({ verification: verificationReportSchema, counterEvidence: counterEvidenceSchema })
      );
      verification = stored.verification;
      counterEvidence = stored.counterEvidence;
      report('verification', `reusing, ${verification.blocking.length} claim(s) still blocking`);
    } else {
      stage = 'verification';
      log('verification: checking every claim against its quote');
      verification = await verifyAll(
        claims,
        corpus.sources,
        deps.verifier,
        spend,
        deps.screener,
        say('verification'),
        // Per-claim, because this is the slowest stage whenever a rate limit is
        // tight: thirty-five claims at three requests a minute is twelve
        // minutes, and losing that to a failure on the last one is the most
        // expensive kind of waste in the pipeline.
        {
          done: run.readCheckpoint('verification', z.record(verificationSchema)) ?? {},
          save: (d) => run.writeCheckpoint('verification', d),
        }
      );

      if (runs('counterEvidence')) {
        log('verification: searching for evidence against contested claims');
        // The clerk writes these queries. It is generating search strings from a
        // claim, and a weak one simply finds nothing - the failure is visible and
        // cheap. Everything downstream of the search is unchanged.
        counterEvidence = await gatherCounterEvidence(
          claims,
          deps.search,
          deps.fetchDeps,
          deps.clerk ?? deps.writer,
          {},
          spend
        );
      } else {
        log('verification: counter-evidence is OFF, so no contested claim was challenged');
      }

      run.writeArtifact('verification', { verification, counterEvidence });
      run.markComplete('verification');
      run.clearCheckpoint('verification');
      log(
        `verification: ${verification.blocking.length} blocking, ` +
          `${counterEvidence.filter((c) => c.sources.length).length} contested claims with counter-sources`
      );
    }

    // --- 4c. Repair ---------------------------------------------------------
    //
    // A CLAIM THAT SAYS MORE THAN ITS QUOTE USED TO BE DELETED, AND THE FACT WENT
    // WITH IT. One episode named six men and gave sentences for two, because the
    // claim carrying the other four said "Collins, Jones and Perkins each got
    // seven years" against a quote saying "three ringleaders each received seven
    // years". The seven years was solid; the names were the extractor filling in
    // from context. Binning it lost both.
    //
    // Narrow, then rebind, then keep it with a hedge the script has to say out
    // loud. See evidence/repair.ts for why the third route is honest rather than
    // a loophole - and section 7a of the gate for what stops it becoming one.
    workingClaims = claims;
    if (run.hasArtifact('repair')) {
      const stored = run.readArtifact(
        'repair',
        z.object({ claims: z.array(claimSchema), report: repairReportSchema })
      );
      workingClaims = stored.claims;
      report('repair', `reusing, ${stored.report.repaired.length} claim(s) repaired`);
    } else {
      stage = 'repair';
      // BOTH KINDS OF FAILURE GO THROUGH THE SAME REPAIR, which is the point of
      // doing it here rather than inside the verifier. The semantic failures come
      // from verification ("says more than the quote"); the structural ones come
      // from the ledger ("typed as a quotation but its wording does not appear in
      // the quote", "typed as a statistic but states no number").
      //
      // They look different and they are the same fault: a claim describing
      // itself as more than it is. Narrowing returns a corrected TYPE as well as
      // corrected text, so the one pass fixes both - and a run that fixed the
      // semantics while still failing the shape would have gained nothing.
      const semantic = verification.results.filter((v) => BLOCKING_VERDICTS.includes(v.verdict));

      // THE FREE CHECK, FED IN HERE RATHER THAN LEFT TO THE GATE.
      //
      // `checkLedger` proves deterministically that a cited quote occurs in the
      // document it names. That is the anti-fabrication guarantee, it costs
      // nothing, and it was only being consulted at the gate - which is AFTER the
      // render. A fever episode paid 29p to voice a script containing three
      // claims whose quotes appear in no document, and the first anybody heard of
      // it was a gate report about audio that already existed.
      //
      // A missing quote and a missing source are both `unsourced`: there is no
      // passage to read, so rebind if the corpus holds one and otherwise drop.
      // Shape problems - typed as a statistic with no number in it - are the
      // wording category and no longer block anything, so they are not sent here
      // at all; they surface at the gate for the person reading the script.
      const structural = checkLedger(claims, corpus.sources)
        .problems.filter((p) => p.kind === 'quote_not_in_source' || p.kind === 'missing_source')
        .map((p) => ({
          claimId: p.claimId,
          verdict: 'unsourced' as const,
          reason: p.detail,
        }));

      // One repair per claim. A claim that failed both ways is narrowed once
      // against the more specific complaint, because two passes would mean the
      // second one narrowing the first one's output against a stale reason.
      const seen = new Set(semantic.map((v) => v.claimId));
      const failing = [...semantic, ...structural.filter((v) => !seen.has(v.claimId))];

      if (failing.length) {
        report('repair', `${failing.length} claim(s) their sources will not carry`);
        const repaired = await repairAll(claims, failing, {
          sources: corpus.sources,
          // The CLERK narrows. It is subtraction against a complaint that has
          // already been written by the verifier, with a deterministic re-check
          // after it - which is exactly the shape of work the clerk rule allows.
          narrower: deps.clerk ?? deps.writer,
          // Re-checked by the same verifier that rejected it. A repair judged by
          // a softer standard than the rejection would mean nothing.
          reverify: async (claim) => {
            const source = corpus.sources.find((src) => src.id === claim.sourceId);
            if (!source) {
              return {
                claimId: claim.id,
                verdict: 'not_entailed' as const,
                reason: 'its source is not in the corpus',
              };
            }
            const { verification: v, costPence } = await verifyClaim(claim, source, deps.verifier);
            spend(costPence);
            return v;
          },
          onCost: spend,
          onProgress: say('repair'),
        });
        workingClaims = repaired.claims;
        run.writeArtifact('repair', repaired);

        const counts = repaired.report.repaired.reduce<Record<string, number>>((acc, r) => {
          acc[r.method] = (acc[r.method] ?? 0) + 1;
          return acc;
        }, {});
        log(
          `repair: ${counts.narrowed ?? 0} narrowed, ${counts.rebound ?? 0} rebound, ` +
            `${counts.unverified ?? 0} kept as unsettled`
        );
      } else {
        run.writeArtifact('repair', { claims, report: { repaired: [], costPence: 0 } });
      }
      // --- 4d. Go back for the names nobody placed. ---
      //
      // Extraction runs once, against a beat sheet, before anyone knows which
      // names the episode will lean on. It reliably produces a claim saying
      // Arnold Paole was bothering people at night and none saying who he was,
      // and by the time that matters the evidence stage is over - leaving the
      // writer a choice between saying a name it cannot place and dropping him.
      //
      // Nearly free, because the corpus is already on disk. No search, no fetch:
      // BM25 finds the passage that talks about the name, one cheap call reads
      // it, and the claim it produces is verified exactly like every other.
      // TWO KINDS OF HOLE, FILLED BY ONE MECHANISM. A name the claims lean on and
      // never introduce, and a counted sequence the claims summarised instead of
      // giving. Both are specific, findable and fixable from the corpus already on
      // disk, which is the whole test for belonging here.
      const nameGaps = runs('gaps') ? findGaps(workingClaims) : [];
      const sequenceGaps = runs('gaps') ? findSequenceGaps(workingClaims) : [];
      const gaps = [...nameGaps, ...sequenceGaps];
      if (gaps.length) {
        report(
          'gaps',
          [
            nameGaps.length ? `${nameGaps.length} name(s) the claims never introduce` : '',
            sequenceGaps.length ? `${sequenceGaps.length} summarised sequence(s)` : '',
          ]
            .filter(Boolean)
            .join(', ')
        );
        const found = await fillGaps(
          gaps,
          {
            sources: corpus.sources,
            // The clerk reads one passage for one fact against a deterministic
            // quote check and a verifier afterwards, which is exactly the shape
            // of work the clerk rule allows.
            model: deps.clerk ?? deps.writer,
            verify: async (candidate) => {
              const source = corpus.sources.find((src) => src.id === candidate.sourceId);
              if (!source) return false;
              if (!locateQuote(source.text, candidate.quote).found) return false;
              const { verification: v, costPence } = await verifyClaim(
                candidate,
                source,
                deps.verifier
              );
              spend(costPence);
              return v.verdict === 'entailed';
            },
            onCost: spend,
            onProgress: say('gaps'),
          },
          // Attached to the beat that introduces people, so the density floors
          // see them where a listener would meet them.
          format.beats[1]?.id ?? format.beats[0]!.id,
          1
        );

        if (found.length) {
          workingClaims = [...workingClaims, ...found];
          report('gaps', `filled ${found.length} of ${gaps.length}`);
          run.writeArtifact('repair', {
            claims: workingClaims,
            report: { repaired: [], costPence: 0 },
          });
        }
      }

      run.markComplete('repair');
    }

    // --- 4b2. The show's own evidence policy, applied before the writer. ---
    //
    // The Root Health will not rest a claim on a source weaker than T2, and that
    // was only checked at the gate - after the script and after the audio. A
    // fever episode was written around a Wikipedia article, voiced, and then told
    // it could not be. The rule is free to apply and was being applied too late
    // to save anything.
    if (persona.minSourceTier) {
      const allowed = enforceSourceTier(workingClaims, corpus.sources, persona.minSourceTier);

      if (allowed.dropped.length) {
        report(
          'repair',
          `dropped ${allowed.dropped.length} claim(s) resting on sources below ` +
            `${persona.minSourceTier}, which ${persona.name} will not stand behind`
        );
      }
      workingClaims = allowed.claims;
    }

    // --- 4c. One story, one or two documents. ---------------------------------
    //
    // SHORT FORMATS ONLY, and it is about flow rather than about evidence. A
    // ninety-second story stitched from four documents is a compilation - four
    // writers' emphases, four sets of names for the same people, four points
    // where the register changes - and a listener hears that as the thing jumping
    // around. On a real ten-story set the story built from two sources was the
    // best in it and the story built from four was the worst, and a listener
    // named both without being told which was which.
    //
    // A long episode is the opposite case and is untouched: assembling what
    // fourteen documents separately establish is the whole point of the factual
    // lane, and breadth there is the product rather than a seam.
    if (format.sourceOnly || format.kind === 'short') {
      const concentrated = concentrateSources(workingClaims, corpus.sources);

      if (concentrated.dropped.length) {
        const facts = concentrated.dropped.reduce((n, d) => n + d.claims, 0);
        report(
          'repair',
          `kept each story to its ${MAX_SOURCES_PER_SHORT} main sources, which cost ${facts} fact(s) ` +
            `from ${concentrated.dropped.length} further document(s)`
        );
      }
      workingClaims = concentrated.claims;
    }
  }

  // --- 5. Script ----------------------------------------------------------
  let script: Script;
  if (run.hasArtifact('script')) {
    script = run.readArtifact('script', scriptSchema);
    report('script', `reusing "${script.title}"`);
  } else {
    stage = 'script';
    // THE CLAIMS ARE THE SAME EITHER WAY, and so are the checks. The only thing
    // that differs between these two is whether the beats are written in one
    // call or in eleven, which is the whole point of being able to compare them.
    const scriptInput = {
      persona,
      format,
      // THE REPAIRED CLAIMS, WHICH IS THE POINT OF THE REPAIR STAGE. This used
      // to filter out everything the verifier rejected, which is how an episode
      // lost four of its six sentences: the claim was dropped, and the fact
      // inside it went too.
      //
      // What reaches the writer now is the narrowed version where narrowing
      // worked, the rebound version where the corpus supported it elsewhere,
      // and the unsettled version - marked, with the words that must be said
      // about it - where neither did. A contradicted claim is not here at all;
      // repairAll drops those.
      claims: workingClaims,
      angle: brief.angle,
      isoDate: new Date().toISOString().slice(0, 10),
      // WHICH OF THE TEN EACH BEAT IS. Only an anthology has these, and
      // without them ten beats expanded from one definition are
      // indistinguishable to everything downstream of the brief.
      subjects: format.beats.map((_, i) => storyForBeat(brief, format, i)),
    };

    if (caseLane && format.kind === 'short') {
      // ONE ARTICLE, ONE CALL, NO CASE FILE. See script/caseScript.ts for what
      // that gives up: nothing has separated established from alleged before
      // the writer sees the article.
      if (!shortArticle) throw new Error('short reached the writer with no article');
      log('script: writing the case short straight from the article');
      script = await writeCaseShort(
        {
          persona,
          format,
          article: {
            title: shortArticle.title,
            url: shortArticle.url,
            text: shortArticle.text,
          },
          topic: run.manifest.topic,
          isoDate: new Date().toISOString().slice(0, 10),
        },
        deps.writer,
        spend,
        say('script')
      );
    } else if (caseLane) {
      if (!caseFile) throw new Error('the case reached the writer with no case file');
      log('script: telling the case from the file');
      script = await writeCaseScript(
        {
          persona,
          format,
          file: caseFile,
          topic: run.manifest.topic,
          isoDate: new Date().toISOString().slice(0, 10),
        },
        deps.writer,
        spend,
        say('script')
      );
    } else if (singleStory && format.kind === 'short') {
      // ONE ARTICLE, ONE CALL, NO REFERENCE. See script/shortScript.ts.
      if (!shortArticle) throw new Error('short reached the writer with no article');
      log('script: writing the short straight from the article');
      script = await writeShortScript(
        {
          persona,
          format,
          article: {
            title: shortArticle.title,
            url: shortArticle.url,
            text: shortArticle.text,
          },
          topic: run.manifest.topic,
          isoDate: new Date().toISOString().slice(0, 10),
        },
        deps.writer,
        spend,
        say('script'),
        runs('scriptRevisions')
      );
    } else if (singleStory) {
      // ONE STORY, ONE REFERENCE, ONE PASS. There is no beat-by-beat option on
      // this lane and there should not be: the whole argument for the single
      // story is that one mind holds the whole thing at once, and writing it
      // in five separate calls would put the collage back in at the last step.
      if (!reference) throw new Error('single-story lane reached the writer with no reference');
      log('script: telling the story from the reference');
      script = await writeStoryScript(
        {
          persona,
          format,
          reference,
          angle: brief.angle,
          isoDate: new Date().toISOString().slice(0, 10),
        },
        deps.writer,
        spend,
        {
          progress: run.readCheckpoint('script', scriptProgressSchema) ?? { beats: [] },
          save: (progress) => run.writeCheckpoint('script', progress),
        },
        say('script'),
        runs('scriptRevisions')
      );
    } else if (deps.onePass) {
      log('script: writing the whole script in one pass');
      script = await writeScriptOnePass(
        scriptInput,
        deps.writer,
        spend,
        // The plan, and only the plan. See writeScriptOnePass.
        {
          progress: run.readCheckpoint('script', scriptProgressSchema) ?? { beats: [] },
          save: (progress) => run.writeCheckpoint('script', progress),
        },
        say('script'),
        runs('scriptRevisions')
      );
    } else {
      log('script: writing beats');
      script = await writeScript(
        scriptInput,
        deps.writer,
        spend,
        // Beat-level checkpointing. Writing a ten-beat script is thirty model
        // calls; before this, a failure on beat eight discarded the twenty-one
        // that had already succeeded, because the whole script is one stage.
        //
        // One pass has no equivalent and cannot have one: it is a single call,
        // so there is no partial result to keep. That is a real cost of the
        // method on a long episode.
        {
          progress: run.readCheckpoint('script', scriptProgressSchema) ?? { beats: [] },
          save: (progress) => run.writeCheckpoint('script', progress),
        },
        say('script'),
        runs('scriptRevisions')
      );
    }
    run.writeArtifact('script', script);
    run.markComplete('script');
    // The checkpoint has served its purpose the moment the stage artifact
    // exists, and leaving it would mean a re-run reads partial work in
    // preference to a finished script.
    run.clearCheckpoint('script');
    report('script', `"${script.title}", ${script.beats.length} beats`);
  }

  // --- 5b. A source format stops here. ---------------------------------------
  //
  // An anthology exists to be broken up. Rendering it would buy twenty minutes
  // of audio nobody will hear, and gating it as an episode would judge it as
  // something it is not trying to be - a flat list of ten unrelated stories
  // fails self-similarity, duration and half the narrative checks by design.
  //
  // The shorts are cut afterwards and each is rendered, gated and published on
  // its own, which is where those checks actually mean something.
  if (format.sourceOnly) {
    const stories = script.beats.length;

    // A STORY THAT CITES NOTHING IS NOT A STORY, and this is the only place it
    // can be caught. A source format never reaches the gate, because the gate
    // judges an episode - duration, render, self-similarity - and this is not
    // one. So the two things that matter about a source script are checked here
    // or nowhere.
    //
    // Found on the first real anthology run: seven of ten stories had no
    // material, so the writer filled them with an honest account of the search
    // having failed. Better than inventing myths, and still not publishable.
    const starved = script.beats.filter((b) => b.claimIds.length === 0).map((b) => b.beatId);

    report('script', `"${script.title}", ${stories} stories`);
    log('');
    deps.next?.([
      'This format is a SOURCE. It is never rendered or published whole.',
      `Cut it into ${stories} shorts with:`,
      `  npm run foundry -- shorts --run ${run.id}`,
    ]);

    run.journal({
      stage: 'pipeline',
      event: 'source-script-ready',
      detail: script.title,
      pence: run.manifest.spentPence,
    });

    // A REAL REPORT, NOT A CAST. This used to build an object literal and force
    // it through `as unknown as GateReport` with no `measurement` on it, which
    // typechecked, ran, and then crashed the command that PRINTS the report
    // with "Cannot read properties of undefined (reading 'words')" - after the
    // whole episode had been researched, written and paid for. The cast was the
    // bug: it told the compiler to stop looking at exactly the thing that was
    // missing.
    //
    // A source script has no audio, so nothing here can speak to duration or
    // render quality. What it CAN report is the prose, which is measured the
    // same way every other run measures it.
    const sourceFindings: GateFinding[] = [];

    if (starved.length) {
      sourceFindings.push({
        check: 'sourceCoverage',
        detail:
          `${starved.length} of ${stories} stories cite no evidence: ` +
          `${starved.join(', ')}. Cutting these would publish shorts with an ` +
          `empty Sources sheet. Usually the corpus did not cover them - check ` +
          `whether the research actually found anything for each story.`,
        blocking: true,
      });
    }

    // A BEAT TELLING A DIFFERENT STORY FROM THE ONE IT WAS RESEARCHED FOR.
    //
    // ASKED OF THE LEDGER, NOT OF THE PROSE, and the first version asked the
    // prose. It compared the names in the brief's story line against the names
    // in the beat, and blocked a perfectly good set because the brief wrote
    // "Samudra Manthan" and the script told it as "the churning of the Ocean of
    // Milk" - the same story, in the right beat, sharing not one word of its
    // name. Two spellings of one myth is not a defect, and a check that cannot
    // tell that from a real fault is a check that gets ignored.
    //
    // The question that actually matters is provenance: does this beat cite the
    // claims researched for it? A beat telling another story has to draw on
    // another story's claims, and that is exact rather than a heuristic - no
    // threshold, no name matching, and it is also the thing that would hurt a
    // listener, because a short citing another story's sources publishes a
    // Sources sheet for a story it does not tell.
    const ownerOf = new Map(workingClaims.map((c) => [c.id, c.beatId]));

    const borrowed = script.beats.flatMap((beat) => {
      const wrong = [
        ...new Set(
          beat.claimIds.map((id) => ownerOf.get(id)).filter((owner) => owner && owner !== beat.beatId)
        ),
      ];
      return wrong.length ? [`${beat.beatId} cites claims researched for ${wrong.join(', ')}`] : [];
    });

    if (borrowed.length) {
      sourceFindings.push({
        check: 'storiesCrossed',
        detail:
          `${borrowed.length} of ${stories} stories are not the story their beat was ` +
          `researched for: ${borrowed.join('; ')}. Each of these becomes a short with its ` +
          `own Sources sheet, so cutting them would publish one story's documents under ` +
          `another story's audio.`,
        blocking: true,
      });
    }

    // The writer gets one rewrite to fix this and may not manage it, so it is
    // reported here too. Cutting anyway publishes two shorts that are one.
    for (const duplicate of checkDistinctStories(
      script.beats.map((b) => ({ id: b.beatId, text: beatText(b) }))
    )) {
      sourceFindings.push({
        check: 'sameStory',
        detail: duplicate.detail,
        blocking: duplicate.blocking,
      });
    }

    const sourceGate: GateReport = {
      passed: sourceFindings.length === 0,
      findings: sourceFindings,
      measurement: measure(fullText(script), persona.styleCard.forbiddenPhrases),
      needsHumanReview: true,
      humanReviewReasons: [
        `a source script, not an episode. ${stories} stories, none rendered yet.`,
      ],
    };

    // WRITTEN LIKE ANY OTHER RUN'S. It was returned and not saved, so a source
    // run was the only kind whose report existed once, on a terminal, and then
    // nowhere - `gate --run` answered with ENOENT and there was no record of
    // what had been checked before the shorts were cut from it.
    run.writeArtifact('qa', sourceGate);
    run.markComplete('qa');

    return { run, script, gate: sourceGate };
  }

  // --- 5a. The performance pass: how it sounds, not whether it is right. ------
  //
  // The only stage whose subject is delivery. It may not add a fact, and that is
  // enforced by a deterministic guard rather than requested in the prompt, because
  // an instruction has failed in this pipeline every single time it was the only
  // thing standing between the writer and an invention.
  //
  // FAILS CLOSED. Anything wrong with the result keeps the draft and says why. A
  // polish is never worth an episode.
  stage = 'perform';
  if (!runs('perform')) {
    report('perform', 'OFF for this run, so the script goes to air as written');
  } else if (run.hasArtifact('perform')) {
    script = run.readArtifact('perform', scriptSchema);
    report('perform', 'reusing the performed script');
  } else {
    report('perform', 'reading it for the ear');
    const performed = await performScript(
      { script, persona, format, plan: script.plan },
      deps.writer,
      spend
    );
    if (performed.applied) {
      const was = countWords(fullText(script));
      const now = countWords(fullText(performed.script));
      script = performed.script;
      report('perform', `polished for delivery, ${was} words to ${now}`);
    } else {
      report('perform', `kept the draft: ${performed.reason ?? 'no reason given'}`);
    }
    run.writeArtifact('perform', script);
    run.markComplete('perform');
  }

  // --- 5b. Grounding: does the prose say more than the claims support? --------
  //
  // BEFORE THE APPROVAL BREAK, because the whole value of it is reaching the
  // person who decides whether to pay for audio. See qa/grounding.ts for what
  // this exists to catch: an episode whose best passage, a seven-item
  // enumeration, came from the model's knowledge of the poem rather than from any
  // claim, and which every deterministic check passed.
  //
  // The VERIFIER, not the writer. A model scores its own output higher, and
  // asking the writer whether it invented anything is asking the wrong witness.
  stage = 'grounding';
  let grounding: GroundingReport | undefined;
  if (oneDocLane) {
    // NOT APPLICABLE RATHER THAN SKIPPED. The grounding review reads a script
    // against a claim ledger, and this lane has no ledger to read it against.
    // Running it on an empty one would report every sentence in the episode as
    // unsupported, which is not a finding, it is the wrong question.
    //
    // What checks this lane is reviewReference, which ran before the script
    // existed and is on the run as reference.json.
    grounding = undefined;
  } else if (!runs('grounding')) {
    // UNDEFINED, NOT AN EMPTY REPORT, and the difference matters. An empty report
    // with `checked: true` would tell the gate the script was reviewed and found
    // clean. Absent tells it nothing was looked at, which is the truth.
    grounding = undefined;
    report('grounding', 'OFF for this run, so nothing has checked the prose between the claims');
  } else if (run.hasArtifact('grounding')) {
    grounding = run.readArtifact('grounding', groundingReportSchema);
    report('grounding', 'reusing the grounding review');
  } else {
    report('grounding', 'reading the script against the claims');
    grounding = await reviewGrounding({ script, claims: workingClaims }, deps.verifier, spend);
    run.writeArtifact('grounding', grounding);
    run.markComplete('grounding');
  }
  if (grounding && grounding.findings.length) {
    report(
      'grounding',
      `${grounding.findings.length} passage(s) may say more than the claims support`
    );
  } else if (grounding?.checked) {
    report('grounding', 'every specific in the script traces to a claim');
  }

  // --- 5c. The approval break. ------------------------------------------------
  //
  // RENDERING IS THE ONLY IRREVERSIBLE SPEND. Everything before it produces text
  // somebody can read and throw away for pennies; audio produces a file and a
  // bill, and a script that is wrong is cheapest to catch here. So a held run
  // stops with its script written and gated as far as a script can be gated,
  // and waits.
  //
  // Not a failure and not an error, and the report it returns is the REAL one:
  // it used to be a hardcoded pass with an empty findings list, which printed
  // "GATE: passed" over a script nothing had checked.
  if (run.awaitingApproval) {
    report('script', `"${script.title}", ${script.beats.length} beats`);
    log('');
    deps.next?.([
      'This run is HELD before the render, which is the only step that costs real money.',
      'Read it, change it if it needs changing, then release it:',
      `  npm run foundry -- script  --run ${run.id}`,
      `  npm run foundry -- approve --run ${run.id}`,
    ]);

    run.journal({
      stage: 'pipeline',
      event: 'awaiting-approval',
      detail: script.title,
      pence: run.manifest.spentPence,
    });

    // THE REAL GATE, NOT A FABRICATED PASS.
    //
    // This used to return `{ passed: true, findings: [] }` with a measurement
    // and nothing else, so the recommended path - which is the DEFAULT path -
    // printed "GATE: passed" over a script nothing had checked. The comment
    // above it said the run stops "gated as far as a script can be gated",
    // which is what it should have done and was not doing.
    //
    // Proven on a real run: the held report said passed with no findings, and
    // `gate --run` on the same script immediately found four blocking problems,
    // three of them quotation claims whose words were not in their quotes. It
    // would have gone to audio with a semicolon in it and a made-up quote.
    //
    // NOTHING IS BLOCKED BY THIS. `approve` does not consult the report, so a
    // held run with findings is still approvable - the point is that the person
    // approving it can SEE them. Reporting and refusing are different jobs and
    // only the first one belongs here.
    const heldGate = runGate({
      persona,
      format,
      script,
      claims: workingClaims,
      ledger: checkLedger(workingClaims, corpus.sources),
      verification,
      counterEvidence,
      // ESTIMATED, BECAUSE NO AUDIO EXISTS YET. Measured speech is 2.85 words a
      // second, so a word count is a good enough length to report against a
      // target that is itself a guide. Passing zero here, which is what a
      // missing render would otherwise mean, made the duration check say the
      // episode ran 0 seconds and read as a fault rather than as an absence.
      durationS: countWords(fullText(script)) / WORDS_PER_SECOND,
      priorTexts: deps.priorTexts,
      corpusText: corpus.sources.map((s) => s.text).join('\n'),
      castNames: script.plan?.cast.map((c) => c.name) ?? [],
      grounding,
      stagesOff: skipped,
      // A CASE FILE IS THE SAME KIND OF THING AS A REFERENCE as far as the gate
      // is concerned: prose answerable to documents read whole rather than to a
      // claim ledger. What differs is what it holds, not how it is checked.
      evidence: oneDocLane ? 'reference' : 'ledger',
      referenceReview,
      sources: oneDocLane
        ? corpus.sources.filter(
            (src) =>
              reference?.sourceIds.includes(src.id) ||
              caseFile?.sourceIds.includes(src.id) ||
              src.id === shortArticle?.id
          )
        : corpus.sources,
    });

    const gate: GateReport = {
      ...heldGate,
      needsHumanReview: true,
      humanReviewReasons: [
        ...heldGate.humanReviewReasons,
        `held before the render. Nothing has been voiced and nothing has been ` +
          `published; approve the run to spend on audio.`,
      ],
    };

    // WRITTEN, so `gate --run` and the studio both have something to read and
    // so the report survives the terminal it was printed on. The run is not
    // marked complete for `qa`, because the gate runs again for real once there
    // is audio to measure.
    run.writeArtifact('qa', gate);

    return { run, script, gate };
  }

  // --- 6. Render -----------------------------------------------------------
  let render: z.infer<typeof renderResultSchema>;
  // THE ARTIFACT IS NOT THE AUDIO. Every other stage can be resumed from its
  // JSON because the JSON *is* the output; this one describes a file sitting
  // next to it, and the two can come apart. Deleting the media directory to
  // force a fresh render leaves render.json behind claiming nine minutes of
  // audio, and the run then "reused" a recording that does not exist, gated a
  // duration measured from a missing file, and reported "no audio created"
  // without ever saying what was wrong.
  //
  // So the audio has to be there before the record of it is believed.
  // ASK THE RUN WHERE ITS AUDIO IS. The schema calls audioFile "relative to the
  // run directory" and renderScript stores the absolute path it was given, so
  // the two disagree and have since the field existed - and an absolute path
  // stops being true the moment a run is renamed. run.audioFile covers all
  // three readings and is the one place that knows.
  const renderedAudio = run.hasArtifact('render')
    ? run.audioFile(run.readArtifact('render', renderResultSchema).audioFile)
    : null;

  if (renderedAudio) {
    render = run.readArtifact('render', renderResultSchema);
    report('render', `reusing ${Math.round(render.durationS)}s of audio`);
  } else {
    if (renderedAudio) {
      log('render: the previous audio is gone, so it is being made again');
    }
    stage = 'render';
    log('render: synthesising each beat');
    render = await renderScript(
      {
        beats: script.beats,
        // Voice per host id. Built from the cast rather than passed as one
        // voice, so a dialogue beat can be rendered as an exchange.
        voices: Object.fromEntries(persona.hosts.map((h) => [h.id, h.voice])),
        beatPathFor: (name) => run.mediaPath(name),
        outputPath: run.mediaPath('episode.wav'),
        // A BED UNDER EACH PART, KEYED TO THE EPISODE. Free - ffmpeg
        // oscillators over a file that already exists - so it is not an
        // optional stage. See render/bed.ts.
        music: deps.music,
        musicSeed: run.manifest.topic,
        musicPhraseFile: deps.musicPhraseFile,
      },
      deps.tts,
      {},
      spend,
      say('render')
    );
    run.writeArtifact('render', render);
    run.markComplete('render');
    report('render', `${Math.round(render.durationS)}s across ${render.beatMap.length} beats`);

    // THE FIRST USE IS THE COMMITMENT. Written after a successful render rather
    // than before, so a run that fails at synthesis does not pin a show to a
    // voice nobody has heard. Never overwrites: a later run cannot quietly
    // re-point what listeners already know.
    const { registry, recorded } = recordVoices(
      persona,
      deps.tts.name,
      run.id,
      loadVoiceRegistry()
    );
    if (recorded.length) {
      saveVoiceRegistry(registry);
      for (const r of recorded) {
        report('voice', `${persona.name} speaks as "${r.voiceId}" on ${deps.tts.name} from now on`);
      }
    }
  }

  // --- 7. Gate ------------------------------------------------------------
  log('gate: checking');
  const gate = runGate({
    persona,
    format,
    script,
    claims: workingClaims,
    ledger: checkLedger(workingClaims, corpus.sources),
    verification,
    counterEvidence,
    durationS: render.durationS,
    priorTexts: deps.priorTexts,
    // The corpus and the roster, for the one check that looks outside the
    // claims. See GateInput.corpusText.
    corpusText: corpus.sources.map((s) => s.text).join('\n'),
    castNames: script.plan?.cast.map((c) => c.name) ?? [],
    grounding,
    stagesOff: skipped,
    evidence: oneDocLane ? 'reference' : 'ledger',
    referenceReview,
    sources: oneDocLane
      ? corpus.sources.filter(
          (src) =>
            reference?.sourceIds.includes(src.id) ||
            caseFile?.sourceIds.includes(src.id) ||
            src.id === shortArticle?.id
        )
      : corpus.sources,
  });

  run.writeArtifact('qa', gate);
  run.markComplete('qa');
  log(gate.passed ? 'gate: passed' : `gate: FAILED (${gate.findings.filter((f) => f.blocking).length} blocking)`);
  run.journal({
    stage: 'pipeline',
    event: gate.passed ? 'done' : 'gate-failed',
    detail: script.title,
    pence: run.manifest.spentPence,
  });

  return { run, gate, script };
};
