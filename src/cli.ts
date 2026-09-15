/**
 * The Foundry command line.
 *
 * Every stage is reachable on its own, deliberately. A pipeline you can only
 * run end to end is one you cannot debug: when an episode comes out wrong the
 * question is always "which stage did that", and the answer should be a command
 * rather than an afternoon.
 *
 * `make` never publishes. Publishing is its own command, run by a person after
 * reading the gate report, because the two checks the gate defers to a human
 * are exactly the ones an automated pipeline would wave through.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import {
  screenerConfig,
  episodeBudgetPence,
  platformConfig,
  ttsProvider,
  verifierConfig,
  writerConfig,
} from './config';
import { loadAllFormats, loadFormat } from './formats/load';
import { loadAllPersonas, loadPersona } from './canon/load';
import { Persona } from './canon/schema';
import {
  loadVoiceRegistry,
  retireVoices,
  saveVoiceRegistry,
  voiceFor,
  voiceRegistryPath,
} from './canon/voiceRegistry';
import { describeRetrieval, retrievalKeys } from './evidence/providers';
import { runEpisode } from './pipeline/episode';
import { runShort } from './pipeline/short';
import { cutStories } from './pipeline/anthology';
import { runFiction } from './pipeline/fiction';
import { castBrief, loadBible, storySoFar } from './fiction/bible';
import { environmentKey, findSeries, recordSeries } from './publish/seriesRegistry';
import { SERIES_COVER_SIZE, paletteFor, renderCover } from './art/cover';
import { buildPlan, historyFor, runSummary } from './schedule/plan';
import { writeLibrary } from './run/library';
import { costPenceFor, OpenAiClient } from './models/client';
import { EpisodeFormat } from './formats/schema';
import { COMPOSED_INTO_WRITER, promptRegistry } from './prompts/registry';
import { loadSchedule, loadTopics, returnTopic, takeTopic } from './schedule/load';
import { Run, STAGES } from './run/store';
import { buildDeps, priorEpisodeTexts } from './deps';
import { Reporter } from './cli/ui';
import { setUpChannel } from './pipeline/channel';
import { imageModel, imageQuality, imagesEnabled } from './art/generate';
import { serve } from './server/index';
import { formatGateReport, GateReport } from './qa/gate';
import { regate } from './qa/regate';
import { compare, formatComparison } from './qa/compare';
import { fullText, Script, scriptSchema } from './script/write';
import { renderResultSchema } from './render/assemble';
import { claimCeiling, claimSetSchema, corpusSchema } from './evidence/research';
import { VERIFY_SAMPLE, verifyMode } from './evidence/verify';
import { AudioVibeClient } from './publish/ingest';
import { buildFictionProvenance, buildProvenance } from './publish/provenance';

/**
 * The stages a run passes through, for "3 of 8" in the terminal.
 *
 * `publish` is deliberately absent: it is a separate command a person runs
 * after reading the gate, so counting it would make every finished run look
 * like it had stopped one short.
 */
const PIPELINE_STAGES = STAGES.filter((s) => s !== 'publish');

const USAGE = `
AudioVibe Foundry

  npm run foundry -- <command> [options]

Commands
  shows                          List the shows and their formats
  make --show <id> --topic "..." Write, render and gate one episode
                                 (fiction shows skip research, see Notes)
      ... --dry-run              What it would do and cost. Spends nothing.
      ... --beat-by-beat         Write one beat at a time instead of the whole
                                 script in one call. Slower, and it starves a
                                 beat; see COMMANDS.md.
      ... --render-now           Skip the approval break and voice it straight
                                 away. Spends without anybody reading it first.
  approve --run <id>             Release a held run, then render and gate it.
                                 Nothing is voiced until this.
  channel-setup --show <id>      Create this channel on the platform, once:
                                 account, profile, avatar, cover. Needs
                                 AUDIOVIBE_ADMIN_EMAIL and _PASSWORD.
  studio                         Start the web interface, on loopback. Everything
                                 the commands below do, with progress you can
                                 watch and a script you can edit before it is
                                 voiced. Needs FOUNDRY_ADMIN_PASSWORD.
  short --run <id> [--format <id>]
                                 Cut a short out of an episode that passed
  shorts --run <id> [--only 1,4,7]
                                 Cut every story out of a source script into its
                                 own short. The source is never published.
  resume [--run <id>]            Continue a run (default: the most recent)
  status [--run <id>]            What a run has done and what it cost
  journal [--run <id>]           Minute by minute, and where the money went
  library                        Rebuild LIBRARY.md from every run
  gate [--run <id>]              Re-run the gate over an existing run
  script [--run <id>]            Print the script, for reading aloud
  voices                         Which voice each channel speaks in
  voice-retire --show <id> [--provider <name>]
                                 Release a channel's voice so a new one can be
                                 committed. Deliberate, and two steps on purpose.
  prompts [--show <id>] [--only <id>] [--out <file>]
                                 Every prompt sent to a model, as it is sent
  publish --run <id> [--yes]     Publish a run that passed the gate
  compare --a <run> --b <run>    Which of two scripts is better to listen to
  series --show <id>             What a fiction show has established so far
  series-setup --show <id>       Make the platform series a show publishes into
  due                            What the schedule says should be made now
  tick [--dry-run]               Make the next due thing, then stop

Notes
  Everything is checkpointed. A run that dies is picked up by "resume" at the
  beat or the audio file it reached, not at the start of the stage, so nothing
  already paid for is paid for twice.
  make stops at the gate. Publishing is always a separate, deliberate step.
  short derives from a finished episode rather than researching its own, which
  is why it costs about a ninth of what a standalone short would. It produces
  its own run, publishable the same way as any other.
  A fiction show skips the entire evidence pipeline - there is no document that
  entails an invented scene - and is checked against its series bible instead.
  That is a property of the SHOW, set in its persona file, never a flag.
  tick makes ONE thing and stops, so a studio that is behind catches up at the
  rate its trigger fires rather than all at once. Point cron at it as often as
  you like: what is due is computed from what was published, so firing twice
  changes nothing and not firing for a week leaves a show visibly overdue.
`;

/**
 * Read a --flag's value, joining everything up to the next flag.
 *
 * GREEDY ON PURPOSE. A topic is a sentence, and a sentence typed without quotes
 * arrives as a dozen separate arguments. Taking only the first would run a
 * three pound research pipeline on the word "the" and report nothing wrong -
 * the brief would be strange, the corpus thin, and the failure would look like
 * a bad topic rather than a bad shell.
 *
 * Joining is safe because a value that legitimately starts with "--" is not a
 * thing any option here takes.
 */
const arg = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;

  const parts: string[] = [];
  for (let j = i + 1; j < argv.length && !argv[j]!.startsWith('--'); j++) {
    parts.push(argv[j]!);
  }
  return parts.length ? parts.join(' ') : undefined;
};
const flag = (argv: string[], name: string): boolean => argv.includes(`--${name}`);

/**
 * Artifacts written by this pipeline and read straight back by it.
 *
 * Deliberately not re-validated through a schema: these two are produced and
 * consumed by the same version of the same code, and a Zod schema mirroring
 * every field of the gate report would be a second definition to keep in step
 * with the first for no safety it does not already have.
 */
/**
 * The parts of a fiction run's continuity report the Sources sheet needs.
 *
 * Narrow on purpose. The full report carries a verdict and a reason per fact,
 * and none of that belongs on a listener's screen - what the sheet says is how
 * many established facts this episode was held against and who held it.
 */
const continuityArtifactSchema = z.object({
  findings: z.array(z.unknown()),
  checkerModel: z.string(),
});

const readGate = (run: Run): GateReport =>
  JSON.parse(fs.readFileSync(path.join(run.dir, 'qa.json'), 'utf8')) as GateReport;

