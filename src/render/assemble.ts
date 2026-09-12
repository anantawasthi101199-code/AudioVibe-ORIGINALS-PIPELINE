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
 * How long the silence at the end of a rendered beat may run.
 *
 * THIS IS A TRUNCATION DETECTOR, and it exists because a listener heard one.
 * The words "does not let people leave" were in the script, the beat was
 * complete, and they were simply not in the audio - the file stopped after "by
 * its own law" and the next beat began.
 *
 * Re-rendering the identical text through the identical code settled what
 * happened: 67.56s and 67.20s on two fresh attempts against the 65.95s the run
 * produced. OpenAI's speech endpoint drops the tail of an utterance
 * intermittently, and nothing downstream noticed because the loss is about two
 * per cent of the beat - far inside the normal variation in speaking rate, so
 * no duration ratio could ever separate it from a beat that simply reads fast.
 *
 * The trailing silence CAN separate them, and by a wide margin:
 *
 *   complete   0.31s and 0.41s of silence after the last word
 *   truncated  1.48s
 *
 * Whatever the mechanism - the model appears to emit its end-of-utterance
 * padding after stopping early - the signal is four times clearer than the
 * duration and points the right way.
 */
export const MAX_TRAILING_SILENCE_S = 0.9;

/** Below this the detector is measuring the encoder, not the speech. */
const SILENCE_FLOOR_DB = -40;

/**
 * Seconds of silence at the end of a file, or null when it cannot be measured.
 *
 * Null is treated as "no problem found" by the caller, which is the right way
 * round: this is a heuristic guarding against a provider defect, and a missing
 * measurement must never be able to fail a render on its own.
 */
