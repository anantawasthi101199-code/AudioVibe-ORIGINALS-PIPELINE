/**
 * Putting one finished run on the platform.
 *
 * SHARED BY THE COMMAND LINE AND THE STUDIO, and that is the whole reason it is
 * its own file. This is the last irreversible act in the pipeline - followers
 * are notified, feeds cache, the seen ledger records it - and two copies of it
 * would be two sets of rules about when a run may go out. The first time they
 * differed would be in production, on something already published.
 *
 * IT REFUSES RATHER THAN DECIDES. Everything that could stop a publish is
 * checked here and reported as a reason; nothing is assumed, defaulted or
 * worked around. A caller that wants to publish past a human-review flag has to
 * say so explicitly, in both front ends, because that flag means a person was
 * asked a question no arithmetic settles.
 */
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { loadFormat } from '../formats/load';
import { platformUrl } from '../config';
import { paletteFor, renderCover } from '../art/cover';
import { suppliedArt } from '../art/supplied';
import { claimSetSchema, corpusSchema } from '../evidence/research';
import { anchorClaims } from '../evidence/writtenFrom';
import { loadBible } from '../fiction/bible';
import { renderResultSchema } from '../render/assemble';
import { finalAudioFor, mixedAudioFor } from '../render/backing';
import { GateReport } from '../qa/gate';
import { withOverrides } from '../qa/overrides';
import { Run } from '../run/store';
import { scriptSchema } from '../script/write';
import { AudioVibeClient } from './ingest';
import { publishTokenFor } from './account';
import { ProvenancePayload, buildFictionProvenance, buildProvenance } from './provenance';
import { findSeries, recordSeries, seriesKey } from './seriesRegistry';
import { SERIES_COVER_SIZE } from '../art/cover';
import { repoRoot } from '../config';

/**
 * Where this episode sits in a serial.
 *
 * Already recorded in the bible means this is its position; not recorded means
 * it is the next one. Undefined for a factual show, which numbers nothing.
 */
const episodeNumberFor = (run: Run, persona: { id: string; fiction: boolean }): number | undefined => {
  if (!persona.fiction) return undefined;
  const bible = loadBible(persona.id);
  const index = bible.episodes.findIndex((e) => e.id === run.id);
  return index >= 0 ? index + 1 : bible.episodes.length + 1;
};

export class PublishRefused extends Error {
  constructor(
    readonly reason: string,
    /** What a person has to do about it, when there is something. */
    readonly remedy: string | null = null
  ) {
    super(reason);
    this.name = 'PublishRefused';
  }
}

export interface PublishOptions {
  /**
   * The person has read it and means this.
   *
   * REQUIRED FOR TWO SEPARATE THINGS and deliberately not split: publishing to
   * production at all, and publishing a run the gate flagged for human review.
   * Both mean "somebody looked", and a caller that had one flag for each would
   * be inviting somebody to set the boring one permanently.
   */
  confirmed: boolean;
  /** Progress, so the studio can show what is happening. */
  report?: (message: string) => void;
}

export interface Published {
  audioId: string;
  status: string;
  url: string;
  seriesId?: string;
}