interface StoredVerification {
  verification?: { verifierModel?: string };
  counterEvidence?: Array<{ claimId: string; sources: unknown[]; queries: string[] }>;
}

const readVerification = (run: Run): StoredVerification =>
  JSON.parse(fs.readFileSync(path.join(run.dir, 'verification.json'), 'utf8')) as StoredVerification;

const openRun = (argv: string[]): Run => {
  const id = arg(argv, 'run');
  const run = id ? Run.open(id) : Run.latest();
  if (!run) throw new Error('no runs yet. Start one with: make --show <id> --topic "..."');
  return run;
};

/** Real HTTP for source fetching, with a browser-ish UA and a timeout. */
const cmdShows = (): number => {
  const personas = loadAllPersonas();
  const formats = loadAllFormats();
  if (!personas.length) {
    console.log('No shows in personas/.');
    return 0;
  }
  for (const p of personas) {
    console.log(`${p.id}  (@${p.handle})  ${p.name}`);
    console.log(`  ${p.thesis.trim().replace(/\s+/g, ' ')}`);
    console.log(`  category: ${p.category}`);
    console.log(`  formats:  ${p.formats.join(', ')}`);
    console.log(`  ${p.hosts.length > 1 ? 'hosts:' : 'host: '}`);
    for (const h of p.hosts) {
      // Both ids, because a show is ready for one engine and not the other and
      // that distinction is the whole question somebody runs this to answer.
      // Reporting only the publishing voice made a show look unusable when it
      // was perfectly ready to draft.
      const draft = h.voice.draftVoiceId ? `  draft: openai/${h.voice.draftVoiceId}` : '';
      console.log(`    ${h.id} (${h.name})  ${h.voice.provider}/${h.voice.voiceId}${draft}`);
      if (h.voice.voiceId.startsWith('REPLACE_')) {
        console.log('      ^ placeholder. Set a real voice before publishing, then never change it.');
      }
      if (!h.voice.draftVoiceId) {
        console.log('      ^ no draftVoiceId, so this host cannot be drafted on FOUNDRY_TTS=openai.');
      }
    }
    console.log('');
  }
  console.log(`Formats available: ${formats.map((f) => f.id).join(', ') || '(none)'}`);

  // WHAT THIS SHOW CAN ACTUALLY DO RIGHT NOW. Listing the configuration without
  // saying what it adds up to leaves the reader to work out for themselves
  // whether a placeholder voice is a blocker, and the answer depends on which
  // engine is selected - which is not on screen anywhere else.
  const draftable = personas.filter((p) => p.hosts.every((h) => h.voice.draftVoiceId));
  const publishable = personas.filter((p) =>
    p.hosts.every((h) => !h.voice.voiceId.startsWith('REPLACE_'))
  );

  console.log('');
  console.log(
    `Ready to draft (FOUNDRY_TTS=openai): ${draftable.map((p) => p.id).join(', ') || '(none)'}`
  );
  console.log(
    `Ready to publish (elevenlabs):       ${publishable.map((p) => p.id).join(', ') || '(none)'}`
  );
  return 0;
};

const cmdMake = async (argv: string[]): Promise<number> => {
  const showId = arg(argv, 'show');
  const topic = arg(argv, 'topic');
  if (!showId || !topic) {
    console.error('Usage: make --show <id> --topic "what the episode is about"');
    return 1;
  }

  const persona = loadPersona(showId);
  const formatId = arg(argv, 'format') ?? persona.formats[0]!;
  const format = loadFormat(formatId); // Fail now, not after the first API call.

  if (flag(argv, 'dry-run')) return describeRun(persona, format, topic, !flag(argv, 'beat-by-beat'));

  // ONE PASS IS THE DEFAULT. `--beat-by-beat` goes back, and `--one-pass` is
  // still accepted because it is in the history and in people's shell history.
  //
  // RECORDED ON THE RUN either way, because a run whose script was written a
  // different way is not comparable to one that was not, and six weeks later
  // the only place that fact could live is the manifest.
  const onePass = !flag(argv, 'beat-by-beat');

  // The header is printed by finishRun, which also prints it on a resume, so
  // the two commands look the same and neither repeats the other.
  // HELD BY DEFAULT, because rendering is the only irreversible spend and a
  // script is cheapest to fix before it has been voiced. `--render-now` skips
  // the break for somebody who knows what they are doing; a source format is
  // never held, because it stops before the render anyway.
  const holdForApproval = !flag(argv, 'render-now') && !format.sourceOnly;

  const run = Run.create({ personaId: persona.id, formatId, topic, onePass, holdForApproval });
  return finishRun(run, argv);
};

/**
 * What a run would do, and what it would cost, without doing any of it.
 *
 * SPENDS NOTHING AND CALLS NOTHING. The estimate comes from counting the calls
 * the pipeline is going to make against the configured models' prices, which is
 * arithmetic over things already on disk. A dry run that quietly made one
 * "cheap" call to check something would be a dry run nobody trusts.
 *
 * The numbers are approximate and say so. Their job is to answer "is this about
 * to cost fifty pence or fifteen pounds", which is the question somebody has
 * before running this for the first time - not to predict an invoice.
 */
