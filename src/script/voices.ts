/**
 * Keeping two hosts from turning into one person.
 *
 * THE FAILURE THIS EXISTS TO CATCH. Two hosts written by one model converge.
 * Not immediately and not obviously - by the fourth beat they are asking the
 * same kinds of questions at the same length in the same rhythm, and the
 * conversation stops being between two people and becomes one person doing
 * voices. It is the single most common way an AI two-hander falls apart, and it
 * is invisible to read-through because each individual line is fine.
 *
 * It is not invisible to measurement. Real people differ in how long they talk,
 * how often they ask rather than tell, how often they just acknowledge, and
 * which words they reach for. So each host declares those as numbers, and the
 * distance between the two hosts is checked. When it collapses, the beat is
 * rewritten.
 *
 * WHAT THE RESEARCH SAYS ABOUT THE OTHER HALF. Backchannels - the "mm", the
 * "right", the "wait, what?" - are what make a listener believe two people are
 * actually in a room. But rate and placement both matter: backchannels that are
 * randomly distributed, too sparse, or too frequent all measurably REDUCE
 * perceived naturalness. So this file checks for a band, not a maximum.
 *
 * And turn-length variance is to dialogue what sentence-length variance is to
 * prose. Real conversation has a four-word turn next to a sixty-word one.
 * Generated conversation makes every turn the same size, which reads as two
 * people taking it in turns to give speeches.
 */
import { z } from 'zod';
import { Host } from '../canon/schema';
import { Turn, withoutTags } from './dialogue';

/**
 * A host's measurable speech habits.
 *
 * Every field is countable. "Warm and curious" is not a habit, it is an
 * adjective, and it cannot fail a check.
 */
export const idiolectSchema = z.object({
  /**
   * Target mean words per turn.
   *
   * The most powerful single differentiator. A host who averages 15 words and
   * one who averages 45 read as different people before anything else does.
   */
  turnWordsMean: z.number().positive(),

  /** Share of this host's turns that end in a question, 0 to 1. */
  questionRate: z.number().min(0).max(1),

  /**
   * Share of this host's turns that are pure acknowledgement, 0 to 1.
   *
   * The listener-shaped host has a high rate here; the one holding the
   * documents has a low one.
   */
  backchannelRate: z.number().min(0).max(1),

  /**
   * Words and phrases this host reaches for, which the other must not.
   *
   * Small and specific. Three or four each. A shared tic is worse than none,
   * because it actively merges the two voices.
   */
  signature: z.array(z.string().min(1)).default([]),
});

export type Idiolect = z.infer<typeof idiolectSchema>;

/** Turns of this length or shorter can count as acknowledgement. */
const BACKCHANNEL_MAX_WORDS = 5;

const ACKNOWLEDGEMENT =
  /^(mm+|mhm|uh[- ]?huh|yeah|yep|yes|no|right|sure|ok|okay|wow|god|christ|hm+|huh|exactly|quite|indeed|wait|hang on|hold on|really|seriously|of course|i see|got it|fair enough)\b/i;

export const isBackchannel = (turn: Turn): boolean => {
  const text = withoutTags(turn.text).trim();
  const n = text.split(/\s+/).filter(Boolean).length;
  return n > 0 && n <= BACKCHANNEL_MAX_WORDS && ACKNOWLEDGEMENT.test(text);
};

export interface HostMeasurement {
  hostId: string;
  turns: number;
  words: number;
  turnWordsMean: number;
  turnWordsStdDev: number;
  questionRate: number;
  backchannelRate: number;
  signatureHits: number;
  /** Signature phrases belonging to OTHER hosts that this one used. */
  borrowedSignatures: string[];
}

const wordCount = (t: Turn) => withoutTags(t.text).split(/\s+/).filter(Boolean).length;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdDev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

export const measureHost = (
  hostId: string,
  turns: Turn[],
  allHosts: Array<{ id: string; idiolect?: Idiolect }>
): HostMeasurement => {
  const mine = turns.filter((t) => t.speaker === hostId);
  const lengths = mine.map(wordCount);

  const questions = mine.filter((t) => withoutTags(t.text).trim().endsWith('?')).length;
  const backchannels = mine.filter(isBackchannel).length;

  const ownSignature = allHosts.find((h) => h.id === hostId)?.idiolect?.signature ?? [];
  const othersSignature = allHosts
    .filter((h) => h.id !== hostId)
    .flatMap((h) => h.idiolect?.signature ?? []);

  const text = mine.map((t) => withoutTags(t.text)).join(' ').toLowerCase();
  const hits = (phrases: string[]) => phrases.filter((p) => text.includes(p.toLowerCase()));

  return {
    hostId,
    turns: mine.length,
    words: lengths.reduce((a, b) => a + b, 0),
    turnWordsMean: mean(lengths),
    turnWordsStdDev: stdDev(lengths),
    questionRate: mine.length ? questions / mine.length : 0,
    backchannelRate: mine.length ? backchannels / mine.length : 0,
    signatureHits: hits(ownSignature).length,
    borrowedSignatures: hits(othersSignature),
  };
};

