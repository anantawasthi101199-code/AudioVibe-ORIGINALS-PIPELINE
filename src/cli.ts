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
  clerkConfig,
  screenerConfig,
  episodeBudgetPence,
  platformConfig,
  openAiTtsConfig,
  ttsConfig,
  ttsProvider,
  verifierConfig,
  writerConfig,
} from './config';
import { loadAllFormats, loadFormat } from './formats/load';
import { loadAllPersonas, loadPersona } from './canon/load';
import { Persona } from './canon/schema';
import { AnthropicClient, OpenAiClient } from './models/client';
import { BraveSearch } from './evidence/search';
import {
  buildSearch,
  describeRetrieval,
  ExaSearch,
  firecrawlGet,
  retrievalKeys,
} from './evidence/providers';
import { HttpResponse } from './evidence/fetch';
import { ElevenLabsTts, nodePostBinary } from './render/tts';
import { onProviderWait } from './models/client';
import { OpenAiTts } from './render/openaiTts';
import { runEpisode, PipelineDeps } from './pipeline/episode';
import { runShort } from './pipeline/short';
import { runFiction } from './pipeline/fiction';
import { castBrief, loadBible, storySoFar } from './fiction/bible';
import { environmentKey, findSeries, recordSeries } from './publish/seriesRegistry';
import { SERIES_COVER_SIZE, paletteFor, renderCover } from './art/cover';
import { buildPlan, historyFor, runSummary } from './schedule/plan';
import { writeLibrary } from './run/library';
import { costPenceFor } from './models/client';
import { EpisodeFormat } from './formats/schema';
import { loadSchedule, loadTopics, returnTopic, takeTopic } from './schedule/load';
import { Run } from './run/store';
import { formatGateReport, GateReport } from './qa/gate';
import { compare, formatComparison } from './qa/compare';
import { fullText, Script, scriptSchema } from './script/write';
import { renderResultSchema } from './render/assemble';
import { claimSetSchema, corpusSchema } from './evidence/research';
import { AudioVibeClient } from './publish/ingest';
import { buildFictionProvenance, buildProvenance } from './publish/provenance';

const USAGE = `
AudioVibe Foundry

  npm run foundry -- <command> [options]

Commands
  shows                          List the shows and their formats
  make --show <id> --topic "..." Write, render and gate one episode
                                 (fiction shows skip research, see Notes)
      ... --dry-run              What it would do and cost. Spends nothing.
  short --run <id> [--format <id>]
                                 Cut a short out of an episode that passed
  resume [--run <id>]            Continue a run (default: the most recent)
  status [--run <id>]            What a run has done and what it cost
  journal [--run <id>]           Minute by minute, and where the money went
  library                        Rebuild LIBRARY.md from every run
  gate [--run <id>]              Re-run the gate over an existing run
  script [--run <id>]            Print the script, for reading aloud
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
const httpGet = async (url: string): Promise<HttpResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Plenty of publishers serve a stub to an unrecognised client, which
        // then reads as a paywall. Identifying honestly as a bot gets fewer
        // documents than this does.
        'user-agent':
          'Mozilla/5.0 (compatible; AudioVibeFoundry/0.1; +https://audiovibe.co) research fetcher',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    return {
      status: res.status,
      body: await res.text(),
      finalUrl: res.url || url,
      contentType: res.headers.get('content-type') ?? undefined,
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The voice engine, chosen by FOUNDRY_TTS.
 *
 * Loud about which one it picked, because the two sound different enough that
 * listening to a draft and forgetting which engine made it is a real way to
 * reach a wrong conclusion about the writing.
 */
const buildTts = () => {
  if (ttsProvider() === 'openai') {
    const cfg = openAiTtsConfig();
    console.log(`  voices: ${cfg.model} (drafting - turns are spliced, not a real exchange)`);
    return new OpenAiTts(cfg.apiKey, { post: nodePostBinary, model: cfg.model });
  }

  console.log('  voices: elevenlabs (the exchange is rendered in one request)');
  return new ElevenLabsTts(ttsConfig().apiKey);
};

const buildDeps = (): PipelineDeps => {
  // A rate limit is a WAIT, not a failure, and a run that goes quiet for two
  // minutes is indistinguishable from a hang. Saying so is the difference
  // between somebody waiting and somebody pressing Ctrl-C on a call that was
  // about to succeed.
  onProviderWait((message) => console.log(`  ${message}`));

  const writer = writerConfig();
  const verifier = verifierConfig();
  const clerk = clerkConfig();
  const keys = retrievalKeys();

  if (writer.model === verifier.model) {
    // The check exists because collapsing these is easy, silent, and destroys
    // the point of verification.
    throw new Error(
      `the writer and verifier are both "${writer.model}". A verifier sharing the ` +
        `writer's priors reconstructs its justification instead of checking the text.`
    );
  }

  const search = buildSearch(keys, {
    brave: (k) => new BraveSearch(k),
    exa: (k) => new ExaSearch(k),
  });

  // Firecrawl renders JavaScript, which is the difference between a corpus and
  // a pile of "paywall or a JS shell" rejections on some topics. It falls back
  // to the plain fetcher per URL, so being out of credit costs documents rather
  // than the run.
  const get = keys.firecrawl ? firecrawlGet(keys.firecrawl, httpGet) : httpGet;

  console.log(`  retrieval: ${describeRetrieval(keys)}`);

  console.log(
    `  models: ${writer.model} writing, ${verifier.model} verifying, ${clerk.model} clerking`
  );

  const screener = screenerConfig();
  if (screener) {
    console.log(`  screening: ${screener.model} first, escalating anything unclear`);
  }

  return {
    writer: new AnthropicClient(writer.model, writer.apiKey),
    verifier: new OpenAiClient(verifier.model, verifier.apiKey),
    clerk: new AnthropicClient(clerk.model, clerk.apiKey),
    screener: screener ? new OpenAiClient(screener.model, screener.apiKey) : undefined,
    search,
    tts: buildTts(),
    fetchDeps: { httpGet: get },
    // Narrowed per run in finishRun, which knows which run is being gated.
    priorTexts: priorEpisodeTexts(),
    log: (m) => console.log(`  ${m}`),
  };
};