const describeRun = (
  persona: Persona,
  format: EpisodeFormat,
  topic: string,
  onePass: boolean
): number => {
  const writer = writerConfig();
  const verifier = verifierConfig();
  const engine = ttsProvider();

  // Rough token shapes per call, from what the prompts actually contain. Wrong
  // in the third significant figure and right in the first, which is the
  // accuracy this is for.
  const beats = format.beats.length;
  const claimFloor = format.beats.reduce((n, b) => n + b.minClaims, 0);

  // BETWEEN THE FLOOR AND THE CEILING, because that is where extraction
  // actually lands and both ends of the range are wrong to quote.
  //
  // This used to be `max(floor, beats * 3)`, which was fine while the ceiling
  // was the floor plus two: the two numbers were never far apart. They are now.
  // A format can be floored at 36 claims and permitted 94, and verification is
  // one call per claim - the second largest line on this table - so quoting the
  // floor under-quotes the run by a third.
  //
  // The midpoint is a guess, and it is the softest number here along with the
  // escalation fraction. It is honest about being one.
  const claimCeilingTotal = format.beats.reduce((n, b) => n + claimCeiling(b), 0);
  const estimatedClaims = Math.max(claimFloor, Math.round((claimFloor + claimCeilingTotal) / 2));

  const write = (model: string, calls: number, inTok: number, outTok: number) =>
    calls * costPenceFor(model, inTok, outTok);

  const stages: Array<[string, number, string]> = [
    ['brief', write(writer.model, 1, 1_200, 900), '1 call'],
    ['corpus', 0, 'search + fetch, no model calls'],
    [
      'claims',
      (() => {
        // CHUNKED, so this is not one call. The corpus rides in a cached system
        // prefix, so the first chunk pays a 1.25x write and the rest read at
        // 0.1x - but the OUTPUT is per chunk and does not shrink, and output is
        // where the money is when every claim carries a verbatim quote.
        //
        // Measured at 67p on a real ten-beat episode with fourteen sources,
        // against the 14p this used to guess. The old number assumed one call
        // and cheap quotes, and was wrong about both.
        const chunks = Math.ceil(format.beats.length / 3);
        const corpusIn = 30_000;
        const cached = corpusIn * (1.25 + 0.1 * (chunks - 1));
        return write(writer.model, 1, cached, 0) + write(writer.model, chunks, 500, 5_000);
      })(),
      `${Math.ceil(format.beats.length / 3)} calls, three beats each, sharing a cached corpus`,
    ],
    [
      'verification',
      (() => {
        const screener = screenerConfig();
        // SAMPLED, unless somebody asked for all of them. The deterministic
        // quote check runs on every claim and costs nothing; this is the model
        // being asked whether that quote entails the claim, and it is the
        // largest line here when it runs on everything.
        const asked =
          verifyMode() === 'all' ? estimatedClaims : Math.ceil(estimatedClaims * VERIFY_SAMPLE);

        if (!screener) return write(verifier.model, asked, 1_400, 200);
        return (
          write(screener.model, asked, 1_400, 200) +
          write(verifier.model, Math.ceil(asked * 0.2), 1_400, 200)
        );
      })(),
      verifyMode() === 'all'
        ? `every one of ~${estimatedClaims} claims put to a model`
        : `~${Math.ceil(estimatedClaims * VERIFY_SAMPLE)} of ~${estimatedClaims} claims put to a ` +
          `model; the rest have their quotes located and go to the human reader`,
    ],
    [
      'script',
      // THE STORY PLAN IS PAID FOR EITHER WAY. It used to be described here as
      // the hook competition, and that went stale the moment the long formats
      // dropped their cold opens: a hook competition only runs when the first
      // beat is typed `cold_open`, so an estimate naming it was quoting for
      // work the run would not do.
      write(writer.model, 1, 2_000, 1_500) +
        (onePass
          ? // One call carrying the whole beat sheet and every claim, and up to
            // one rewrite of the whole thing. The output is the episode, so it
            // is large; the input is large too and mostly cached.
            write(writer.model, 1.5, 16_000, 8_000)
          : write(writer.model, beats * 1.6, 3_500, 1_200)),
      onePass
        ? `story plan + the whole script in 1 call (plus up to 1 rewrite)`
        : `story plan${format.beats[0]?.type === 'cold_open' ? ' + hook competition' : ''} + ` +
          `~${Math.round(beats * 1.6)} beat calls (${beats} beats, some revised)`,
    ],
    ['title', write(writer.model, 1, 1_200, 200), '1 call'],
  ];

  // Speech is roughly 150 words a minute and 5.5 characters a word.
  const nominal = (format.targetSeconds[0] + format.targetSeconds[1]) / 2;
  const characters = Math.round((nominal / 60) * 150 * 5.5);
  const voicePence = engine === 'openai' ? (characters / 1_000_000) * 1200 : (characters / 1000) * 20;

  // A SOURCE FORMAT NEVER RENDERS, so quoting for one quotes for work the run
  // will not do. The shorts cut from it pay for their own audio, under their own
  // command and their own bill.
  if (!format.sourceOnly) {
    stages.push(['render', voicePence, `~${characters.toLocaleString()} characters on ${engine}`]);
  }

  const total = stages.reduce((sum, [, pence]) => sum + pence, 0);

  console.log(`${persona.name} / ${format.name}`);
  console.log(`  topic:  ${topic}`);
  console.log(`  beats:  ${format.beats.map((b) => b.id).join(' -> ')}`);
  console.log(
    `  length: ${Math.round(format.targetSeconds[0] / 60)}-${Math.round(format.targetSeconds[1] / 60)} minutes`
  );
  console.log(`  models: ${writer.model} writing, ${verifier.model} verifying`);
  console.log('');
  console.log('Stages, and roughly what each costs:');
  for (const [name, pence, detail] of stages) {
    console.log(`  ${name.padEnd(13)} ${`${pence.toFixed(0)}p`.padStart(6)}   ${detail}`);
  }
  console.log(`  ${'TOTAL'.padEnd(13)} ${`${total.toFixed(0)}p`.padStart(6)}   about £${(total / 100).toFixed(2)}`);
  console.log('');
  console.log(`Budget ceiling is ${episodeBudgetPence()}p. A run that would exceed it stops.`);
  console.log('These are estimates from call counts and list prices, not a quote.');
  console.log('');
  if (format.sourceOnly) {
    const stories = format.beats.length;
    console.log(
      `This is a SOURCE format: it stops after the script, renders nothing, and is ` +
        `never published whole.`
    );
    console.log(
      `Cutting it into ${stories} shorts afterwards costs roughly ${stories * 4}p more - ` +
        `a title and a render each.`
    );
  } else {
    console.log('It will STOP AT THE GATE and publish nothing. Run without --dry-run to make it.');
  }
  return 0;
};

/**
 * Run a run to its gate, through whichever pipeline the SHOW calls for.
 *
 * The branch is on the persona, never on a flag, and that is deliberate: a
 * command-line switch that decides whether an episode gets fact-checked is one
 * typo away from publishing an unsourced episode under a show whose entire
 * claim on a listener is that it read the documents. The show decides, once,
 * in its own file.
 */
const finishRun = async (run: Run, _argv: string[]): Promise<number> => {
  const persona = loadPersona(run.manifest.personaId);
  const format = loadFormat(run.manifest.formatId);

  // The stages this run will ACTUALLY pass through, so a section can say
  // "3 of 7" truthfully. A fiction run does no research and a source format
  // never renders; numbering either against the full list would count stages
  // that are not going to happen and leave every finished run looking short.
  const skip = new Set<string>(
    persona.fiction ? ['corpus', 'claims', 'verification', 'repair'] : []
  );
  if (format.sourceOnly) skip.add('render');

  const ui = new Reporter({
    spentPence: () => run.manifest.spentPence,
    stages: PIPELINE_STAGES.filter((st) => !skip.has(st)),
  });

  ui.header(`${persona.name} · ${format.name}`, [
    ['run', run.id],
    ['topic', run.manifest.topic],
    ['budget', `${episodeBudgetPence()}p`],
    ['writing', run.manifest.onePass === false ? `${writerConfig().model}, beat by beat` : writerConfig().model],
    ['checking', screenerConfig()
      ? `${screenerConfig()!.model}, escalating to ${verifierConfig().model}`
      : verifierConfig().model],
    ['research', describeRetrieval(retrievalKeys())],
    ['voice', ttsProvider() === 'openai' ? 'openai, drafting only' : ttsProvider()],
  ]);

  // FROM THE MANIFEST, NOT FROM THE COMMAND LINE, so a resume continues the way
  // the run started. Resuming a one-pass run without the flag would write the
  // second half of an episode by a different method from the first.
  const deps = buildDeps({
    onePass: run.manifest.onePass,
    log: (message, stage) => {
      if (stage && stage !== 'pipeline') ui.section(stage);
      ui.line(message);
    },
    next: (lines) => ui.next(lines),
  });

  // Self-similarity compares against every OTHER run. buildDeps cannot know
  // which run is being gated, so it is narrowed here, where that is known.
  deps.priorTexts = priorEpisodeTexts(run.id);

  const { gate } = persona.fiction
    ? await runFiction({ run }, deps)
    : await runEpisode(run, deps);

  ui.finish([
    ['spent', `${run.manifest.spentPence.toFixed(1)}p`],
    ['artifacts', run.dir],
  ]);

  console.log(formatGateReport(gate));
  console.log('');

  if (gate.passed) {
    console.log(`\nRead it first:  npm run foundry -- script --run ${run.id}`);
    console.log(`Then publish:   npm run foundry -- publish --run ${run.id}`);
  }
  return gate.passed ? 0 : 2;
};

/**
 * Cut a short out of a finished episode.
 *
 * REQUIRES THE PARENT TO HAVE PASSED ITS GATE, not merely to exist. A short
 * inherits the parent's verification wholesale, so deriving from an episode
 * that failed would launder a failure into a format that travels further than
 * the episode ever would.
 */
/**
 * Cut every story out of a source script into its own short.
 *
 * No gate check on the parent, unlike `short`. A source script is never gated
 * as an episode - runEpisode stops before the render for one - so there is no
 * pass to require. Each story is gated on its own instead, which is where the
 * checks mean something: a flat list of ten unrelated stories fails duration
 * and self-similarity by design, and each story judged alone does not.
 */
/**
 * Release a held run and let it render.
 *
 * ITS OWN COMMAND, not a flag on resume, because this is the one moment in the
 * pipeline where a person takes responsibility for what happens next. A run
 * approved by accident spends money on audio nobody read; a flag buried in
 * another command is exactly how that happens.
 */
