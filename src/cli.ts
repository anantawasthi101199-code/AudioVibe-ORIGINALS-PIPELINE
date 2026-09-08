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
import {
  episodeBudgetPence,
  platformConfig,
  ttsConfig,
  verifierConfig,
  writerConfig,
  ConfigError,
} from './config';
import { loadAllFormats, loadFormat } from './formats/load';
import { loadAllPersonas, loadPersona } from './canon/load';
import { AnthropicClient, OpenAiClient } from './models/client';
import { BraveSearch } from './evidence/search';
import { HttpResponse } from './evidence/fetch';
import { ElevenLabsTts } from './render/tts';
import { runEpisode, PipelineDeps } from './pipeline/episode';
import { Run } from './run/store';
import { formatGateReport, GateReport } from './qa/gate';
import { fullText, Script, scriptSchema } from './script/write';
import { renderResultSchema } from './render/assemble';
import { claimSetSchema, corpusSchema } from './evidence/research';
import { AudioVibeClient } from './publish/ingest';
import { buildProvenance } from './publish/provenance';

const USAGE = `
AudioVibe Foundry

  npm run foundry -- <command> [options]

Commands
  shows                          List the shows and their formats
  make --show <id> --topic "..." Research, write, render and gate one episode
  resume [--run <id>]            Continue a run (default: the most recent)
  status [--run <id>]            What a run has done and what it cost
  gate [--run <id>]              Re-run the gate over an existing run
  script [--run <id>]            Print the script, for reading aloud
  publish --run <id> [--yes]     Publish a run that passed the gate

Notes
  make stops at the gate. Publishing is always a separate, deliberate step.
  Every stage is resumable: a failed gate does not mean re-rendering.
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
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) throw new ConfigError('BRAVE_SEARCH_API_KEY', 'is not set');

  if (writer.model === verifier.model) {
    // The check exists because collapsing these is easy, silent, and destroys
    // the point of verification.
    throw new Error(
      `the writer and verifier are both "${writer.model}". A verifier sharing the ` +
        `writer's priors reconstructs its justification instead of checking the text.`
    );
  }

  return {
    writer: new AnthropicClient(writer.model, writer.apiKey),
    verifier: new OpenAiClient(verifier.model, verifier.apiKey),
    search: new BraveSearch(braveKey),
    tts: new ElevenLabsTts(ttsConfig().apiKey),
    fetchDeps: { httpGet },
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
    console.log(`  voice:    ${p.voice.provider}/${p.voice.voiceId}`);
    if (p.voice.voiceId.startsWith('REPLACE_')) {
      console.log('            ^ placeholder. Set a real voice before publishing, then never change it.');
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

const finishRun = async (run: Run, _argv: string[]): Promise<number> => {
  const deps = buildDeps();
  const { gate } = await runEpisode(run, deps);

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
  for (const beat of script.beats) {
    console.log(`--- ${beat.beatId} (${beat.beatType}) ---`);
    console.log(`${beat.text}\n`);
  }
  return 0;
};

const cmdGate = (argv: string[]): number => {
  const gate = readGate(openRun(argv));
  console.log(formatGateReport(gate));
  return gate.passed ? 0 : 2;
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
  const corpus = run.readArtifact('corpus', corpusSchema);
  const claims = run.readArtifact('claims', claimSetSchema);
  const verification = readVerification(run);

  const provenance = buildProvenance({
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
      case 'resume':
        return await finishRun(openRun(rest), rest);
      case 'status':
        return cmdStatus(rest);
      case 'script':
        return cmdScript(rest);
      case 'gate':
        return cmdGate(rest);
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
