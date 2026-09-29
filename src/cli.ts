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
import {
  screenerConfig,
  episodeBudgetPence,
  platformUrl,
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
import { runNews } from './pipeline/news';
import { hasNewsDesk, loadDesk } from './news/desk';
import { castBrief, loadBible, storySoFar } from './fiction/bible';
import {
  SEASON_EPISODES,
  checkPlan,
  loadPlan,
  renderPlan,
  savePlan,
} from './fiction/season';
import { planSeason } from './fiction/planner';
import {
  blocking,
  findCovered,
  loadCatalogue,
  recordMade,
  refusal,
} from './catalogue/covered';
import { BED_STYLES, isBedStyle } from './render/bed';
import {
  KEYS,
  audioPath,
  bedsDir,
  buildBeat,
  isKey,
  listBeats,
  loadBeat,
  saveBeat,
} from './render/beats';
import { environmentKey, findSeries, recordSeries } from './publish/seriesRegistry';
import { SERIES_COVER_SIZE, paletteFor, renderCover } from './art/cover';
import { currentPlan } from './schedule/current';
import { writeLibrary } from './run/library';
import { costPenceFor, OpenAiClient } from './models/client';
import { EpisodeFormat } from './formats/schema';
import { COMPOSED_INTO_WRITER, promptRegistry } from './prompts/registry';
import { loadSchedule, returnTopic, takeTopic } from './schedule/load';
import { Run, STAGES } from './run/store';
import { buildDeps, priorEpisodeTexts } from './deps';
import { Reporter } from './cli/ui';
import { setUpChannel } from './pipeline/channel';
import { PublishRefused, publishRun } from './publish/publishRun';
import { dueForRelease, releaseDue } from './publish/release';
import { unpublish } from './publish/unpublish';
import {
  accountsPath,
  loadAccounts,
  publishTokenFor,
  saveAccounts,
} from './publish/account';
import { imageModel, imageQuality, imagesEnabled } from './art/generate';
import { serve } from './server/index';
import { formatGateReport, GateReport } from './qa/gate';
import {
  StageFlags,
  stageFlags,
  stageOverridesFromArgv,
  stagesOff,
} from './config/stages';
import { regate } from './qa/regate';
import { compare, formatComparison } from './qa/compare';
import { fullText, Script, scriptSchema } from './script/write';
import { renderResultSchema } from './render/assemble';
import { claimCeiling, claimSetSchema, corpusSchema } from './evidence/research';
import { VERIFY_SAMPLE, verifyMode } from './evidence/verify';
import { AudioVibeClient } from './publish/ingest';

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
      ... --research single     Build the episode from the one to three documents
                                 that carry the whole story, read whole and
                                 fused into one reference article. No claim
                                 ledger. This is what a told story wants.
      ... --research extensive   Search wide, extract claims bound to verbatim
                                 quotes, verify each one. This is what a
                                 subject assembled from many documents wants.
                                 Both default to whatever the format declares.
      ... --render-now           Skip the approval break and voice it straight
                                 away. Spends without anybody reading it first.
  make --show geopolitics-today  A NEWS channel (it has desks/<id>.yaml): today's
                                 top story on its beat, from ONE article by a
                                 trusted outlet, under 3 minutes. --topic "..."
                                 for one specific story. Renders at once;
                                 --hold stops before audio. See docs/NEWS.md.
      ... --no-music             Render a bare voice with no bed under it.
                                 The bed is synthesised locally and is free,
                                 so this is for judging the writing, not cost.

      EVERY PAID CHECK IS OFF BY DEFAULT. The floor is the cheapest thing that
      produces an episode; each pass goes back on by name when it has earned
      its cost. Free deterministic checks (style card, critique, hedging,
      speakability, the gate) always run and always report.
      ... --reference-check      Read the fused reference back against its own
                                 documents. On the single-story lane this is
                                 the ONLY thing that checks what the episode
                                 says. About 50-80p.
      ... --script-revisions     Pay a model to rewrite a draft that failed its
                                 style checks. The largest avoidable cost there
                                 is: one run spent 12p writing and 87p
                                 rewriting.
      ... --perform              One delivery pass over the finished script.
                                 Cannot add a fact, only readability.
      ... --grounding            Read the script against the claim ledger.
                                 Extensive lane only.
      ... --counter-evidence     Search for sources that disagree with a
                                 contested claim. Extensive lane only.
      ... --repair  --gaps       Rescue and backfill claims. Extensive only.
  approve --run <id>             Release a held run, then render and gate it.
                                 Nothing is voiced until this.
  channel-setup --show <id> [--redraw]
                                 Create this channel on the platform, once:
                                 account, profile, avatar, cover. Needs
                                 AUDIOVIBE_ADMIN_EMAIL and _PASSWORD. Safe to
                                 re-run; --redraw replaces the artwork rather
                                 than reusing what is on disk.
  channel-token --show <id> --token <jwt>
                                 Record the publishing credential a person
                                 minted on the API server. A channel cannot
                                 publish until this is done; the platform has
                                 no endpoint that issues these, on purpose.
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
  categories                     The platform's categories, and whether every
                                 show names one. A category must match a row in
                                 the platform's database, and a wrong one is
                                 only discovered at the end of a publish.
  release [--dry-run]            Publish whatever was approved and is due, one
                                 per run. For cron or Task Scheduler; the
                                 studio does the same on a timer while open.
  unpublish --run <id> [--yes]   Delete a published run from the platform and
                                 make it publishable again here. For the first
                                 few of a channel, where publishing is really
                                 looking at the result.
  publish --run <id> [--yes]     Publish a run that passed the gate
  compare --a <run> --b <run>    Which of two scripts is better to listen to
  beat --name <name>             Synthesise a background loop and keep it, so a
       [--style piano|strings|epic]  show has a sound instead of a setting.
       [--key a..e] [--note "..."]   --list shows what exists. Use one with
                                     "make ... --bed <name>".
  covered [--show <id>]          What the studio has already made, so it does
          [--backfill]            not make it twice. --backfill seeds the ledger
                                  from existing runs. "make" refuses a repeat
                                  unless you pass --again.
  season --show <id>             Break a season: plan every episode of a serial
         [--episodes N]          before writing any of them. Costs about a tenth
         [--season N]            of one episode, writes the plan to disk and
         [--premise "..."]       stops. Add --show-plan to read one back.
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
const readGate = (run: Run): GateReport =>
  JSON.parse(fs.readFileSync(path.join(run.dir, 'qa.json'), 'utf8')) as GateReport;

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

/**
 * Stop a run that would remake something the show has already covered.
 *
 * BEFORE Run.create AND BEFORE ANY PAID STAGE, which is the only placement that
 * makes it worth having. The whole value is that a duplicate costs nothing
 * rather than the price of an episode, and a check that runs after the research
 * has been paid for has saved exactly the render.
 *
 * SKIPPED FOR FICTION AND NEWS, and not as an oversight. Both reuse one topic
 * string for every episode they ever make - a fiction show passes its own
 * thesis and a news desk passes its beat - so the check would block their
 * second episode and every episode after it. Each already has the right version
 * of this idea: a serial has the season plan and its episode numbers, and a
 * news desk has its own already-reported test in news/check.ts.
 *
 * Returns true when the caller should stop.
 */
const coveredAlready = (persona: Persona, topic: string, argv: string[]): boolean => {
  if (persona.fiction || hasNewsDesk(persona.id)) return false;
  if (flag(argv, 'again')) return false;

  const matches = findCovered(loadCatalogue(), persona.id, topic);
  const blocked = blocking(matches);

  if (blocked.length) {
    console.error(refusal(persona.id, topic, blocked));
    return true;
  }

  // Near misses are worth seeing and must never stop anything. A check that
  // blocks two genuinely different episodes is a check somebody turns off.
  for (const m of matches) {
    const where = m.sameShow ? 'this show' : m.entry.showId;
    console.log(`  note: ${where} has something close - "${m.entry.topic}" (${m.entry.runId})`);
  }

  return false;
};

const cmdMake = async (argv: string[]): Promise<number> => {
  const showId = arg(argv, 'show');
  // A NEWS CHANNEL NEEDS NO TOPIC: its desk's beat means "today's most
  // important story on it". See news/desk.ts.
  const news = !!showId && hasNewsDesk(showId);
  const topic = arg(argv, 'topic') ?? (news ? loadDesk(showId!).beat : undefined);
  if (!showId || !topic) {
    console.error('Usage: make --show <id> --topic "what the episode is about"');
    return 1;
  }

  const persona = loadPersona(showId);
  const formatId = arg(argv, 'format') ?? persona.formats[0]!;
  const format = loadFormat(formatId); // Fail now, not after the first API call.

  if (news && flag(argv, 'dry-run')) {
    console.log(`${persona.name}: news report on "${topic}", from ONE article, under 3 minutes.`);
    console.log('  wire + story + article   free (Brave News, fetch, arithmetic)');
    console.log('  write                    ~2-4p (one call: headline, report, goodbye)');
    console.log(`  render                   ~2-3p on ${ttsProvider()}`);
    console.log('  checks + gate            free');
    console.log('It renders straight away (news goes stale; --hold to stop before audio)');
    console.log('and publishes nothing.');
    return 0;
  }

  if (flag(argv, 'dry-run')) {
    const asked = arg(argv, 'research');
    return describeRun(
      persona,
      format,
      topic,
      !flag(argv, 'beat-by-beat'),
      asked === 'single' || asked === 'extensive' ? asked : undefined
    );
  }

  // ONE PASS IS THE DEFAULT. `--beat-by-beat` goes back, and `--one-pass` is
  // still accepted because it is in the history and in people's shell history.
  //
  // RECORDED ON THE RUN either way, because a run whose script was written a
  // different way is not comparable to one that was not, and six weeks later
  // the only place that fact could live is the manifest.
  const onePass = !flag(argv, 'beat-by-beat');

  // HOW THIS RUN RESEARCHES, when the format's own answer is not what is
  // wanted. Two modes and the difference is breadth against depth:
  //
  //   --research extensive   search wide, fetch fourteen documents, extract
  //                          claims bound to verbatim quotes, verify each one,
  //                          repair what fails, write from the ledger.
  //
  //   --research single      pick the one to three documents that carry the
  //                          whole story, read them WHOLE rather than through a
  //                          six-thousand-character keyhole, fuse them into one
  //                          reference article, write from that. No claim
  //                          ledger, no per-fact verification.
  //
  // Usually left off: a format declares which lane it belongs on, and the
  // choice of format is the ordinary way to pick. This is for trying the same
  // topic both ways.
  const research = arg(argv, 'research');
  if (research && research !== 'single' && research !== 'extensive') {
    console.error(`--research takes "single" or "extensive", not "${research}"`);
    return 1;
  }

  // The header is printed by finishRun, which also prints it on a resume, so
  // the two commands look the same and neither repeats the other.
  // HELD BY DEFAULT, because rendering is the only irreversible spend and a
  // script is cheapest to fix before it has been voiced. `--render-now` skips
  // the break for somebody who knows what they are doing; a source format is
  // never held, because it stops before the render anyway.
  //
  // NEWS IS NOT HELD unless `--hold` asks. A report is a few pence of audio and
  // loses its value by the hour; publishing is still a separate human command,
  // and the gate refuses a stale one there.
  const holdForApproval = news
    ? flag(argv, 'hold')
    : !flag(argv, 'render-now') && !format.sourceOnly;

  // `--grounding` / `--no-perform` and so on, resolved once and recorded, so a
  // resume of this run uses the same passes. See config/stages.ts.
  const stages = stageFlags(stageOverridesFromArgv(argv));
  const off = stagesOff(stages);
  if (off.length) console.log(`  stages OFF: ${off.join(', ')}`);

  if (coveredAlready(persona, topic, argv)) return 1;

  const run = Run.create({
    personaId: persona.id,
    formatId,
    topic,
    onePass,
    holdForApproval,
    stages,
    research: research as 'single' | 'extensive' | undefined,
  });

  // Recorded at creation, not at success, for the reason takeTopic is consumed
  // up front: a subject recorded only on success means a failing show retries
  // it forever, spending money each time.
  if (!persona.fiction && !hasNewsDesk(persona.id)) recordMade(persona.id, topic, run.id);

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
  onePass: boolean,
  /** Which lane, when the run was asked for one other than the format's. */
  research?: 'extensive' | 'single'
): number => {
  // A DRY RUN THAT QUOTES FOR THE WRONG LANE IS WORSE THAN NO DRY RUN. The
  // single-story lane does not extract claims and does not verify them, and
  // those are the two largest lines on this table - so quoting them would
  // overstate a story run by roughly half while naming stages it will never
  // reach.
  const singleStory = (research ?? format.research) === 'single';
  const writer = writerConfig();
  const verifier = verifierConfig();
  const engine = ttsProvider();
  // RESOLVED BEFORE THE TABLE IS BUILT, because two of its rows now exist only
  // when the pass that fills them is switched on.
  const flags = stageFlags(stageOverridesFromArgv(process.argv));

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
    ...(singleStory
      ? ([
          [
            'reference',
            // A SHORT HAS NO FUSION STEP, and that is most of why a short fits
            // in fourteen pence. It picks one article and the writer reads it
            // directly; the fusion alone is three times a short's whole budget.
            // See script/shortScript.ts.
            format.kind === 'short'
              ? write(writer.model, 1, 12_000, 400)
              : write(writer.model, 1, 12_000, 400) + write(writer.model, 1, 75_000, 9_000),
            format.kind === 'short'
              ? 'pick the one best article. No fusion step on a short.'
              : 'pick 1-3 documents, then read them whole and fuse them into one article',
          ],
          ...(flags.referenceCheck
            ? ([
                [
                  'ref-check',
                  write(verifier.model, 1, 75_000, 1_200),
                  'the verifier reads the article back against the documents it came from',
                ],
              ] as Array<[string, number, string]>)
            : []),
        ] as Array<[string, number, string]>)
      : ([
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
        ] as Array<[string, number, string]>)),
    [
      'script',
      // THE STORY PLAN IS PAID FOR EITHER WAY. It used to be described here as
      // the hook competition, and that went stale the moment the long formats
      // dropped their cold opens: a hook competition only runs when the first
      // beat is typed `cold_open`, so an estimate naming it was quoting for
      // work the run would not do.
      // REVISIONS ARE BOUGHT, NOT ASSUMED. With them off this is one call, and
      // that is the difference between 12p and 99p on a real run.
      (singleStory ? 0 : write(writer.model, 1, 2_000, 1_500)) +
        (singleStory && format.kind === 'short'
          ? // The article IS the input here, up to sixty thousand characters,
            // plus a short answer and a little thinking at low effort.
            write(writer.model, flags.scriptRevisions ? 2 : 1, 15_000, 3_000)
          : onePass || singleStory
            ? write(writer.model, flags.scriptRevisions ? 2.5 : 1, 16_000, 8_000)
            : write(writer.model, beats * (flags.scriptRevisions ? 1.6 : 1), 3_500, 1_200)),
      (() => {
        const rewrites = flags.scriptRevisions
          ? `, plus up to ${2} rewrite(s)`
          : '. Revisions are OFF, so a failing draft is reported and kept';
        if (singleStory && format.kind === 'short')
          return `the article straight to the script in 1 call${rewrites}`;
        if (singleStory) return `the whole script from the reference in 1 call${rewrites}`;
        if (onePass) return `story plan + the whole script in 1 call${rewrites}`;
        return (
          `story plan${format.beats[0]?.type === 'cold_open' ? ' + hook competition' : ''} + ` +
          `~${Math.round(beats * (flags.scriptRevisions ? 1.6 : 1))} beat calls${rewrites}`
        );
      })(),
    ],
    ['title', write(writer.model, 1, 1_200, 200), '1 call'],
    // TWO STAGES THAT WERE MISSING FROM THIS ESTIMATE AND ARE NOT CHEAP.
    //
    // A dry run exists so somebody can decide whether to spend, and it was
    // quoting for a pipeline two stages shorter than the one that now runs. The
    // grounding review alone came to 34p on a real episode, so the estimate was
    // understating a run by roughly half.
  ];

  // THE OPTIONAL PASSES ARE QUOTED ONLY IF THEY WILL RUN. An estimate that
  // includes a stage the run will skip is as misleading as one that omits a stage
  // it will not, and the whole point of a dry run is deciding whether to spend.
  if (flags.perform) {
    stages.push([
      'perform',
      write(writer.model, 1, 8_000, 6_000),
      'one pass over the finished script for delivery, adding no facts',
    ]);
  }
  if (flags.grounding && !singleStory) {
    stages.push([
      'grounding',
      // The verifier, with the whole ledger and the whole script as input. Low
      // effort, but the input is the largest of any call in the run.
      write(verifier.model, 1, 12_000, 2_000),
      'the verifier reads the script against every claim',
    ]);
  }

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
const finishRun = async (run: Run, argv: string[]): Promise<number> => {
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
  // RESOLVED BEFORE THE RUN, so a typo in --bed is a message rather than an
  // episode that quietly comes out with the wrong music. A missing beat is
  // named and the run continues on a synthesised bed, because music is
  // decoration on a thing whose value is the words.
  let bedFile: string | undefined;
  const bedName = arg(argv, 'bed');
  if (bedName) {
    const recipe = loadBeat(bedName);
    if (!recipe) {
      console.error(`No beat called "${bedName}". See: npm run foundry -- beat --list`);
      return 1;
    }
    const built = await buildBeat(recipe);
    if (built.ok) bedFile = built.file;
    else console.log(`  could not use beat "${bedName}": ${built.reason}`);
  }

  const deps = buildDeps({
    onePass: run.manifest.onePass,
    // Also from the manifest, and for the same reason.
    stages: run.manifest.stages as Partial<StageFlags> | undefined,
    // FROM THE COMMAND LINE, NOT THE MANIFEST, and that is the difference
    // between this and the two above. Music changes nothing about what the
    // episode SAYS, so re-rendering one part with a bed and one without would
    // be audible but never wrong - and being able to hear the same script bare
    // is the point of having the flag.
    music: !flag(argv, 'no-music'),
    musicPhraseFile: bedFile,
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
    : hasNewsDesk(persona.id)
      ? await runNews(run, deps)
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

  // A HELD RUN EXITS ZERO EVEN WITH FINDINGS, and this is a consequence of the
  // hold learning to gate for real.
  //
  // Before that it returned a fabricated pass, so a held run always exited zero.
  // Once it started running the actual checks, the first one reported a short
  // quote and a self-similarity overlap and the command exited 2 - which reads
  // as "the run crashed" when what happened is the run did exactly what it was
  // asked to do and then told the truth about the script.
  //
  // Nothing is being hidden: the findings are printed immediately above, and the
  // run has published nothing and voiced nothing. The exit code answers "did the
  // command work", and for a hold the answer is yes. `publish` is where a failed
  // gate has to bite, and it still does.
  if (run.awaitingApproval) {
    console.log(`\nRead it first:  npm run foundry -- script  --run ${run.id}`);
    console.log(`Then release:   npm run foundry -- approve --run ${run.id}`);
    return 0;
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
  const platform = platformUrl();

  // NOT REQUIRED HERE. setUpChannel needs them only when the account does not
  // exist yet; after that it signs in as the channel with the password it
  // recorded, and refuses with a clear message if it turns out it does need
  // them. Demanding them up front made redrawing a picture need the production
  // admin password.
  const email = process.env.AUDIOVIBE_ADMIN_EMAIL;
  const password = process.env.AUDIOVIBE_ADMIN_PASSWORD;

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
      redraw: flag(argv, 'redraw'),
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

    // THE ONE STEP THIS COMMAND CANNOT DO. The platform has no endpoint that
    // issues publishing credentials, deliberately: utils/ingestToken.ts calls
    // one "a privilege escalation waiting for its first authorisation bug".
    // So the token is minted on the server by a person, and the useful thing
    // to print is exactly what to type.
    if (!result.account.ingestToken) {
      console.log('');
      console.log('  It cannot publish yet. On the API server:');
      console.log(`    node dist/scripts/mintIngestToken.js --username ${result.account.username}`);
      console.log('  then bring the token back here:');
      console.log(`    npm run foundry -- channel-token --show ${showId} --token <jwt>`);
    }

    console.log('');
    return 0;
  } catch (err) {
    ui.finish();
    console.error(`  ${(err as Error).message}`);
    console.error('');
    return 1;
  }
};

/**
 * Record the publishing credential a person minted on the server.
 *
 * A COMMAND RATHER THAN "EDIT THE JSON", because the file holds passwords and
 * the thing most likely to go wrong while hand-editing it is losing one. This
 * reads, changes one field, and writes.
 *
 * IT CHECKS THE TOKEN IS FOR THIS CHANNEL. An ingest token carries the user id
 * it publishes as, so pasting the wrong show's token is a mistake that
 * otherwise surfaces as a month of episodes appearing under the wrong account.
 */
const cmdChannelToken = (argv: string[]): number => {
  const showId = arg(argv, 'show');
  const token = arg(argv, 'token');

  if (!showId || !token) {
    console.error('Usage: channel-token --show <id> --token <jwt>');
    return 1;
  }

  const accounts = loadAccounts();
  const account = accounts[showId];
  if (!account) {
    console.error(`no account recorded for ${showId}. Run channel-setup --show ${showId} first.`);
    return 1;
  }

  // The payload is read, not verified: the signing secret lives on the server
  // and this machine has no business holding it. Reading the id is enough to
  // catch the mistake this check exists for.
  let claimedUserId: string | null = null;
  try {
    const [, payload] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
    claimedUserId = typeof decoded.userId === 'string' ? decoded.userId : null;
    if (decoded.scope !== 'ingest') {
      console.error(`that token's scope is "${decoded.scope}", not "ingest".`);
      return 1;
    }
  } catch {
    console.error('that does not look like a token. Expected the jwt mintIngestToken printed.');
    return 1;
  }

  if (claimedUserId && claimedUserId !== account.userId) {
    console.error(`that token publishes as ${claimedUserId}, but ${showId} is ${account.userId}.`);
    console.error('Minting it for the wrong show puts its episodes in the wrong account.');
    return 1;
  }

  account.ingestToken = token;
  accounts[showId] = account;
  saveAccounts(accounts);

  console.log(`@${account.username} can publish. Recorded in ${accountsPath()}.`);
  return 0;
};

/**
 * Publish whatever a person approved and whose time has come.
 *
 * FOR A TRIGGER, NOT FOR A PERSON. Point Task Scheduler or cron at this as
 * often as you like: what is due is computed from what is on disk, so firing
 * twice in a minute publishes nothing the second time, and not firing for a
 * week leaves a backlog that drains one per firing rather than all at once.
 *
 * The studio runs the same code on a timer while it is open. This is for a
 * studio that publishes whether or not somebody's laptop is on.
 */
const cmdRelease = async (argv: string[]): Promise<number> => {
  const plan = dueForRelease();

  for (const held of plan.held) {
    console.log(`holding ${held.runId}: ${held.reason}`);
  }

  if (!plan.due.length) {
    console.log('Nothing due.');
    return 0;
  }

  if (flag(argv, 'dry-run')) {
    console.log(`${plan.due.length} due:`);
    for (const d of plan.due) {
      console.log(`  ${d.releaseAt.toISOString()}  ${d.channelName}  "${d.title}"`);
    }
    console.log('\nNothing published. Drop --dry-run to release the first one.');
    return 0;
  }

  const result = await releaseDue(new Date(), { report: (m) => console.log(`  ${m}`) });

  for (const r of result.released) console.log(`published ${r.audioId} to ${r.url}`);
  for (const f of result.failed) console.error(`failed ${f.runId}: ${f.reason}`);
  if (result.remaining > 0) console.log(`${result.remaining} more due; run again to continue.`);

  return result.failed.length ? 1 : 0;
};

/**
 * Take a published run back off the platform.
 *
 * FOR THE FIRST FEW EPISODES OF A CHANNEL, which are not really publishing so
 * much as looking at the result. Without this the only ways to remove a bad
 * card are to leave it in the catalogue or to wipe the database, and wiping
 * would take the account, its artwork and its credential with it.
 */
const cmdUnpublish = async (argv: string[]): Promise<number> => {
  const run = openRun(argv);
  const platform = platformUrl();

  if (platform.isProduction && !flag(argv, 'yes')) {
    console.error(`AUDIOVIBE_API_URL points at PRODUCTION (${platform.url}).`);
    console.error('Re-run with --yes if that is what you meant.');
    return 1;
  }

  const result = await unpublish(run.id, { log: (m) => console.log(`  ${m}`) });

  console.log(
    result.removed
      ? `removed ${result.audioId} from ${platform.url}`
      : `${result.audioId}: ${result.note}`
  );
  return 0;
};

/**
 * The platform's categories, and whether every show names one.
 *
 * WHY THIS IS A COMMAND. A persona's category is a string that has to match a
 * row in somebody else's database, and nothing local can tell you whether it
 * does. Two shows named "Storytelling" for months: it IS a real category on the
 * platform, of SERIES rather than of audio, so it looked right everywhere
 * except the one place it is used. The failure then arrived at the very end of
 * a publish, after the research, the writing, the voicing and the gate.
 *
 * One unauthenticated GET. Run it after adding a show, or when a publish
 * complains about a category.
 */
const cmdCategories = async (): Promise<number> => {
  const platform = platformUrl();
  const client = new AudioVibeClient(platform.url, 'the category list is public');
  const personas = loadAllPersonas();

  console.log('');
  console.log(`  ${platform.url}`);
  console.log('');

  // Asked once per distinct category rather than once per show, because the
  // client caches the list after the first call anyway and this reads better.
  const resolved = new Map<string, boolean>();
  for (const category of new Set(personas.map((p) => p.category))) {
    try {
      await client.categoryId(category);
      resolved.set(category, true);
    } catch {
      resolved.set(category, false);
    }
  }

  const broken = personas.filter((p) => !resolved.get(p.category));

  for (const persona of [...personas].sort((a, b) => a.id.localeCompare(b.id))) {
    const ok = resolved.get(persona.category);
    console.log(`  ${ok ? 'ok  ' : 'NO  '}${persona.id.padEnd(22)} ${persona.category}`);
  }

  console.log('');

  if (!broken.length) {
    console.log('  Every show names a category the platform has.');
    console.log('');
    return 0;
  }

  console.log(`  ${broken.length} show(s) name something the platform does not have.`);
  console.log('  It must be one of:');
  console.log('');

  // The client's own failure lists them, so the fix needs no second command.
  try {
    await client.categoryId('no-such-category');
  } catch (err) {
    const message = (err as Error).message;
    const list = message.slice(message.indexOf('one of:') + 'one of:'.length).trim();
    for (const name of list.split(',').map((n) => n.trim())) console.log(`    ${name}`);
  }

  console.log('');
  return 1;
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
 * Make, list and rebuild the synthesised beats a show can sit on.
 *
 * MADE BY HAND, ON PURPOSE. Before this, a bed was whatever the episode's topic
 * string happened to seed, synthesised fresh for every part and thrown away, so
 * there was no way to hear one without making an episode and no way to keep one
 * you liked. A named beat is a show having a sound rather than a setting.
 */
const cmdBeat = async (argv: string[]): Promise<number> => {
  if (flag(argv, 'list') || argv.length === 0) {
    const beats = listBeats();
    if (!beats.length) {
      console.log('No beats yet.');
      console.log('');
      console.log(`  npm run foundry -- beat --name calm-piano --style piano --key a`);
      return 0;
    }

    console.log(`${beats.length} beat(s) in ${bedsDir()}`);
    console.log('');
    for (const b of beats) {
      const cached = fs.existsSync(audioPath(b.name));
      console.log(`  ${b.name.padEnd(20)} ${b.style.padEnd(8)} key ${b.key.padEnd(3)} ${cached ? '' : '(not rendered)'}`);
      if (b.note) console.log(`  ${''.padEnd(20)} ${b.note}`);
    }
    console.log('');
    console.log('Use one:  npm run foundry -- make --show <id> --topic "..." --bed <name>');
    return 0;
  }

  const name = arg(argv, 'name');
  if (!name) {
    console.error('Usage: beat --name <name> [--style piano|strings|epic] [--key a..e] [--note "..."]');
    console.error('       beat --list');
    return 1;
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    console.error('A beat name is lowercase letters, digits and hyphens. It becomes a filename.');
    return 1;
  }

  const existing = loadBeat(name);
  const style = arg(argv, 'style') ?? existing?.style ?? 'piano';
  const key = (arg(argv, 'key') ?? existing?.key ?? 'a').toLowerCase();

  if (!isBedStyle(style) || style === 'none') {
    console.error(`--style is one of: ${BED_STYLES.filter((b) => b !== 'none').join(', ')}`);
    return 1;
  }
  if (!isKey(key)) {
    console.error(`--key is one of: ${Object.keys(KEYS).join(', ')}`);
    return 1;
  }

  const recipe = {
    name,
    style,
    key,
    note: arg(argv, 'note') ?? existing?.note ?? '',
    madeAt: existing?.madeAt ?? new Date().toISOString(),
  };

  const file = saveBeat(recipe);

  // FORCED WHENEVER THE RECIPE IS WRITTEN, because the cache is keyed by the
  // file existing rather than by the recipe's contents. Changing the key and
  // reusing the old audio is the one stale result this design can produce.
  console.log(`Synthesising ${style} in ${key}...`);
  const built = await buildBeat(recipe, { force: true });

  if (!built.ok) {
    console.error(`Could not render it: ${built.reason}`);
    console.error('The recipe is saved. Fix ffmpeg and run the same command again.');
    return 1;
  }

  console.log('');
  console.log(`  recipe   ${file}`);
  console.log(`  audio    ${built.file}`);
  console.log('');
  console.log('Listen to it, then use it:');
  console.log(`  npm run foundry -- make --show <id> --topic "..." --bed ${name}`);
  return 0;
};

/**
 * What the studio has already covered, and the backfill that seeds it.
 *
 * THE BACKFILL EXISTS BECAUSE THE LEDGER ARRIVED LATE. Everything made before
 * this command existed is recorded only in runs/, which is gitignored, so on a
 * fresh clone the check would believe the studio had made nothing and would
 * happily approve a second Descent of Inanna. Reading the manifests once fixes
 * that, and it is safe to run repeatedly because entries are keyed by run id.
 */
const cmdCovered = async (argv: string[]): Promise<number> => {
  const showId = arg(argv, 'show');

  if (flag(argv, 'backfill')) {
    let added = 0;
    for (const id of Run.list()) {
      let run;
      try {
        run = Run.open(id);
      } catch {
        // A half-written run directory is not a reason to abandon the backfill.
        continue;
      }

      const { personaId, topic } = run.manifest;
      if (!topic) continue;

      // Same exclusions as the live check, and for the same reason: a fiction
      // show reuses its thesis and a news desk reuses its beat, so recording
      // those would poison the ledger with a topic that means nothing.
      let persona;
      try {
        persona = loadPersona(personaId);
      } catch {
        continue;
      }
      if (persona.fiction || hasNewsDesk(personaId)) continue;

      const before = loadCatalogue().entries.length;
      recordMade(personaId, topic, id, new Date(run.manifest.createdAt));
      if (loadCatalogue().entries.length > before) added += 1;
    }

    console.log(`Backfilled ${added} run(s) into catalogue.json.`);
    return 0;
  }

  const entries = loadCatalogue()
    .entries.filter((e) => !showId || e.showId === showId)
    .sort((a, b) => a.madeAt.localeCompare(b.madeAt));

  if (!entries.length) {
    console.log(
      showId
        ? `${showId} has covered nothing yet. Seed from existing runs with --backfill.`
        : 'Nothing covered yet. Seed from existing runs with --backfill.'
    );
    return 0;
  }

  console.log(`${entries.length} subject(s) covered`);
  console.log('');
  for (const e of entries) {
    console.log(`  ${e.madeAt.slice(0, 10)}  ${e.showId}`);
    console.log(`              ${e.topic}`);
  }

  return 0;
};

/**
 * Break a season: plan every episode of a serial before writing any of them.
 *
 * THE CHEAPEST CONTROL POINT IN THE STUDIO, and the reason it is a separate
 * command rather than a stage inside `make`. A plan costs about a tenth of one
 * written episode, so a season rejected here is rejected for pennies and a
 * season rejected after generation is rejected for the price of all of it.
 * Making it a stage would take that choice away by running the expensive part
 * before anybody had read the cheap one.
 *
 * It writes the plan to disk and stops. Nothing renders, nothing publishes, and
 * no episode is written until somebody has read the cards.
 */
const cmdSeason = async (argv: string[]): Promise<number> => {
  const showId = arg(argv, 'show');
  if (!showId) {
    console.error('Usage: season --show <id> [--episodes N] [--season N] [--premise "..."]');
    return 1;
  }

  const persona = loadPersona(showId);
  if (!persona.fiction) {
    // The same refusal runFiction makes, for the same reason. A factual show
    // planned like a serial is a show inventing what it is going to find.
    console.error(
      `${persona.name} is not a fiction show. A season plan decides what happens ` +
        `before anything is researched, which is the one thing a show built on an ` +
        `evidence ledger may never do.`
    );
    return 1;
  }

  const [minEps, maxEps] = SEASON_EPISODES;
  const seasonNumber = Number(arg(argv, 'season') ?? '1');
  const episodes = Number(arg(argv, 'episodes') ?? '8');

  if (!Number.isInteger(episodes) || episodes < minEps || episodes > maxEps) {
    console.error(`--episodes must be between ${minEps} and ${maxEps}`);
    return 1;
  }

  const existing = loadPlan(persona.id, seasonNumber);

  if (argv.includes('--show-plan')) {
    if (!existing) {
      console.error(`${persona.name} has no plan for season ${seasonNumber}.`);
      return 1;
    }
    console.log(renderPlan(existing));
    return 0;
  }

  if (existing && !argv.includes('--force')) {
    // Overwriting a plan that episodes have already been written against would
    // leave those episodes answerable to a document that no longer exists.
    console.error(
      `${persona.name} season ${seasonNumber} is already planned. Read it with ` +
        `\`season --show ${persona.id} --season ${seasonNumber} --show-plan\`, or pass --force to replace it.`
    );
    return 1;
  }

  // Episode length comes from the show rather than a flag, because the cards
  // have to be sized to what an episode can actually hold and the show already
  // knows that number.
  const [lo, hi] = persona.episodeSeconds;
  const minutes = Math.round((lo + hi) / 2 / 60);

  const deps = buildDeps();
  let pence = 0;

  console.log(`Breaking ${persona.name} season ${seasonNumber}: ${episodes} episodes, about ${minutes} minutes each.`);

  const plan = await planSeason(
    {
      persona,
      seasonNumber,
      episodes,
      episodeMinutes: minutes,
      premise: arg(argv, 'premise'),
      isoDate: new Date().toISOString().slice(0, 10),
    },
    deps.writer,
    (p) => {
      pence += p;
    }
  );

  const file = savePlan(plan);

  console.log('');
  console.log(renderPlan(plan));
  console.log('');

  // FREE, AND THIS IS WHERE IT PAYS. Every one of these is arithmetic over the
  // object just returned, and each one names a season that would have read
  // fine episode by episode and disappointed as a whole.
  const problems = checkPlan(plan, persona.hosts.map((h) => h.name));
  if (problems.length) {
    console.log('PROBLEMS WITH THIS PLAN');
    for (const p of problems) console.log(`  - ${p}`);
    console.log('');
  } else {
    console.log('The plan plants everything it pays off, and lands.');
    console.log('');
  }

  console.log(`  spent      ${pence.toFixed(1)}p`);
  console.log(`  plan       ${file}`);
  console.log('');
  console.log('Read it, edit the file by hand if you want to, then write episode one:');
  console.log(`  npm run foundry -- make --show ${persona.id}`);

  return 0;
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

  const platform = platformUrl();
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

  // THE CHANNEL'S OWN CREDENTIAL, not a studio-wide one. The token carries a
  // user id, so a series made with the wrong one belongs to the wrong show and
  // there is no moving it afterwards.
  const client = new AudioVibeClient(platform.url, publishTokenFor(persona.id));
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
const readPlan = (now = new Date()) => currentPlan(now);

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

    // A tick is unattended, so a duplicate here would never be seen by anybody.
    // The topic goes back on the queue rather than being silently consumed.
    if (coveredAlready(persona, topic, argv)) {
      if (!persona.fiction) returnTopic(persona.id, topic);
      return 1;
    }

    const run = Run.create({ personaId: persona.id, formatId, topic });
    if (!persona.fiction && !hasNewsDesk(persona.id)) recordMade(persona.id, topic, run.id);
    console.log(`run ${run.id}: ${topic}`);

    try {
      result = persona.fiction
        ? await runFiction({ run }, buildDeps())
        : hasNewsDesk(persona.id)
          ? await runNews(run, buildDeps())
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
  const confirmed = flag(argv, 'yes');

  try {
    await publishRun(run, gate, { confirmed, report: (m) => console.log(m) });
    return 0;
  } catch (err) {
    if (!(err instanceof PublishRefused)) throw err;

    console.error(err.reason);
    if (!gate.passed) console.error(formatGateReport(gate));
    if (err.remedy) console.error(err.remedy);
    if (!confirmed) console.error('Re-run with --yes if that is what you meant.');
    return 1;
  }
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
      case 'season':
        return await cmdSeason(rest);
      case 'covered':
        return await cmdCovered(rest);
      case 'beat':
        return await cmdBeat(rest);
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
      case 'channel-token':
        return cmdChannelToken(rest);
      case 'release':
        return await cmdRelease(rest);
      case 'categories':
        return await cmdCategories();
      case 'unpublish':
        return await cmdUnpublish(rest);
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