export const trailingSilence = async (file: string, durationS: number): Promise<number | null> => {
  // Keeps the unit suite hermetic: a test driving renderScript with an injected
  // writeFile never puts bytes on disk, and spawning ffmpeg to be told so would
  // make these tests depend on ffmpeg for an answer already known.
  if (!fs.existsSync(file)) return null;

  const res = await runProcess(ffmpegBin(), [
    '-nostats',
    '-v', 'info',
    '-i', file,
    '-af', `silencedetect=noise=${SILENCE_FLOOR_DB}dB:d=0.2`,
    '-f', 'null',
    '-',
  ]);

  // ffmpeg writes filter output to stderr even on success.
  const starts = [...res.stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const last = starts.filter((n) => Number.isFinite(n)).pop();
  if (last === undefined) return null;

  const trailing = durationS - last;
  return trailing >= 0 ? trailing : null;
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
    '-ar', '48000',
    '-ac', '1',
    // THE CODEC FOLLOWS THE CONTAINER, and it has to, because this function has
    // two callers wanting two different things. Joining beats produces the
    // episode as 48kHz mono WAV: the platform masters and transcodes, so
    // handing it a clean uncompressed source makes its single 192k encode the
    // only lossy step. Joining TURNS produces one beat file, and beat files are
    // mp3 because that is what the TTS providers return.
    //
    // Hardcoding PCM meant writing raw samples into an .mp3 container, which
    // ffmpeg refuses with "Invalid audio stream. Exactly one MP3 audio stream
    // is required" - a message that names neither the codec nor the caller.
    ...(outputPath.toLowerCase().endsWith('.mp3')
      ? ['-c:a', 'libmp3lame', '-b:a', '192k']
      : ['-c:a', 'pcm_s16le']),
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
  /**
   * Trailing silence in a rendered file, for the truncation guard.
   *
   * Injected so the unit suite can drive the retry without ffmpeg, and so a
   * caller that cannot run ffmpeg at all gets the render rather than an error:
   * the default returns the measurement, and a null from it means "nothing
   * found", never "fail".
   */
  trailing?: (file: string, durationS: number) => Promise<number | null>;
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

/**
 * How much of the neighbouring beats to send as prosody context.
 *
 * Enough for the model to hear where the sentence before was going and where
 * the next one starts, and no more: this is never spoken, and on a provider
 * that bills by character, sending whole beats would roughly double the render
 * cost while changing nothing a listener hears.
 */
export const STITCH_CHARS = 400;

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
  const measureTrailing = deps.trailing ?? trailingSilence;
  const join = deps.concat ?? concatBeats;

  const { forSpeech } = await import('./tts');
  const { withoutTags } = await import('../script/dialogue');

  // WHAT THE ENGINE WILL ACTUALLY SAY. The script marks delivery as `[serious]`
  // or `[quietly]` for Eleven v3, which reads them as direction. Anything else
  // reads them as words, and a drafted episode was saying "serious" out loud in
  // the middle of a sentence. See TtsProvider.understandsTags.
  //
  // Every path that hands text to a provider goes through this, including the
  // prosody context: sending a tag as previous_text to an engine that cannot
  // read tags is asking it to imitate the sound of somebody saying "quietly".
  const speakable = (text: string): string =>
    tts.understandsTags ? forSpeech(text) : forSpeech(withoutTags(text));

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

    // Measured once, by whichever path measures it. The beat map needs a real
    // duration and the truncation guard needs one too, and probing the same
    // file twice would be a second process for a number already in hand.
    let measured: number | null = null;

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
          text: speakable(t.text),
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
          text: speakable(turn.text),
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
      // THE TAIL OF THE BEAT BEFORE AND THE HEAD OF THE ONE AFTER, neither of
      // them spoken. They condition the delivery so the voice carries across a
      // join instead of restarting at each one, which is the single most
      // audible fault in a finished episode. See SynthesisRequest.
      //
      // A few hundred characters is enough - it is prosody context, not
      // content - and sending more would cost characters on a provider that
      // bills by them while changing nothing.
      const before = input.beats[i - 1];
      const after = input.beats[i + 1];
      const request = {
        text: speakable(beat.turns.map((t) => t.text).join('\n\n')),
        voice: voiceFor(beat.turns[0]!.speaker),
        previousText: before
          ? speakable(before.turns.map((t) => t.text).join(' ')).slice(-STITCH_CHARS)
          : undefined,
        nextText: after
          ? speakable(after.turns.map((t) => t.text).join(' ')).slice(0, STITCH_CHARS)
          : undefined,
      };

      result = await tts.synthesise(request);
      write(file, result.audio);

      // A TRUNCATED RENDER IS WORTH ONE MORE CALL. The provider drops the tail
      // of an utterance intermittently - proven by rendering identical text
      // three times and getting 67.56s, 67.20s and 65.95s - and the loss lands
      // on the last words of a beat, which is the most noticeable place for it.
      //
      // Detected on trailing silence rather than duration, because the loss is
      // about two per cent of the beat and no duration ratio can separate that
      // from a beat that simply reads fast. See MAX_TRAILING_SILENCE_S.
      //
      // The retry is kept only if it is actually better, so a beat that ends on
      // a deliberate long pause is not made worse by a second attempt.
      measured = await probe(file);
      const firstTrailing =
        measured === null ? null : await measureTrailing(file, measured);

      if (firstTrailing !== null && firstTrailing > MAX_TRAILING_SILENCE_S) {
        onProgress?.(
          `beat ${i + 1}/${input.beats.length}: ${beat.beatId} ended on ` +
            `${firstTrailing.toFixed(1)}s of silence, which usually means the tail was dropped. Re-rendering.`
        );

        const retry = await tts.synthesise(request);
        const retryFile = `${file}.retry`;
        write(retryFile, retry.audio);
        costPence += retry.costPence;
        onCost?.(retry.costPence);

        const retryDuration = await probe(retryFile);
        const retryTrailing =
          retryDuration === null ? null : await measureTrailing(retryFile, retryDuration);

        if (retryTrailing !== null && retryTrailing < firstTrailing) {
          // Written through the injected writer rather than renamed, because
          // everything else in this function goes through it and a direct fs
          // call here would be the one path that touches the disk regardless.
          write(file, retry.audio);
          result = retry;
          measured = retryDuration;
        }
        fs.rmSync(retryFile, { force: true });
      }
    }

    provider = result.provider;
    model = result.model;
    for (const id of result.voiceId.split('+')) voiceIds.add(id);
    costPence += result.costPence;
    onCost?.(result.costPence);
    files.push(file);

    const durationS = measured ?? (await probe(file));
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