export const publishRun = async (
  run: Run,
  gate: GateReport,
  options: PublishOptions
): Promise<Published> => {
  const say = options.report ?? (() => undefined);
  // Whoever called, findings a person chose to ignore stop blocking here.
  gate = withOverrides(run, gate);

  if (!gate.passed) {
    throw new PublishRefused(
      'this run did not pass the gate',
      'Read the findings, edit the script, or remake it.'
    );
  }

  if (gate.needsHumanReview && !options.confirmed) {
    throw new PublishRefused(
      `this run needs a human before it goes out: ${gate.humanReviewReasons.join('; ')}`,
      'Read the script, then confirm.'
    );
  }

  const platform = platformUrl();
  if (platform.isProduction && !options.confirmed) {
    // None of what a publish does can be taken back.
    throw new PublishRefused(
      `${platform.url} is PRODUCTION`,
      'Confirm that is what you meant.'
    );
  }

  const persona = loadPersona(run.manifest.personaId);
  const format = loadFormat(run.manifest.formatId);

  // A SOURCE SCRIPT IS NOT A THING TO PUBLISH. It is ten self-contained
  // stories written to be cut apart, it was never voiced, and it passes its
  // gate like anything else - so without this it looks publishable right up
  // until it fails reading a render artifact that was never made.
  // `story` is what tells the script from the stories cut out of it: a cut
  // carries its source's format id, so sourceOnly alone would refuse all ten.
  if (format.sourceOnly && run.manifest.story === undefined) {
    throw new PublishRefused(
      `"${format.id}" is a source script, which is cut into shorts and never published whole`,
      'Cut it, then publish the shorts.'
    );
  }

  const script = run.readArtifact('script', scriptSchema);
  const render = run.readArtifact('render', renderResultSchema);

  // WHICH RECEIPTS THIS EPISODE CARRIES.
  //
  // A fiction run has no corpus and its `claims` artifact holds established
  // facts rather than sourced claims, so reading it through the reported path
  // fails outright. The two are kept apart rather than merged behind empty
  // arrays because a fiction episode with no sources needs none, while a
  // reported episode with no sources has failed - and the Sources sheet must
  // not render those two the same way.
  const provenance = provenanceFor(run, { confirmed: options.confirmed });

  // WHICH SHELF, IF ANY.
  //
  // A short always publishes as a loose card, whatever the show does with its
  // long episodes: a short's job is to be found by somebody who has never heard
  // of the show, and burying it in a series shelf is the opposite of that.
  //
  // For everything else, a show that publishes as a series MUST have one
  // already. Creating it here would mean a publish silently making a second
  // shelf whenever the registry was missing, and the registry going missing is
  // exactly the situation where you least want that.
  let seriesId: string | undefined;
  const seriesTitle = run.manifest.seriesTitle;
  if (seriesTitle && format.kind !== 'short') {
    // A NAMED SERIES, from `make --series`. Unlike the one-per-show shelf this
    // one IS created on first use: the title is on the run, so there is no
    // guessing which shelf was meant, and the registry key is the title.
    const key = seriesKey(persona.id, seriesTitle);
    let record = findSeries(key, platform.url);
    if (!record) {
      say(`creating the series "${seriesTitle}"`);
      const slug = key.split('#')[1]!;
      const coverPath =
        suppliedArt(path.join(repoRoot(), 'art', persona.id), `series-${slug}`) ??
        renderCover(
          { showName: persona.name, title: seriesTitle, palette: paletteFor(persona.id) },
          path.join(os.tmpdir(), `foundry-series-${persona.id}-${slug}.png`),
          SERIES_COVER_SIZE
        );
      const made = await new AudioVibeClient(platform.url, publishTokenFor(persona.id)).createSeries({
        title: seriesTitle,
        description: `${seriesTitle}, from ${persona.name}. ${(persona.bio ?? persona.thesis).trim().replace(/\s+/g, ' ')}`,
        category: persona.category,
        contentRating: persona.contentRating,
        coverPath,
      });
      recordSeries(key, {
        seriesId: made.seriesId,
        title: made.title,
        apiUrl: platform.url,
        createdAt: new Date().toISOString(),
      });
      record = findSeries(key, platform.url)!;
    }
    seriesId = record.seriesId;
    say(`publishing into "${record.title}"`);
  } else if (persona.publishesAsSeries && format.kind !== 'short') {
    const record = findSeries(persona.id, platform.url);
    if (!record) {
      throw new PublishRefused(
        `${persona.name} publishes as a series and has none on ${platform.url} yet`,
        `Make it once: npm run foundry -- series-setup --show ${persona.id}`
      );
    }
    seriesId = record.seriesId;
    say(`publishing into "${record.title}"`);
  }

  // COVER ART IS DRAWN HERE, NOT AT RENDER TIME, because it depends on the
  // title and on nothing expensive. Drawing it is deterministic, so
  // re-publishing never quietly changes the artwork of something already in
  // somebody's library.
  //
  // UNLESS SOMEBODY CHOSE ONE. A supplied cover is used as it is and never
  // redrawn over, which is also why it is not written to cover.png: this line
  // has to keep working for the next episode.
  const drawnCover = run.mediaPath('cover.png');
  const chosenCover = suppliedArt(path.dirname(drawnCover), 'cover');

  if (chosenCover) say(`using the cover you supplied (${path.basename(chosenCover)})`);

  const coverPath =
    chosenCover ??
    renderCover(
      {
        showName: persona.name,
        title: script.title,
        palette: paletteFor(persona.id),
        // Fiction numbers its episodes because a serial is an order; a factual
        // show does not, because "episode 41" tells a listener nothing about
        // whether this is the one they want.
        episodeNumber: seriesId ? episodeNumberFor(run, persona) : undefined,
        kind: format.kind === 'short' ? 'short' : 'episode',
      },
      drawnCover
    );

  // WHERE THE AUDIO IS, not where the record says it was. A renamed run
  // directory leaves the stored path pointing at a folder that no longer
  // exists, and publishing is the last place that should discover it.
  // YOUR MUSIC, WHEN THERE IS A CURRENT MIX. A mix made from an older render is
  // stale and is not sent; the voice goes out instead. See render/backing.ts.
  const mixed = mixedAudioFor(run);
  if (mixed) say('publishing the version with your background music');
  const audioPath = mixed ?? run.audioFile(render.audioFile);
  if (!audioPath) {
    throw new PublishRefused(
      `no audio in ${run.dir}`,
      'Render it first, or check the run was not moved while it was being made.'
    );
  }

  say(`publishing to ${platform.url} as @${persona.handle}`);

  const client = new AudioVibeClient(platform.url, publishTokenFor(persona.id));
  const result = await client.publish({
    title: script.title,
    description: script.description,
    audioPath,
    category: persona.category,
    contentRating: run.manifest.contentRating ?? persona.contentRating,
    // A sped-up final audio moves every part earlier: divide each time by it.
    beatMap: scaleBeatMap(render.beatMap, mixed ? finalAudioFor(run)?.speed ?? 1 : 1),
    provenance,
    seriesId,
    coverPath,
  });

  run.writeArtifact('publish', {
    ...result,
    publishedAt: new Date().toISOString(),
    url: platform.url,
  });
  run.markComplete('publish');

  say(`published: audio ${result.audioId} (${result.status})`);
  return { audioId: result.audioId, status: result.status, url: platform.url, seriesId };
};