export interface VoiceProblem {
  rule: string;
  detail: string;
  blocking: boolean;
}

/**
 * How different two hosts must be before they read as two people.
 *
 * Expressed as the ratio between their mean turn lengths. Below this they are
 * talking at the same size, and size is the first thing a listener hears.
 */
export const MIN_TURN_LENGTH_RATIO = 1.4;

/**
 * The band a backchannel rate has to sit in across the whole exchange.
 *
 * Both ends matter. Too few and it reads as two monologues alternating; too
 * many and it reads as one person being agreed with, which is worse. The
 * research is explicit that both extremes reduce perceived naturalness.
 */
export const BACKCHANNEL_BAND: [number, number] = [0.06, 0.3];

/**
 * The minimum spread of turn lengths.
 *
 * Real conversation puts a four-word turn next to a sixty-word one. Uniform
 * turn length is the dialogue version of uniform sentence length, and it is
 * just as reliable a tell.
 */
export const MIN_TURN_WORDS_STDDEV = 8;

/** Turns below this many are too few to judge any of the above. */
const MIN_TURNS_TO_JUDGE = 6;

export const checkVoices = (turns: Turn[], hosts: Host[]): {
  measurements: HostMeasurement[];
  problems: VoiceProblem[];
} => {
  const problems: VoiceProblem[] = [];
  const measurements = hosts.map((h) => measureHost(h.id, turns, hosts));

  // Single-host shows have nothing to diverge from.
  if (hosts.length < 2) return { measurements, problems };

  // A host using another host's signature phrase actively merges the voices,
  // and it is worth catching even in a short exchange.
  for (const m of measurements) {
    if (m.borrowedSignatures.length) {
      problems.push({
        rule: 'borrowedSignature',
        detail: `${m.hostId} used ${m.borrowedSignatures.map((s) => `"${s}"`).join(', ')}, which belongs to the other host`,
        blocking: true,
      });
    }
  }

  if (turns.length < MIN_TURNS_TO_JUDGE) return { measurements, problems };

  const speaking = measurements.filter((m) => m.turns > 0);
  if (speaking.length < 2) return { measurements, problems };

  // --- The convergence check ---
  const means = speaking.map((m) => m.turnWordsMean).sort((a, b) => b - a);
  const ratio = means[1]! > 0 ? means[0]! / means[1]! : Infinity;
  if (ratio < MIN_TURN_LENGTH_RATIO) {
    problems.push({
      rule: 'voicesConverged',
      detail:
        `both hosts average about the same turn length (${means.map((m) => m.toFixed(0)).join(' and ')} words). ` +
        `They are talking at the same size, which reads as one person doing two voices. ` +
        `One of them should be markedly terser.`,
      blocking: true,
    });
  }

  // --- Rhythm ---
  const allLengths = turns.map(wordCount);
  const spread = stdDev(allLengths);
  if (spread < MIN_TURN_WORDS_STDDEV) {
    problems.push({
      rule: 'flatTurnRhythm',
      detail:
        `turn lengths vary by only ${spread.toFixed(1)} words. Real conversation puts a ` +
        `four-word turn next to a sixty-word one; this is two people taking it in turns to ` +
        `give speeches.`,
      blocking: true,
    });
  }

  // --- Backchannels ---
  const backchannels = turns.filter(isBackchannel).length / turns.length;
  const [lo, hi] = BACKCHANNEL_BAND;
  if (backchannels < lo) {
    problems.push({
      rule: 'noBackchannels',
      detail:
        `only ${(backchannels * 100).toFixed(0)}% of turns are acknowledgements. Nobody is ` +
        `listening to anybody; they are alternating.`,
      blocking: false,
    });
  } else if (backchannels > hi) {
    problems.push({
      rule: 'tooManyBackchannels',
      detail:
        `${(backchannels * 100).toFixed(0)}% of turns are just acknowledgement. That is one ` +
        `person being agreed with, not a conversation.`,
      blocking: false,
    });
  }

  return { measurements, problems };
};

/** What to tell the writer about how each host talks. */
export const voiceBrief = (hosts: Host[]): string =>
  hosts
    .map((h) => {
      const i = h.idiolect;
      if (!i) return `- ${h.id} (${h.name}): ${h.role.trim().replace(/\s+/g, ' ')}`;
      const bits = [
        `averages about ${Math.round(i.turnWordsMean)} words per turn`,
        i.questionRate >= 0.3 ? 'asks often' : 'rarely asks',
        i.backchannelRate >= 0.2 ? 'reacts a lot in short beats' : 'reacts rarely',
      ];
      const sig = i.signature.length
        ? ` Reaches for: ${i.signature.map((s) => `"${s}"`).join(', ')} - and the other host never uses these.`
        : '';
      return `- ${h.id} (${h.name}): ${h.role.trim().replace(/\s+/g, ' ')} Speech: ${bits.join(', ')}.${sig}`;
    })
    .join('\n');