/**
 * Bring a channel into existence on the platform.
 *
 * ITS OWN COMMAND AND NOT PART OF `make`, because it happens once per channel
 * ever and it touches production. Folding it into the weekly path would mean
 * every run carrying code that can create accounts.
 */
const cmdChannelSetup = async (argv: string[]): Promise<number> => {
  const showId = arg(argv, 'show');
  if (!showId) {
    console.error('Usage: channel-setup --show <id>');
    return 1;
  }

  const persona = loadPersona(showId);
  const platform = platformConfig();

  const email = process.env.AUDIOVIBE_ADMIN_EMAIL;
  const password = process.env.AUDIOVIBE_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error(
      'AUDIOVIBE_ADMIN_EMAIL and AUDIOVIBE_ADMIN_PASSWORD must be set. Creating a channel ' +
        'needs the studio operator, and only for this one command.'
    );
    return 1;
  }

  const ui = new Reporter({ stages: ['account', 'profile', 'artwork'] });
  ui.header(`Setting up ${persona.name}`, [
    ['channel', persona.id],
    ['handle', `@${persona.handle}`],
    ['platform', platform.url],
    ['label', 'declared as an AI show, which renders on every card'],
    ['artwork', imagesEnabled() ? `${imageModel()} at ${imageQuality()}` : 'drawn (FOUNDRY_IMAGE=off)'],
  ]);

  // LOUD, BECAUSE THIS ONE CANNOT BE TAKEN BACK. An account on production is
  // visible, followable and indexed; there is no delete in this pipeline.
  if (platform.isProduction && !flag(argv, 'yes')) {
    console.log('  This creates a REAL account on production. Re-run with --yes to do it.');
    console.log('');
    return 1;
  }

  try {
    const result = await setUpChannel(showId, email, password, {
      log: (message, stage) => {
        if (stage) ui.section(stage);
        ui.line(message);
      },
    });

    ui.finish([
      ['account', `@${result.account.username}`],
      ['id', result.account.userId],
      ['email', result.account.email],
      ['artwork', result.generated.length ? `generated ${result.generated.join(' and ')}` : 'drawn'],
      ['recorded', 'accounts.json'],
    ]);

    console.log(
      result.existed
        ? '  The account was already there; its profile and artwork were refreshed.'
        : '  Created. Its password is in accounts.json and nowhere else.'
    );
    console.log('');
    return 0;
  } catch (err) {
    ui.finish();
    console.error(`  ${(err as Error).message}`);
    console.error('');
    return 1;
  }
};

const cmdApprove = async (argv: string[]): Promise<number> => {
  const run = openRun(argv);

  if (!run.manifest.holdForApproval) {
    console.error(`run ${run.id} was not held, so there is nothing to approve.`);
    return 1;
  }
  if (!run.hasArtifact('script')) {
    console.error(`run ${run.id} has no script yet. There is nothing to read.`);
    return 1;
  }
  if (run.manifest.approvedAt) {
    console.log(`already approved at ${run.manifest.approvedAt}. Continuing it.`);
    return finishRun(run, argv);
  }

  const script = run.readArtifact('script', scriptSchema);
  console.log(`approving "${script.title}" (${run.id})`);
  console.log('');

  run.approve();
  run.journal({ stage: 'pipeline', event: 'approved', detail: script.title });

  return finishRun(run, argv);
};

const cmdShorts = async (argv: string[]): Promise<number> => {
  const source = openRun(argv);
  const only = (arg(argv, 'only') ?? '')
    .split(/[\s,]+/)
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (!source.hasArtifact('script')) {
    console.error(`run ${source.id} has no script yet. Make it before cutting it up.`);
    return 1;
  }

  const persona = loadPersona(source.manifest.personaId);
  const script = source.readArtifact('script', scriptSchema);

  // EACH STORY IS A STAGE HERE, which is what a cut actually is: ten small runs
  // rather than one run with ten steps. Numbering them against the set makes
  // "story 7 of 10" true, and a `--only` cut says how many it is doing rather
  // than leaving somebody counting.
  const cutting = only.length ? only : script.beats.map((_, i) => i + 1);
  const ui = new Reporter({
    spentPence: () => cutting.reduce((sum, n) => sum + (spentOnStory(source, n) ?? 0), 0),
    stages: cutting.map((n) => `story ${n}`),
  });

  ui.header(`${persona.name} · cutting ${cutting.length} shorts`, [
    ['source', source.id],
    ['topic', source.manifest.topic],
    ['stories', only.length ? `${only.join(', ')} of ${script.beats.length}` : `all ${script.beats.length}`],
    ['voice', ttsProvider() === 'openai' ? 'openai, drafting only' : ttsProvider()],
  ]);

  const results = await cutStories({ source, only }, buildDeps({
    log: (message, stage) => {
      if (stage) ui.section(stage);
      ui.line(message);
    },
  }));

  const passed = results.filter((r) => r.gate.passed);
  ui.finish([
    ['made', `${results.length} shorts`],
    ['passed', `${passed.length} of ${results.length}`],
    ['spent', `${results.reduce((n, r) => n + r.run.manifest.spentPence, 0).toFixed(1)}p`],
  ]);

  for (const r of results.filter((x) => !x.gate.passed)) {
    const blocking = r.gate.findings.filter((f) => f.blocking);
    console.log(`  story ${r.story} needs work: ${r.run.id}`);
    for (const f of blocking.slice(0, 3)) console.log(`      [${f.check}] ${f.detail.slice(0, 96)}`);
    if (blocking.length > 3) console.log(`      and ${blocking.length - 3} more`);
  }
  if (results.some((x) => !x.gate.passed)) console.log('');

  console.log('  Read one with:     npm run foundry -- script --run <id>');
  console.log('  Publish one with:  npm run foundry -- publish --run <id>');

  // Non-zero only when NOTHING passed. One bad story out of ten is a story to
  // fix, not a failed cut, and exiting non-zero would make a scheduler treat it
  // as one.
  return passed.length ? 0 : 2;
};

/** What one already-cut story has cost so far, for the running total. */
const spentOnStory = (source: Run, story: number): number | null => {
  const run = Run.derivedFrom(source.id).find((r) => r.manifest.story === story);
  return run ? run.manifest.spentPence : null;
};

const cmdShort = async (argv: string[]): Promise<number> => {
  const parent = openRun(argv);

  if (!parent.hasArtifact('qa')) {
    console.error(`run ${parent.id} has not been gated yet. Run it before cutting a short.`);
    return 1;
  }
  if (!readGate(parent).passed) {
    console.error(
      `run ${parent.id} did not pass its gate. A short inherits the parent's verification, ` +
        `so deriving from a failed episode would carry the failure into a wider audience.`
    );
    return 1;
  }

  // Default to the show's own short format if it declares one. A show without
  // one has not decided what its shorts sound like, and guessing is worse than
  // asking.
  const persona = loadPersona(parent.manifest.personaId);
  const formatId =
    arg(argv, 'format') ?? persona.formats.find((f) => loadFormat(f).kind === 'short');

  if (!formatId) {
    console.error(
      `${persona.name} has no short format. Add one to its formats list, or pass --format.`
    );
    return 1;
  }

  const { run: shortRun, gate } = await runShort({ parent, formatId }, buildDeps());

  console.log('');
  console.log(formatGateReport(gate));
  console.log('');
  console.log(`spent ${shortRun.manifest.spentPence.toFixed(1)}p`);
  console.log(`artifacts in ${shortRun.dir}`);

  if (gate.passed) {
    console.log(`
Read it first:  npm run foundry -- script --run ${shortRun.id}`);
    console.log(`Then publish:   npm run foundry -- publish --run ${shortRun.id}`);
  }
  return gate.passed ? 0 : 2;
};

