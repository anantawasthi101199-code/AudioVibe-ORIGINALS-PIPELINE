/**
 * A script written by hand: a blank template from the format, filled in in the
 * studio, then voiced. NOTHING IS PAID FOR BUT THE VOICE (owner, 2026-10-05).
 *
 *   [free] BLANK     one box per part of the format, each saying what goes there
 *   [free] CHECK     no box left blank, length against the format, banned phrases
 *   [paid] RENDER    the voice, after approval
 *
 * NO RESEARCH, SO NO SOURCES. The run carries empty corpus and claims artifacts
 * so publishing works, and its Sources sheet honestly lists nothing. What is
 * true in the script is the person's responsibility, which is why every
 * hand-written run needs a human before it goes out.
 */
import { loadPersona } from '../canon/load';
import {
  assertVoiceUnchanged,
  loadVoiceRegistry,
  recordVoices,
  saveVoiceRegistry,
} from '../canon/voiceRegistry';
import { formatForRun } from '../formats/forRun';
import { EpisodeFormat } from '../formats/schema';
import { GateFinding, GateReport } from '../qa/gate';
import { renderResultSchema, renderScript } from '../render/assemble';
import { musicFor } from '../render/musicFor';
import { Run } from '../run/store';
import { measure } from '../script/style';
import { Script, WORDS_PER_SECOND, fullText, scriptSchema } from '../script/write';
import { budgetFor, targetFor } from './budget';
import type { PipelineDeps } from './episode';
import { Persona } from '../canon/schema';

/** What an unfilled box starts with. The check refuses any turn still holding it. */
export const BLANK_MARK = '[WRITE:';

/** The template: one turn per part, for the show's first host. */
export const blankScript = (persona: Persona, format: EpisodeFormat, topic: string): Script =>
  scriptSchema.parse({
    personaId: persona.id,
    formatId: format.id,
    title: topic.length > 80 ? `${topic.slice(0, 77).trim()}...` : topic,
    description: topic,
    beats: format.beats.map((b) => ({
      beatId: b.id,
      beatType: b.type,
      turns: [
        {
          speaker: persona.hosts[0]!.id,
          text: `${BLANK_MARK} up to ${b.seconds[1]}s, at most ${Math.round(
            b.seconds[1] * WORDS_PER_SECOND,
          )} words] ${b.function.trim().replace(/\s+/g, ' ')}`,
        },
      ],
    })),
    writerModel: 'handwritten',
  });

/**
 * The blank, filled from a whole script written elsewhere: a `## <part>` line
 * before each of the format's parts, paragraphs split by a blank line, each
 * paragraph one turn. The same format as the studio's whole-script box.
 * Every part has to be there and nothing else may be, so a script written for
 * another format is refused rather than half-filled.
 */
export const fillBlank = (
  blank: Script,
  text: string,
  meta: { title: string; description: string },
): Script => {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^##\s+(\S.*?)\s*$/.exec(line);
    if (header) {
      current = header[1]!;
      if (sections.has(current)) throw new Error(`the part "${current}" appears twice`);
      sections.set(current, []);
    } else if (current) sections.get(current)!.push(line);
    else if (line.trim()) throw new Error('there is text before the first "## part" line');
  }
  const parts = blank.beats.map((b) => b.beatId);
  const unknown = [...sections.keys()].filter((k) => !parts.includes(k));
  if (unknown.length) throw new Error(`unknown parts: ${unknown.join(', ')}. The parts are: ${parts.join(', ')}`);
  return scriptSchema.parse({
    ...blank,
    title: meta.title,
    description: meta.description,
    beats: blank.beats.map((b) => {
      const paragraphs = (sections.get(b.beatId) ?? [])
        .join('\n')
        .split(/\n\s*\n/)
        .map((p) => p.trim().replace(/\s*\n\s*/g, ' '))
        .filter(Boolean);
      if (!paragraphs.length) throw new Error(`the part "${b.beatId}" has no text`);
      const speaker = b.turns[0]!.speaker;
      return { ...b, turns: paragraphs.map((p) => ({ speaker, text: p })) };
    }),
  });
};

/**
 * Create the run's artifacts. Called once, when the blank is made. With a
 * prepared script (a content map item that has one), the blank opens filled in.
 */