/** Kept so the series cover path has somewhere neutral to live. */
export const tmpCover = (id: string): string => path.join(os.tmpdir(), `foundry-${id}.png`);

/** Chapter times for audio played at `speed`: every second arrives sooner. */
export const scaleBeatMap = <T extends { startS: number; endS: number }>(map: T[], speed: number): T[] =>
  speed === 1
    ? map
    : map.map((b) => ({
        ...b,
        startS: Number((b.startS / speed).toFixed(3)),
        endS: Number((b.endS / speed).toFixed(3)),
      }));

/**
 * The receipts a run publishes with. Its own function so the readiness check
 * (publish/readiness.ts) builds exactly what a publish would, without sending.
 */
export const provenanceFor = (
  run: Run,
  options: { confirmed?: boolean } = {}
): ProvenancePayload => {
  const persona = loadPersona(run.manifest.personaId);
  const script = run.readArtifact('script', scriptSchema);
  const render = run.readArtifact('render', renderResultSchema);
return persona.fiction
  ? (() => {
      const continuity = run.readArtifact(
        'verification',
        z.object({ findings: z.array(z.unknown()), checkerModel: z.string() }).passthrough()
      );
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
      // NO LEDGER ON THE SINGLE-STORY AND CASE-FILE LANES: one unverified
      // claim per document the story was written from, so the Sources sheet
      // lists them rather than refusing to publish. See evidence/writtenFrom.ts.
      const claims = run.hasArtifact('claims')
        ? run.readArtifact('claims', claimSetSchema).claims
        : anchorClaims(run, script.title, script.beats[0]!.beatId);
      const verification = run.hasArtifact('verification')
        ? run.readArtifact(
            'verification',
            z
              .object({
                verification: z.object({ verifierModel: z.string() }).passthrough().optional(),
                counterEvidence: z.array(z.unknown()).default([]),
              })
              .passthrough()
          )
        : { verification: { verifierModel: 'none: written from its documents, not claim by claim' }, counterEvidence: [] };

      return buildProvenance({
        personaId: persona.id,
        claims,
        sources: corpus.sources,
        counterEvidence: verification.counterEvidence as never,
        // The person confirmed it by passing the review check above.
        counterEvidenceAddressed: options.confirmed ?? false,
        models: {
          writer: script.writerModel,
          verifier: verification.verification?.verifierModel ?? 'unknown',
          tts: `${render.provider}/${render.model}`,
          voice: render.voiceId,
        },
        renderedAt: new Date(),
      });
    })();
};