/**
 * What a fiction show has established, as a person would want to read it.
 *
 * The bible is JSON and grows to a few hundred lines within a season, which is
 * fine for a checker and useless for the person deciding what the next episode
 * is about. This is the same information as a cast list and a recap.
 */
const cmdSeries = (argv: string[]): number => {
  const showId = arg(argv, 'show');
  if (!showId) {
    console.error('Usage: series --show <id>');
    return 1;
  }

  const persona = loadPersona(showId);
  if (!persona.fiction) {
    console.error(`${persona.name} is not a fiction show, so it has no series bible.`);
    return 1;
  }

  const bible = loadBible(persona.id);
  console.log(`${persona.name} - ${bible.episodes.length} episode(s)`);
  console.log('');

  console.log('Cast and what is fixed about them:');
  console.log(castBrief(bible));

  const revisable = bible.entities.flatMap((e) =>
    e.facts.filter((f) => f.revisable).map((f) => `  ${e.name}: ${f.text}`)
  );
  if (revisable.length) {
    // Shown here and deliberately NOT shown to the writer. These are the
    // threads the series can still pull on, which is exactly the thing a
    // person planning the next episode needs and the writer must not treat as
    // settled background.
    console.log('');
    console.log('Still open, and revisable:');
    for (const line of revisable) console.log(line);
  }

  console.log('');
  console.log('Story so far:');
  console.log(storySoFar(bible, 100));
  return 0;
};

/**
 * Which episode of the series this is, for the cover.
 *
 * READ FROM THE SERIES BIBLE, not from a count of runs. Runs include the ones
 * that failed the gate and the ones abandoned halfway, and numbering from those
 * would skip numbers in the listener's view for reasons only this repo knows
 * about. The bible records exactly the episodes that were published, in the
 * order they were published, which is the same list a listener sees.
 *
 * The platform assigns its OWN episode number on upload, from the series'
 * episode count. This is the cover's copy of the same fact, and it is off by
 * one only if a publish fails after the platform has counted it - visible as a
 * cover that disagrees with the shelf, which is exactly the kind of thing that
 * should be visible.
 */
const episodeNumberFor = (run: Run, persona: Persona): number | undefined => {
  if (!persona.fiction) return undefined;
  const bible = loadBible(persona.id);
  const index = bible.episodes.findIndex((e) => e.id === run.id);
  // Already recorded (the gate passed and the bible was written) means this is
  // its position; not yet recorded means it is the next one.
  return index >= 0 ? index + 1 : bible.episodes.length + 1;
};

/**
 * Create the platform series a show publishes its episodes into.
 *
 * A SEPARATE, DELIBERATE COMMAND, run once per show per environment. Series
 * creation is not idempotent and there is no create-or-get on the API, so a
 * publish that quietly created one whenever the registry looked empty would
 * fork the show into two shelves the first time the registry was mislaid - and
 * both shelves would look entirely correct in isolation.
 */
const cmdSeriesSetup = async (argv: string[]): Promise<number> => {
  const showId = arg(argv, 'show');
  if (!showId) {
    console.error('Usage: series-setup --show <id>');
    return 1;
  }

  const persona = loadPersona(showId);
  if (!persona.publishesAsSeries) {
    console.error(
      `${persona.name} publishes loose episodes, not a series. Set publishesAsSeries ` +
        `in its persona file first, and read the note there about why that is a ` +
        `real trade rather than an oversight.`
    );
    return 1;
  }

  const platform = platformConfig();
  const env = environmentKey(platform.url);

  const existing = findSeries(persona.id, platform.url);
  if (existing) {
    console.log(`${persona.name} already publishes into "${existing.title}" on ${env}.`);
    console.log(`  series ${existing.seriesId}, made ${existing.createdAt}`);
    return 0;
  }

  if (platform.isProduction && !flag(argv, 'yes')) {
    console.error(`AUDIOVIBE_API_URL points at PRODUCTION (${platform.url}).`);
    console.error('Re-run with --yes if that is what you meant.');
    return 1;
  }

  console.log(`creating a series for ${persona.name} on ${env}...`);

  // The shelf gets 16:9 art, which is the frame the platform crops series to.
  // Sending a square one here would have the middle band of it kept and the
  // top and bottom shaved off, taking the wordmark with them.
  const coverPath = renderCover(
    { showName: persona.name, title: persona.name, palette: paletteFor(persona.id) },
    path.join(os.tmpdir(), `foundry-series-${persona.id}.png`),
    SERIES_COVER_SIZE
  );

  const client = new AudioVibeClient(platform.url, platform.token);
  const created = await client.createSeries({
    title: persona.name,
    description: persona.thesis.trim().replace(/\s+/g, ' '),
    category: persona.category,
    coverPath,
  });

  recordSeries(persona.id, {
    seriesId: created.seriesId,
    title: created.title,
    apiUrl: platform.url,
    createdAt: new Date().toISOString(),
  });

  console.log(`series ${created.seriesId} - "${created.title}"`);
  console.log('Recorded in series.json. Commit it: losing it forks the show.');
  return 0;
};

/**
 * Everything the studio should make right now, and what is stopping it.
 *
 * READ-ONLY AND FREE. Separated from `tick` on purpose: a schedule you cannot
 * inspect before it spends money is a schedule nobody trusts enough to turn on.
 */
const readPlan = (now = new Date()) => {
  const personas = loadAllPersonas();
  const kindOf = new Map(personas.map((p) => [p.id, p]));

  const summaries = Run.list().map((id) => {
    const run = Run.open(id);
    // The format decides whether a run was an episode or a short. Reading it
    // from the format rather than from the run's own manifest keeps one
    // definition of what a short is.
    let kind: 'long' | 'short' = 'long';
    try {
      kind = loadFormat(run.manifest.formatId).kind === 'short' ? 'short' : 'long';
    } catch {
      // A run whose format has since been deleted still counts as published;
      // guessing long is the direction that does not invent a missing episode.
    }
    return runSummary(run, kind);
  });

  return buildPlan({
    schedule: loadSchedule(),
    personas: personas.filter((p) => kindOf.has(p.id)),
    history: (personaId) => historyFor(personaId, summaries),
    topicsQueued: (personaId) => loadTopics(personaId).topics.length,
    now,
  });
};