export const startHandwritten = (
  run: Run,
  prepared: { text: string; title: string; description: string } | null = null,
): Script => {
  const persona = loadPersona(run.manifest.personaId);
  const blank = blankScript(persona, formatForRun(run), run.manifest.topic);
  const script = prepared ? fillBlank(blank, prepared.text, prepared) : blank;
  const none = 'none: written by hand';
  run.writeArtifact('corpus', { sources: [], rejected: [] });
  run.writeArtifact('claims', { claims: [], unsupported: [] });
  // Both shapes publish reads: the reported one and fiction's continuity one.
  run.writeArtifact('verification', {
    verification: {
      results: [],
      blocking: [],
      costPence: 0,
      verifierModel: none,
    },
    counterEvidence: [],
    findings: [],
    checkerModel: none,
  });
  run.writeArtifact('script', script);
  for (const s of ['brief', 'corpus', 'reference', 'claims', 'verification', 'script'] as const) {
    run.markComplete(s);
  }
  run.journal({
    stage: 'script',
    event: prepared
      ? 'blank filled with the script written for this map item; nothing was paid for'
      : 'blank template made; nothing was paid for',
  });
  run.writeArtifact('qa', handwrittenGate(run, script));
  return script;
};

/** Free checks only. Deterministic, so it is also the re-gate. */
export const handwrittenGate = (run: Run, script: Script): GateReport => {
  const persona = loadPersona(run.manifest.personaId);
  const format = formatForRun(run);
  const text = fullText(script);
  const render = run.hasArtifact('render') ? run.readArtifact('render', renderResultSchema) : null;
  const seconds = render?.durationS ?? text.split(/\s+/).filter(Boolean).length / WORDS_PER_SECOND;
  const hi = format.targetSeconds[1];

  const findings: GateFinding[] = [];
  for (const beat of script.beats) {
    if (beat.turns.some((t) => t.text.includes(BLANK_MARK) || !t.text.trim())) {
      findings.push({
        check: 'blank',
        detail: `"${beat.beatId}" is not written yet`,
        blocking: true,
      });
    }
  }
  if (seconds > hi * 1.1) {
    findings.push({
      check: 'length',
      detail: `about ${Math.round(seconds)}s ${render ? 'measured' : 'read aloud'}; the format's ceiling is ${hi}s`,
      blocking: false,
    });
  }
  const measurement = measure(text, persona.styleCard.forbiddenPhrases);

  const held = run.awaitingApproval ? ['held before the render; approve to voice it.'] : [];
  return {
    passed: !findings.some((f) => f.blocking),
    findings,
    measurement,
    needsHumanReview: true,
    humanReviewReasons: ['written by hand: nothing checked the facts against a source', ...held],
  };
};

export const runHandwritten = async (
  run: Run,
  deps: PipelineDeps,
): Promise<{ run: Run; gate: GateReport }> => {
  const persona = loadPersona(run.manifest.personaId);
  const say = (stage: string) => (message: string) => {
    deps.log?.(message, stage);
    run.journal({ stage, event: message });
  };
  const budget = budgetFor(run);
  const spend = (pence: number) => {
    run.journal({ stage: 'render', event: 'spend', pence });
    run.spend(pence, budget, targetFor(run));
  };
  assertVoiceUnchanged(persona, deps.tts.name, loadVoiceRegistry());
  const script = run.readArtifact('script', scriptSchema);

  const before = handwrittenGate(run, script);
  if (run.awaitingApproval || !before.passed) {
    run.writeArtifact('qa', before);
    say('pipeline')(
      before.passed ? 'held: approve to voice it' : 'not voiced: a part is still blank',
    );
    return { run, gate: before };
  }

  if (!run.hasArtifact('render')) {
    const render = await renderScript(
      {
        beats: script.beats,
        voices: Object.fromEntries(persona.hosts.map((h) => [h.id, h.voice])),
        beatPathFor: (name) => run.mediaPath(name),
        outputPath: run.mediaPath('episode.wav'),
        music: musicFor(deps.music, persona, run.manifest.formatId),
        musicPhraseFile: deps.musicPhraseFile,
        musicSeed: run.manifest.topic,
      },
      deps.tts,
      {},
      spend,
      say('render'),
    );
    run.writeArtifact('render', render);
    run.markComplete('render');
    const { registry, recorded } = recordVoices(
      persona,
      deps.tts.name,
      run.id,
      loadVoiceRegistry(),
    );
    if (recorded.length) saveVoiceRegistry(registry);
  }

  const gate = handwrittenGate(run, script);
  run.writeArtifact('qa', gate);
  run.markComplete('qa');
  run.journal({
    stage: 'pipeline',
    event: gate.passed ? 'done' : 'gate-failed',
    detail: script.title,
    pence: run.manifest.spentPence,
  });
  return { run, gate };
};