/** Earlier episodes from this repo's runs, for the self-similarity check. */
const priorEpisodeTexts = (exclude?: string): Array<{ label: string; text: string }> => {
  const out: Array<{ label: string; text: string }> = [];
  for (const id of Run.list()) {
    // NEVER THE RUN BEING GATED. Every script shares one hundred percent of its
    // vocabulary with itself, so including it made self-similarity fail on
    // every episode this studio has ever produced - loudly, with a message
    // naming the run as its own plagiarism source, which at least made it
    // obvious once somebody read it.
    if (id === exclude) continue;

    try {
      const run = Run.open(id);
      if (!run.hasArtifact('script')) continue;
      out.push({ label: id, text: fullText(run.readArtifact('script', scriptSchema)) });
    } catch {
      // A malformed old run should not stop a new one.
    }
  }
  return out;
};

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

  if (flag(argv, 'dry-run')) return describeRun(persona, format, topic);

  const run = Run.create({ personaId: persona.id, formatId, topic });
  console.log(`run ${run.id}`);
  console.log(`  budget ${episodeBudgetPence()}p\n`);

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
const describeRun = (persona: Persona, format: EpisodeFormat, topic: string): number => {
  const writer = writerConfig();
  const verifier = verifierConfig();
  const engine = ttsProvider();

  // Rough token shapes per call, from what the prompts actually contain. Wrong
  // in the third significant figure and right in the first, which is the
  // accuracy this is for.
  const beats = format.beats.length;
  const claimFloor = format.beats.reduce((n, b) => n + b.minClaims, 0);
  const estimatedClaims = Math.max(claimFloor, beats * 3);

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
        if (!screener) return write(verifier.model, estimatedClaims, 1_400, 200);
        // Every claim is screened; roughly a fifth need the strong model. That
        // fraction is a guess and the only soft number in this table.
        return (
          write(screener.model, estimatedClaims, 1_400, 200) +
          write(verifier.model, Math.ceil(estimatedClaims * 0.2), 1_400, 200)
        );
      })(),
      screenerConfig()
        ? `~${estimatedClaims} screened on ${screenerConfig()!.model}, ~${Math.ceil(estimatedClaims * 0.2)} escalated`
        : `~${estimatedClaims} calls, one per claim`,
    ],
    [
      'script',
      write(writer.model, 1, 2_000, 1_500) + write(writer.model, beats * 1.6, 3_500, 1_200),
      `hook competition + ~${Math.round(beats * 1.6)} beat calls (${beats} beats, some revised)`,
    ],
    ['title', write(writer.model, 1, 1_200, 200), '1 call'],
  ];

  // Speech is roughly 150 words a minute and 5.5 characters a word.
  const nominal = (format.targetSeconds[0] + format.targetSeconds[1]) / 2;
  const characters = Math.round((nominal / 60) * 150 * 5.5);
  const voicePence = engine === 'openai' ? (characters / 1_000_000) * 1200 : (characters / 1000) * 20;

  stages.push(['render', voicePence, `~${characters.toLocaleString()} characters on ${engine}`]);

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
  console.log('It will STOP AT THE GATE and publish nothing. Run without --dry-run to make it.');
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
  const deps = buildDeps();
  const persona = loadPersona(run.manifest.personaId);

  // Self-similarity compares against every OTHER run. buildDeps cannot know
  // which run is being gated, so it is narrowed here, where that is known.
  deps.priorTexts = priorEpisodeTexts(run.id);

  const { gate } = persona.fiction
    ? await runFiction({ run }, deps)
    : await runEpisode(run, deps);

  console.log('');
  console.log(formatGateReport(gate));
  console.log('');
  console.log(`spent ${run.manifest.spentPence.toFixed(1)}p`);
  console.log(`artifacts in ${run.dir}`);

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

  if (!plan.due.length && !plan.blocked.length) {
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

const cmdGate = (argv: string[]): number => {
  const gate = readGate(openRun(argv));
  console.log(formatGateReport(gate));
  return gate.passed ? 0 : 2;
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
      case 'series':
        return cmdSeries(rest);
      case 'series-setup':
        return await cmdSeriesSetup(rest);
      case 'due':
        return cmdDue();
      case 'tick':
        return await cmdTick(rest);
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