const cmdDue = (): number => {
  const plan = readPlan();

  if (!plan.due.length && !plan.blocked.length && !plan.waiting.length) {
    console.log('Nothing due.');
    return 0;
  }

  if (plan.due.length) {
    console.log('Due now:');
    for (const item of plan.due) {
      const late = item.overdueDays > 0 ? `  [${item.overdueDays}d late]` : '';
      console.log(`  ${item.personaId} ${item.kind}${late}`);
      console.log(`    ${item.reason}`);
    }
  }

  if (plan.blocked.length) {
    // Shown as loudly as the due list. A show blocked on an empty topic queue
    // is a show that has silently stopped publishing, and the whole reason it
    // is reported rather than skipped is so that stops being silent.
    if (plan.due.length) console.log('');
    console.log('Waiting on you:');
    for (const b of plan.blocked) console.log(`  ${b.personaId} ${b.reason}`);
  }

  if (plan.waiting.length) {
    // Quieter than the other two, because nothing is wrong. This is the week
    // ahead, and the only reason to print it is so somebody can see that the
    // studio is spread across the week rather than silent.
    if (plan.due.length || plan.blocked.length) console.log('');
    console.log('Coming up:');

    const tz = loadSchedule().timezone;
    for (const w of plan.waiting) {
      const when = w.at.toLocaleString('en-GB', {
        timeZone: tz,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      console.log(`  ${when}  ${w.personaId} ${w.kind}`);
      console.log(`    ${w.reason}`);
    }
  }

  return 0;
};

/**
 * Make the next thing that is due. One item, then stop.
 *
 * ONE PER TICK, DELIBERATELY. A tick that drained the whole plan would, on a
 * studio three weeks behind, spend fifteen pounds and an hour before anybody
 * saw the first result - and if something were wrong with the pipeline it would
 * be wrong fifteen times. One item per tick means the schedule catches up at
 * the rate the trigger fires, which is a rate somebody chose.
 *
 * STOPS AT THE GATE unless the show has opted into automatic publishing, and
 * even then an episode the gate flagged for human review waits. Those two
 * checks - did the script acknowledge the counter-evidence, is that weakest
 * source framed as one person's account - are exactly the ones an automated
 * loop waves through.
 */
const cmdTick = async (argv: string[]): Promise<number> => {
  const plan = readPlan();
  const item = plan.due[0];

  if (!item) {
    for (const b of plan.blocked) console.log(`waiting: ${b.personaId} ${b.reason}`);
    const next = plan.waiting[0];
    if (next) {
      console.log(`next: ${next.personaId} ${next.kind}, ${next.reason}`);
    }
    console.log('Nothing due.');
    return 0;
  }

  const persona = loadPersona(item.personaId);
  const cadence = loadSchedule().shows[item.personaId]!;
  console.log(`${item.personaId}: ${item.reason}`);

  if (flag(argv, 'dry-run')) {
    console.log(`Would make one ${item.kind}. Nothing spent.`);
    return 0;
  }

  let result: { run: Run; gate: GateReport };
  let topic: string | null = null;

  if (item.kind === 'short') {
    const parent = Run.open(item.parentRunId!);
    const formatId = persona.formats.find((f) => loadFormat(f).kind === 'short');
    if (!formatId) {
      console.error(`${persona.name} has no short format but its cadence asks for shorts.`);
      return 1;
    }
    result = await runShort({ parent, formatId }, buildDeps());
  } else {
    // Taken BEFORE the run. A topic consumed only on success means a failing
    // show retries the same subject on every tick forever, spending money each
    // time. Consumed up front, a failure costs that topic, which is visible in
    // the diff and recoverable by putting it back.
    topic = persona.fiction ? persona.thesis.trim().replace(/\s+/g, ' ') : takeTopic(persona.id);
    if (!topic) {
      console.error(`${persona.name} has nothing queued to cover.`);
      return 1;
    }

    const formatId = persona.formats.find((f) => loadFormat(f).kind !== 'short') ?? persona.formats[0]!;
    const run = Run.create({ personaId: persona.id, formatId, topic });
    console.log(`run ${run.id}: ${topic}`);

    try {
      result = persona.fiction
        ? await runFiction({ run }, buildDeps())
        : await runEpisode(run, buildDeps());
    } catch (err) {
      if (!persona.fiction && topic) returnTopic(persona.id, topic);
      throw err;
    }
  }

  console.log('');
  console.log(formatGateReport(result.gate));
  console.log('');
  console.log(`spent ${result.run.manifest.spentPence.toFixed(1)}p`);

  if (!result.gate.passed) {
    if (!persona.fiction && topic) {
      // A gate failure is usually the topic, not the pipeline. Putting it back
      // lets a person look at it rather than losing it to a silent retry.
      returnTopic(persona.id, topic);
      console.log(`Put "${topic}" back on the queue.`);
    }
    return 2;
  }

  if (!cadence.autoPublish) {
    console.log(`\nRead it:     npm run foundry -- script --run ${result.run.id}`);
    console.log(`Then publish: npm run foundry -- publish --run ${result.run.id}`);
    return 0;
  }

  if (result.gate.needsHumanReview) {
    // autoPublish does not override this, and that is the point of having both.
    console.log('\nThis one needs a person before it goes out:');
    for (const r of result.gate.humanReviewReasons) console.log(`  - ${r}`);
    console.log(`  npm run foundry -- publish --run ${result.run.id} --yes`);
    return 0;
  }

  console.log('\nauto-publishing (the show opted in and the gate passed clean)');
  return await cmdPublish(['--run', result.run.id, '--yes']);
};

/**
 * What a run did, minute by minute, and where its money went.
 *
 * The journal is append-only and written as the run goes, so this works on a
 * run that is still going and on one that died - and a run that died leaves a
 * journal ending exactly where it died, which is the most useful thing there is
 * for working out why.
 */
const cmdJournal = (argv: string[]): number => {
  const run = openRun(argv);
  const entries = run.readJournal();

  if (!entries.length) {
    console.log(`run ${run.id} has no journal. It predates journalling, or never started.`);
    return 0;
  }

  const start = new Date(entries[0]!.at).getTime();
  const byStage = new Map<string, number>();

  for (const e of entries) {
    const seconds = Math.round((new Date(e.at).getTime() - start) / 1000);
    const stamp = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

    if (e.event === 'spend' && typeof e.pence === 'number') {
      byStage.set(e.stage, (byStage.get(e.stage) ?? 0) + e.pence);
      continue; // Individual calls are summarised below rather than listed.
    }
    console.log(`  ${stamp}  ${e.stage.padEnd(12)} ${e.event}${e.detail ? ` - ${e.detail}` : ''}`);
  }

  if (byStage.size) {
    console.log('');
    console.log('Where the money went:');
    for (const [stage, pence] of [...byStage].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${stage.padEnd(14)} ${pence.toFixed(1)}p`);
    }
  }
  return 0;
};

/** Rebuild LIBRARY.md from the run directories. */
const cmdLibrary = (): number => {
  const { markdown, json } = writeLibrary();
  console.log(`wrote ${markdown}`);
  console.log(`      ${json}`);
  return 0;
};

const cmdStatus = (argv: string[]): number => {
  const run = openRun(argv);
  const m = run.manifest;
  console.log(`run ${m.id}`);
  console.log(`  show:    ${m.personaId} / ${m.formatId}`);
  console.log(`  topic:   ${m.topic}`);
  console.log(`  created: ${m.createdAt}`);
  console.log(`  spent:   ${m.spentPence.toFixed(1)}p of ${episodeBudgetPence()}p`);
  console.log(`  stages:  ${m.completed.join(' -> ') || '(none)'}`);
  if (m.abandoned) console.log(`  ABANDONED: ${m.abandoned}`);

  if (run.hasArtifact('corpus')) {
    const corpus = run.readArtifact('corpus', corpusSchema);
    console.log(`  corpus:  ${corpus.sources.length} sources, ${corpus.rejected.length} rejected`);
  }
  if (run.hasArtifact('claims')) {
    const claims = run.readArtifact('claims', claimSetSchema);
    console.log(`  claims:  ${claims.claims.length} bound, ${claims.unsupported.length} unsupported`);
  }
  if (run.hasArtifact('render')) {
    const render = run.readArtifact('render', renderResultSchema);
    console.log(`  audio:   ${Math.round(render.durationS)}s (${render.provider}/${render.voiceId})`);
  }
  console.log(`  dir:     ${run.dir}`);
  return 0;
};

const cmdScript = (argv: string[]): number => {
  const run = openRun(argv);
  const script: Script = run.readArtifact('script', scriptSchema);
  console.log(`${script.title}\n${script.description}\n`);
  const persona = loadPersona(script.personaId);
  const nameOf = (id: string) => persona.hosts.find((h) => h.id === id)?.name ?? id;

  for (const beat of script.beats) {
    const revised = beat.revisions ? ` [${beat.revisions} revision(s)]` : '';
    console.log(`--- ${beat.beatId} (${beat.beatType})${revised} ---`);
    for (const turn of beat.turns) {
      // Speaker prefixed even on a narrated show, so reading this aloud matches
      // what the render will actually produce.
      console.log(`${nameOf(turn.speaker).toUpperCase()}: ${turn.text}`);
    }
    console.log('');
  }
  return 0;
};

/**
 * Print every prompt the studio sends a model.
 *
 * WHY THIS IS A COMMAND RATHER THAN A DOCUMENT. Prompt text is the most-edited
 * thing in the repo and most of what has gone wrong with an episode was fixed
 * by changing one. A written copy is stale within a week, and a stale copy is
 * worse than none because somebody then reasons about the version in the
 * document instead of the version being sent.
 *
 * Rendering the composed ones needs a show, because the writer's system prompt
 * is assembled from a persona's canon, hosts and style card. Defaults to the
 * first show rather than demanding one, so that the bare command works.
 */
const cmdPrompts = (argv: string[]): number => {
  const showId = arg(argv, 'show');
  const persona = showId ? loadPersona(showId) : loadAllPersonas()[0];
  if (!persona) {
    console.error('No shows are defined, so there is no persona to render the writer prompt for.');
    return 1;
  }
  const format = loadFormat(persona.formats[0]!);
  const isoDate = new Date().toISOString().slice(0, 10);

  const only = arg(argv, 'only');
  const all = promptRegistry({ persona, format, isoDate });
  const entries = only ? all.filter((e) => e.id === only) : all;
  if (!entries.length) {
    console.error(`No prompt called "${only}". Known: ${all.map((e) => e.id).join(', ')}`);
    return 1;
  }

  const out: string[] = [];
  out.push(`Prompts as of ${isoDate}, rendered for "${persona.name}" (${format.id}).`);
  out.push('');
  out.push('Composed into the writer system prompt:');
  for (const c of COMPOSED_INTO_WRITER) out.push(`  ${c.name.padEnd(24)} ${c.source}`);
  out.push('');

  for (const e of entries) {
    out.push('='.repeat(78));
    out.push(`${e.id}   [${e.stage}]   ${e.source}`);
    out.push('='.repeat(78));
    out.push(e.note);
    out.push('');
    out.push(e.text.trim());
    out.push('');
  }

  const text = out.join('\n');
  const file = arg(argv, 'out');
  if (file) {
    fs.writeFileSync(file, text, 'utf8');
    const words = text.split(/\s+/).filter(Boolean).length;
    console.log(`Wrote ${entries.length} prompt(s), about ${words} words, to ${file}`);
  } else {
    console.log(text);
  }
  return 0;
};

/**
 * Which voice each channel speaks in, and which are still uncommitted.
 *
 * The recorded voice is what listeners have actually heard; the persona is what
 * the next run WOULD use. Showing both together is the point - a disagreement
 * between them is the failure this registry exists to catch, and seeing it here
 * beats discovering it when a run refuses to start.
 */
const cmdVoices = (): number => {
  const registry = loadVoiceRegistry();
  const personas = loadAllPersonas();

  for (const persona of personas) {
    console.log(`${persona.name}  (${persona.id})`);
    for (const host of persona.hosts) {
      const recorded = registry[persona.id]?.[host.id] ?? {};
      const providers = new Set([
        ...Object.keys(recorded),
        host.voice.provider,
        ...(host.voice.draftVoiceId ? ['openai'] : []),
      ]);

      for (const provider of providers) {
        const now = voiceFor(persona, host.id, provider);
        const then = recorded[provider];
        const wanted = now?.voiceId ?? '(none set)';

        if (!then) {
          const pending = wanted.startsWith('REPLACE_') ? 'placeholder, set it before publishing' : 'not committed yet';
          console.log(`  ${host.name} on ${provider}: ${wanted}  ^ ${pending}`);
          continue;
        }

        const agrees = then.voiceId === wanted;
        console.log(
          `  ${host.name} on ${provider}: ${then.voiceId}  since ${then.firstUsedAt.slice(0, 10)}` +
            (agrees ? '' : `  ^ PERSONA NOW SAYS "${wanted}" - runs will refuse`)
        );
      }
    }
    console.log('');
  }

  console.log(`Recorded in ${path.relative(process.cwd(), voiceRegistryPath())}, which is committed.`);
  console.log('A voice is pinned the first time a channel renders audio, and never re-pointed.');
  return 0;
};

/**
 * Release a channel's voice on purpose.
 *
 * Separate from everything else so that changing a show's voice is always two
 * decisions rather than a side effect of editing a persona file. It prints what
 * it released, because that line is the record of when the show changed.
 */
const cmdVoiceRetire = (argv: string[]): number => {
  const showId = arg(argv, 'show');
  if (!showId) {
    console.error('Usage: voice-retire --show <id> [--provider <name>]');
    return 1;
  }

  const persona = loadPersona(showId);
  const provider = arg(argv, 'provider');
  const registry = loadVoiceRegistry();
  const before = registry[persona.id];

  if (!before) {
    console.log(`${persona.name} has no committed voice to release.`);
    return 0;
  }

  for (const [hostId, byProvider] of Object.entries(before)) {
    for (const [p, record] of Object.entries(byProvider)) {
      if (provider && p !== provider) continue;
      console.log(
        `releasing ${persona.name} / ${hostId} on ${p}: "${record.voiceId}", ` +
          `used since ${record.firstUsedAt.slice(0, 10)} (${record.firstRunId})`
      );
    }
  }

  saveVoiceRegistry(retireVoices(persona.id, registry, provider));
  console.log('');
  console.log('The next run commits whatever the persona file says. Commit that change too.');
  return 0;
};

/**
 * Run the gate again, over what is on disk now.
 *
 * IT USED TO PRINT THE STORED REPORT, while its usage text said "re-run the
 * gate over an existing run". So a check changed this morning stayed invisible
 * until the next full run paid for research and a script to reveal it, and a
 * fever episode was re-gated against a claim floor that had already been
 * lowered - showing the old number twice, convincingly.
 *
 * Costs nothing: every check is deterministic arithmetic over things already on
 * disk. The recomputed report is written back, so the run's own record is the
 * current one rather than a stale artifact somebody reads later.
 */
const cmdGate = (argv: string[]): number => {
  const run = openRun(argv);

  if (!run.hasArtifact('script')) {
    console.error(`run ${run.id} has no script yet, so there is nothing to gate.`);
    return 1;
  }

  const fresh = regate(run, run.readArtifact('script', scriptSchema));
  if (!fresh) {
    // A script with no verification behind it has no ledger to check. Saying so
    // beats inventing a passing report, which is the most dangerous default
    // available here.
    console.error(
      `run ${run.id} cannot be gated: it has no verified claims behind its script.`
    );
    return 1;
  }

  run.writeArtifact('qa', fresh);
  run.markComplete('qa');

  console.log(formatGateReport(fresh));
  return fresh.passed ? 0 : 2;
};

/**
 * Pairwise comparison of two finished scripts.
 *
 * Separate from the pipeline on purpose: the gate answers "may this go out",
 * which is a floor, and cannot answer "is this getting better". That second
 * question is asked occasionally - after changing a beat sheet or a style card -
 * so it is a command rather than a stage, and costs nothing on an ordinary run.
 */
const cmdCompare = async (argv: string[]): Promise<number> => {
  const aId = arg(argv, 'a');
  const bId = arg(argv, 'b');
  if (!aId || !bId) {
    console.error('Usage: compare --a <run-id> --b <run-id>');
    return 1;
  }

  const load = (id: string) => {
    const run = Run.open(id);
    const script = run.readArtifact('script', scriptSchema);
    return { label: id, title: script.title, text: fullText(script) };
  };

  const verifier = verifierConfig();
  // The verifier client, not the writer: a model scores its own family's output
  // higher, by as much as tens of percent, and the verifier is already required
  // to be a different family from the writer.
  const judge = new OpenAiClient(verifier.model, verifier.apiKey);

  const result = await compare(load(aId), load(bId), judge);
  console.log(formatComparison(result));
  return 0;
};

const cmdPublish = async (argv: string[]): Promise<number> => {
  const run = openRun(argv);
  const gate = readGate(run);

  if (!gate.passed) {
    console.error('This run did not pass the gate. Publishing it is not available.');
    console.error(formatGateReport(gate));
    return 1;
  }

  if (gate.needsHumanReview && !flag(argv, 'yes')) {
    console.error('This run needs a human before it goes out:\n');
    for (const r of gate.humanReviewReasons) console.error(`  - ${r}`);
    console.error(`\nRead it:  npm run foundry -- script --run ${run.id}`);
    console.error('Then re-run this command with --yes to confirm you have.');
    return 1;
  }

  const platform = platformConfig();
  if (platform.isProduction && !flag(argv, 'yes')) {
    // Publishing to production notifies followers, warms feed caches and writes
    // the seen ledger. None of that can be taken back.
    console.error(`AUDIOVIBE_API_URL points at PRODUCTION (${platform.url}).`);
    console.error('Re-run with --yes if that is what you meant.');
    return 1;
  }

  const persona = loadPersona(run.manifest.personaId);
  const script = run.readArtifact('script', scriptSchema);
  const render = run.readArtifact('render', renderResultSchema);

  // WHICH RECEIPTS THIS EPISODE CARRIES.
  //
  // A fiction run has no corpus and its `claims` artifact holds established
  // facts rather than sourced claims, so reading it through the reported path
  // fails outright. It used to, and nothing in the fiction pipeline would ever
  // have noticed: the break was here, at the last command.
  //
  // The two are kept apart rather than merged behind empty arrays because a
  // fiction episode with no sources needs none, while a reported episode with
  // no sources has failed - and the Sources sheet must not render those two the
  // same way. See publish/provenance.ts.
  const provenance = persona.fiction
    ? (() => {
        const continuity = run.readArtifact('verification', continuityArtifactSchema);
        return buildFictionProvenance({
          personaId: persona.id,
          factsChecked: continuity.findings.length,
          priorEpisodes: loadBible(persona.id).episodes.length,
          models: {
            writer: script.writerModel,
            continuityChecker: continuity.checkerModel,
            tts: `${render.provider}/${render.model}`,
            voice: render.voiceId,
          },
          renderedAt: new Date(),
        });
      })()
    : (() => {
        const corpus = run.readArtifact('corpus', corpusSchema);
        const claims = run.readArtifact('claims', claimSetSchema);
        const verification = readVerification(run);
        return buildProvenance({
          personaId: persona.id,
          claims: claims.claims,
          sources: corpus.sources,
          counterEvidence: (verification.counterEvidence ?? []) as never,
          // The human confirmed it by passing --yes past the review gate above.
          counterEvidenceAddressed: flag(argv, 'yes'),
          models: {
            writer: script.writerModel,
            verifier: verification.verification?.verifierModel ?? 'unknown',
            tts: `${render.provider}/${render.model}`,
            voice: render.voiceId,
          },
          renderedAt: new Date(),
        });
      })();

  const client = new AudioVibeClient(platform.url, platform.token);

  // WHICH SHELF, IF ANY.
  //
  // A short always publishes as a loose card, whatever the show does with its
  // long episodes: a short's job is to be found by somebody who has never heard
  // of the show, and burying it inside a series shelf is the opposite of that.
  //
  // For everything else, a show that publishes as a series MUST have one
  // already. Creating it here would mean a publish silently making a second
  // shelf whenever the registry was missing, and the registry going missing is
  // exactly the situation where you least want that.
  const format = loadFormat(run.manifest.formatId);
  const wantsSeries = persona.publishesAsSeries && format.kind !== 'short';

  let seriesId: string | undefined;
  if (wantsSeries) {
    const record = findSeries(persona.id, platform.url);
    if (!record) {
      console.error(
        `${persona.name} publishes as a series and has none on ${environmentKey(platform.url)} yet.`
      );
      console.error(`Make it once:  npm run foundry -- series-setup --show ${persona.id}`);
      return 1;
    }
    seriesId = record.seriesId;
    console.log(`publishing into "${record.title}" (${seriesId})`);
  }

  // COVER ART IS DRAWN HERE, NOT AT RENDER TIME, because it depends on the
  // title and on nothing expensive. Drawing it costs nothing and is
  // deterministic, so re-publishing never quietly changes the artwork of
  // something already in a listener's library. See art/cover.ts for why this
  // is typography rather than a generated image.
  const coverPath = renderCover(
    {
      showName: persona.name,
      title: script.title,
      palette: paletteFor(persona.id),
      episodeNumber: seriesId ? episodeNumberFor(run, persona) : undefined,
      kind: format.kind === 'short' ? 'short' : 'episode',
    },
    run.mediaPath('cover.png')
  );

  console.log(`publishing to ${platform.url} as @${persona.handle}...`);

  const result = await client.publish({
    title: script.title,
    description: script.description,
    audioPath: render.audioFile,
    category: persona.category,
    beatMap: render.beatMap,
    provenance,
    seriesId,
    coverPath,
  });

  run.writeArtifact('publish', { ...result, publishedAt: new Date().toISOString(), url: platform.url });
  run.markComplete('publish');

  console.log(`published: audio ${result.audioId} (${result.status})`);
  return 0;
};

export const run = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE.trim());
    return 0;
  }

  try {
    switch (command) {
      case 'shows':
        return cmdShows();
      case 'make':
        return await cmdMake(rest);
      case 'short':
        return await cmdShort(rest);
      case 'shorts':
        return await cmdShorts(rest);
      case 'series':
        return cmdSeries(rest);
      case 'series-setup':
        return await cmdSeriesSetup(rest);
      case 'due':
        return cmdDue();
      case 'tick':
        return await cmdTick(rest);
      case 'studio':
        await serve();
        // The server owns the process from here. Returning a code would set
        // process.exitCode and the entry point would tidy up underneath it.
        return await new Promise<number>(() => undefined);
      case 'channel-setup':
        return await cmdChannelSetup(rest);
      case 'approve':
        return await cmdApprove(rest);
      case 'resume':
        return await finishRun(openRun(rest), rest);
      case 'status':
        return cmdStatus(rest);
      case 'journal':
        return cmdJournal(rest);
      case 'library':
        return cmdLibrary();
      case 'script':
        return cmdScript(rest);
      case 'voices':
        return cmdVoices();
      case 'voice-retire':
        return cmdVoiceRetire(rest);
      case 'prompts':
        return cmdPrompts(rest);
      case 'gate':
        return cmdGate(rest);
      case 'compare':
        return await cmdCompare(rest);
      case 'publish':
        return await cmdPublish(rest);
      default:
        console.error(`Unknown command: ${command}\n`);
        console.error(USAGE.trim());
        return 1;
    }
  } catch (err) {
    console.error(`\n${(err as Error).message}`);

    // A failure mid-run has almost always left work on disk worth resuming, and
    // the one thing somebody needs at that moment is the command that picks it
    // up rather than the command that starts again.
    try {
      const latest = Run.latest();
      if (latest && !latest.isComplete('qa')) {
        console.error('\nThe run kept everything it finished. Pick it up with:');
        console.error(`  npm run foundry -- resume --run ${latest.id}`);
        console.error(`  npm run foundry -- journal --run ${latest.id}`);
      }
    } catch {
      // Advice is not worth a second failure on top of the first.
    }
    return 1;
  }
};

/* istanbul ignore next -- entry point */
if (require.main === module) {
  const finish = (code: number) => {
    // SET THE CODE, DO NOT CALL process.exit. Calling exit while fetch still
    // holds keep-alive sockets crashes the Windows event loop with
    // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" - which is what
    // happened on the first real run, printed after the actual error and
    // looking far more alarming than the thing that caused it.
    //
    // Setting exitCode lets Node drain and leave on its own. The unref'd timer
    // is the backstop: if a socket somehow keeps the loop alive the process
    // still exits, and the timer never holds it open itself.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2000).unref();
  };

  run(process.argv.slice(2)).then(finish, (err) => {
    console.error(`\n${(err as Error)?.message ?? String(err)}`);
    finish(1);
  });
}
