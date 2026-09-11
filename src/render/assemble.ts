/**
 * Rendering a script into one audio file, and recording where each beat sits.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: master. No loudness normalisation, no
 * high-pass, no compression, no denoise. All of that belongs to the platform's
 * own chain (Audio-Vibe/docs/AUDIO_QUALITY_STANDARD.md), which every upload goes
 * through - human and studio alike. Mastering here would mean the platform
 * mastering an already-mastered file, and Originals would sound subtly
 * different from everything else in the feed, which is the one thing the
 * "publish through the same door" rule exists to prevent.
 *
 * What it DOES do is hand over a clean, high-quality source: 48kHz mono, so the
 * platform's single transcode to 192k MP3 is the only lossy generation. That is
 * the same reasoning that makes the uploader's 64kbps Opus source a documented
 * mistake in the platform repo.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { SynthesisResult } from './tts';

export const beatTimingSchema = z.object({
  id: z.string(),
  type: z.string(),
  startS: z.number().nonnegative(),
  endS: z.number().nonnegative(),
});

export type BeatTiming = z.infer<typeof beatTimingSchema>;

export const renderResultSchema = z.object({
  /** Path to the finished audio, relative to the run directory. */
  audioFile: z.string(),
  durationS: z.number().positive(),
  beatMap: z.array(beatTimingSchema),
  provider: z.string(),
  model: z.string(),
  voiceId: z.string(),
  costPence: z.number(),
});

export type RenderResult = z.infer<typeof renderResultSchema>;

export const ffmpegBin = (): string => process.env.FFMPEG_PATH || 'ffmpeg';
export const ffprobeBin = (): string => process.env.FFPROBE_PATH || 'ffprobe';

const runProcess = (bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    try {
      const proc = spawn(bin, args);
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
      proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    } catch (err) {
      resolve({ code: -1, stdout, stderr: (err as Error).message });
    }
  });

