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
import path from 'path';
import { z } from 'zod';
import {
  clerkConfig,
  episodeBudgetPence,
  platformConfig,
  ttsConfig,
  verifierConfig,
  writerConfig,
} from './config';
import { loadAllFormats, loadFormat } from './formats/load';
import { loadAllPersonas, loadPersona } from './canon/load';
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
import { ElevenLabsTts } from './render/tts';
import { runEpisode, PipelineDeps } from './pipeline/episode';
import { runShort } from './pipeline/short';
import { runFiction } from './pipeline/fiction';
import { castBrief, loadBible, storySoFar } from './fiction/bible';
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
  short --run <id> [--format <id>]
                                 Cut a short out of an episode that passed
  resume [--run <id>]            Continue a run (default: the most recent)
  status [--run <id>]            What a run has done and what it cost
  gate [--run <id>]              Re-run the gate over an existing run
  script [--run <id>]            Print the script, for reading aloud
  publish --run <id> [--yes]     Publish a run that passed the gate
  compare --a <run> --b <run>    Which of two scripts is better to listen to
  series --show <id>             What a fiction show has established so far

Notes
  make stops at the gate. Publishing is always a separate, deliberate step.
  Every stage is resumable: a failed gate does not mean re-rendering.
  short derives from a finished episode rather than researching its own, which
  is why it costs about a ninth of what a standalone short would. It produces
  its own run, publishable the same way as any other.
  A fiction show skips the entire evidence pipeline - there is no document that
  entails an invented scene - and is checked against its series bible instead.
  That is a property of the SHOW, set in its persona file, never a flag.
`;

const arg = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
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

const buildDeps = (): PipelineDeps => {
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

  return {
    writer: new AnthropicClient(writer.model, writer.apiKey),
    verifier: new OpenAiClient(verifier.model, verifier.apiKey),
    clerk: new AnthropicClient(clerk.model, clerk.apiKey),
    search,
    tts: new ElevenLabsTts(ttsConfig().apiKey),
    fetchDeps: { httpGet: get },
    priorTexts: priorEpisodeTexts(),
    log: (m) => console.log(`  ${m}`),
  };
};

/** Earlier episodes from this repo's runs, for the self-similarity check. */
const priorEpisodeTexts = (): Array<{ label: string; text: string }> => {
  const out: Array<{ label: string; text: string }> = [];
  for (const id of Run.list()) {
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
      console.log(`    ${h.id} (${h.name})  ${h.voice.provider}/${h.voice.voiceId}`);
      if (h.voice.voiceId.startsWith('REPLACE_')) {
        console.log('      ^ placeholder. Set a real voice before publishing, then never change it.');
      }
    }
    console.log('');
  }
  console.log(`Formats available: ${formats.map((f) => f.id).join(', ') || '(none)'}`);
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
  loadFormat(formatId); // Fail now if it is missing, not after the first API call.

  const run = Run.create({ personaId: persona.id, formatId, topic });
  console.log(`run ${run.id}`);
  console.log(`  budget ${episodeBudgetPence()}p\n`);

  return finishRun(run, argv);
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

  console.log(`publishing to ${platform.url} as @${persona.handle}...`);

  const client = new AudioVibeClient(platform.url, platform.token);
  const result = await client.publish({
    title: script.title,
    description: script.description,
    audioPath: render.audioFile,
    category: persona.category,
    beatMap: render.beatMap,
    provenance,
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
      case 'resume':
        return await finishRun(openRun(rest), rest);
      case 'status':
        return cmdStatus(rest);
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
    return 1;
  }
};

/* istanbul ignore next -- entry point */
if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