/** Duration of an audio file in seconds, or null when it cannot be read. */
export const probeDuration = async (file: string): Promise<number | null> => {
  const res = await runProcess(ffprobeBin(), [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  if (res.code !== 0) return null;
  const seconds = Number(res.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

/**
 * Silence between beats, in seconds.
 *
 * Not decoration. A beat boundary is a change of job - the cold open stops and
 * the stakes begin - and running them together is what makes generated audio
 * feel relentless. A breath is how a listener is told something shifted.
 */
export const BEAT_GAP_S = 0.45;

/**
 * Join rendered beats into one file, with a gap between each.
 *
 * Re-encodes rather than stream-copying. Concatenating MP3 frames directly is
 * faster and produces a file whose duration drifts from the sum of its parts,
 * which would make every beat timestamp after the first one slightly wrong -
 * and those timestamps are the entire point of rendering per beat.
 */
export const concatBeats = async (
  beatFiles: string[],
  outputPath: string,
  gapSeconds = BEAT_GAP_S
): Promise<void> => {
  if (!beatFiles.length) throw new Error('nothing to concatenate');

  const inputs = beatFiles.flatMap((f) => ['-i', f]);

  // Build a filter that appends `gapSeconds` of silence after every beat but
  // the last, then concatenates the lot.
  const parts: string[] = [];
  const labels: string[] = [];
  beatFiles.forEach((_, i) => {
    const isLast = i === beatFiles.length - 1;
    if (isLast) {
      parts.push(`[${i}:a]aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[a${i}]`);
      labels.push(`[a${i}]`);
    } else {
      parts.push(
        `[${i}:a]aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono,` +
          `apad=pad_dur=${gapSeconds}[a${i}]`
      );
      labels.push(`[a${i}]`);
    }
  });
  parts.push(`${labels.join('')}concat=n=${beatFiles.length}:v=0:a=1[out]`);

  const res = await runProcess(ffmpegBin(), [
    '-y',
    '-hide_banner',
    '-v', 'error',
    ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[out]',
    // 48kHz mono WAV. The platform masters and transcodes; handing it a clean
    // uncompressed source makes its single 192k encode the only lossy step.
    '-ar', '48000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);

  if (res.code !== 0) {
    throw new Error(`ffmpeg concat failed: ${res.stderr.slice(0, 400)}`);
  }
};

/**
 * Build the beat map from measured beat durations.
 *
 * Measured rather than estimated. The whole value of the map is that a
 * timestamp corresponds to what a listener actually heard, and a word-count
 * estimate would be wrong by seconds within a minute or two.
 */
export const buildBeatMap = (
  beats: Array<{ id: string; type: string; durationS: number }>,
  gapSeconds = BEAT_GAP_S
): BeatTiming[] => {
  const map: BeatTiming[] = [];
  let cursor = 0;
  beats.forEach((b, i) => {
    const startS = cursor;
    const endS = startS + b.durationS;
    map.push({ id: b.id, type: b.type, startS: Number(startS.toFixed(3)), endS: Number(endS.toFixed(3)) });
    cursor = endS + (i === beats.length - 1 ? 0 : gapSeconds);
  });
  return map;
};

export interface RenderDeps {
  /**
   * Re-render beats that already have a file. Defaults to reusing them.
   *
   * Only ever set false to force a fresh take - a changed voice, a changed
   * script, or a beat that came out wrong. Reuse is the right default because
   * the alternative is paying twice for work that succeeded.
   */
  reuseExisting?: boolean;
  writeFile?: (file: string, data: Buffer) => void;
  probe?: (file: string) => Promise<number | null>;
  concat?: (files: string[], out: string, gap: number) => Promise<void>;
}

export interface RenderableTurn {
  speaker: string;
  text: string;
}

export interface RenderableBeat {
  beatId: string;
  beatType: string;
  turns: RenderableTurn[];
}

/**
 * Render every beat, join them, and record where each one landed.
 *
 * A beat with one speaker goes through plain text-to-speech. A beat with more
 * than one goes through the provider's DIALOGUE endpoint as a single request,
 * which is what produces turn-taking a listener reads as conversation: overlap,
 * interruption, a reply landing early. Rendering each turn separately and
 * splicing them cannot do any of that, and gives every turn identical prosody
 * into the bargain.
 *
 * It falls back to per-turn synthesis when the provider has no dialogue
 * endpoint, because a worse-sounding episode beats no episode - but the
 * fallback is a real downgrade and the log says so.
 */
/**
 * The gap between two turns of the same exchange.
 *
 * Much shorter than the gap between beats, because a reply lands on the
 * previous line far faster than a new section starts - a beat-length pause
 * between every turn is what makes spliced dialogue sound like two people in
 * separate rooms.
 */
export const TURN_GAP_S = 0.22;

export const renderScript = async (
  input: {
    beats: RenderableBeat[];
    /** Voice per host id. */
    voices: Record<string, import('../canon/schema').Voice>;
    beatPathFor: (name: string) => string;
    outputPath: string;
  },
  tts: import('./tts').TtsProvider,
  deps: RenderDeps = {},
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void
): Promise<RenderResult> => {
  const write = deps.writeFile ?? ((file, data) => fs.writeFileSync(file, data));
  const probe = deps.probe ?? probeDuration;
  const join = deps.concat ?? concatBeats;

  const { forSpeech } = await import('./tts');

  const voiceFor = (speaker: string) => {
    const voice = input.voices[speaker];
    if (!voice) {
      throw new Error(
        `no voice for speaker "${speaker}" (have: ${Object.keys(input.voices).join(', ')})`
      );
    }
    return voice;
  };

  const files: string[] = [];
  const timings: Array<{ id: string; type: string; durationS: number }> = [];
  let costPence = 0;
  let provider = '';
  let model = '';
  const voiceIds = new Set<string>();

  for (const [i, beat] of input.beats.entries()) {
    const speakers = new Set(beat.turns.map((t) => t.speaker));
    const multiVoice = speakers.size > 1;

    // THE BEAT'S FILE, DECIDED BEFORE ANYTHING IS RENDERED, because one of the
    // three paths below produces it directly rather than returning bytes for
    // the caller to write.
    const file = input.beatPathFor(`${String(i + 1).padStart(2, '0')}-${beat.beatId}.mp3`);

    // ALREADY RENDERED BEATS ARE NOT RENDERED AGAIN. Synthesis is the most
    // expensive step in the pipeline, and a run that died on beat nine would
    // otherwise pay for the first eight a second time. The file existing is
    // the only evidence needed: it is written only after a successful
    // synthesis, and its duration is measured below either way.
    //
    // Zero-length files are treated as absent rather than as done, because a
    // process killed mid-write leaves exactly that and it is the one case
    // where trusting the file would silently produce a silent beat.
    if (deps.reuseExisting !== false && fs.existsSync(file) && fs.statSync(file).size > 0) {
      onProgress?.(`beat ${i + 1}/${input.beats.length}: ${beat.beatId} (already rendered)`);
      files.push(file);

      const existing = await probe(file);
      if (existing === null) {
        throw new Error(
          `could not measure ${path.basename(file)}, which was already on disk. Delete it and ` +
            `re-run: a beat map built on an estimated duration puts every later timestamp out.`
        );
      }
      timings.push({ id: beat.beatId, type: beat.beatType, durationS: existing });
      continue;
    }

    onProgress?.(`beat ${i + 1}/${input.beats.length}: ${beat.beatId}`);

    // THREE PATHS, AND THE MIDDLE ONE EXISTS BECAUSE THE OLD FALLBACK WAS
    // WRONG. It joined every turn of a multi-speaker beat into one request in
    // the FIRST speaker's voice, so a two-host show came out as one person
    // reading both parts - silently, with no error and a perfectly valid file.
    // A show whose entire design rests on two people wanting different things
    // cannot be judged from that.
    let result: SynthesisResult;

    if (multiVoice && tts.synthesiseDialogue) {
      // The provider owns turn-taking. Overlap, interruption and a reply that
      // starts before the last line has landed all come from here.
      result = await tts.synthesiseDialogue({
        lines: beat.turns.map((t) => ({
          text: forSpeech(t.text),
          voice: voiceFor(t.speaker),
        })),
      });
      write(file, result.audio);
    } else if (multiVoice) {
      // A provider with no dialogue endpoint. Each turn in its own voice, then
      // joined. The hosts stay two people; what is lost is the seam between
      // them, which is audible, and is why this is a drafting path rather than
      // a publishing one.
      //
      // This branch writes `file` ITSELF, by concatenating straight into it.
      // Reading it back to hand bytes to a caller that would only write them
      // out again was the first shape, and it is wrong twice: it reads a file
      // for no reason, and it breaks the moment concatenation is stubbed.
      const turnFiles: string[] = [];
      let turnCost = 0;
      let turnProvider = '';
      let turnModel = '';
      const turnVoices = new Set<string>();

      for (const [t, turn] of beat.turns.entries()) {
        const one = await tts.synthesise({
          text: forSpeech(turn.text),
          voice: voiceFor(turn.speaker),
        });
        const turnFile = input.beatPathFor(
          `${String(i + 1).padStart(2, '0')}-${beat.beatId}-t${String(t + 1).padStart(2, '0')}.mp3`
        );
        write(turnFile, one.audio);
        turnFiles.push(turnFile);

        turnCost += one.costPence;
        turnProvider = one.provider;
        turnModel = one.model;
        turnVoices.add(one.voiceId);
      }

      await join(turnFiles, file, TURN_GAP_S);

      result = {
        audio: Buffer.alloc(0),
        // Named for what it actually is, so a run artifact never claims a
        // provider rendered an exchange it only rendered the pieces of.
        provider: `${turnProvider}+turnwise`,
        model: turnModel,
        voiceId: [...turnVoices].join('+'),
        costPence: turnCost,
      };
    } else {
      result = await tts.synthesise({
        text: forSpeech(beat.turns.map((t) => t.text).join('\n\n')),
        voice: voiceFor(beat.turns[0]!.speaker),
      });
      write(file, result.audio);
    }

    provider = result.provider;
    model = result.model;
    for (const id of result.voiceId.split('+')) voiceIds.add(id);
    costPence += result.costPence;
    onCost?.(result.costPence);
    files.push(file);

    const durationS = await probe(file);
    if (durationS === null) {
      throw new Error(
        `could not measure the duration of ${path.basename(file)}. The beat map depends on ` +
          `real durations, and an estimated one would put every later timestamp out.`
      );
    }
    timings.push({ id: beat.beatId, type: beat.beatType, durationS });
  }

  await join(files, input.outputPath, BEAT_GAP_S);

  const beatMap = buildBeatMap(timings);
  const durationS = (beatMap[beatMap.length - 1]?.endS ?? 0) || 0;

  return {
    audioFile: input.outputPath,
    durationS,
    beatMap,
    provider,
    model,
    voiceId: [...voiceIds].join('+'),
    costPence,
  };
};
