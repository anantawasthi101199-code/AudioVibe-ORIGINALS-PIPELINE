/**
 * Reading the schedule and the topic queues off disk.
 *
 * BOTH ARE CONTENT, NOT CONFIG, which is why they are YAML next to the personas
 * and the beat sheets rather than environment variables. Changing how often a
 * show publishes, or what it publishes about next, should be an edit somebody
 * can make and review - not a deploy, and not a value typed into a dashboard
 * nobody can diff.
 *
 * A TOPIC QUEUE IS THE EDITORIAL SURFACE OF THIS WHOLE STUDIO. It is the one
 * place a person decides what the shows are about, and it is deliberately dumb:
 * a list, in order, consumed from the top. Generating topics automatically was
 * considered and rejected - a studio that picks its own subjects converges on
 * whatever the model finds most available, which is the same handful of stories
 * everyone else is already telling.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';
import { repoRoot } from '../config';
import { Schedule, scheduleSchema } from './schema';

export class ScheduleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleLoadError';
  }
}

const schedulePath = (dir?: string): string => path.join(dir ?? repoRoot(), 'schedule.yaml');

/**
 * The schedule, or an empty one if there is no file.
 *
 * An absent schedule means nothing is ever due, which is the correct reading of
 * "no schedule" and the safe direction: a studio that publishes nothing is a
 * problem somebody notices, and a studio that publishes something nobody asked
 * for is a problem somebody's followers notice.
 */
export const loadSchedule = (dir?: string): Schedule => {
  const file = schedulePath(dir);
  if (!fs.existsSync(file)) return { shows: {}, paused: false };

  try {
    return scheduleSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')) ?? {});
  } catch (err) {
    // Loud, because the alternative is a malformed schedule reading as "nothing
    // due" and a studio going quiet with no error anywhere.
    throw new ScheduleLoadError(`${file} is not a readable schedule: ${(err as Error).message}`);
  }
};

export const topicQueueSchema = z.object({
  /**
   * What this show covers next, in order, consumed from the top.
   *
   * Plain strings rather than objects. A topic is a sentence a person writes;
   * anything more structured is the brief, and the brief is generated.
   */
  topics: z.array(z.string().min(1)).default([]),
});

export type TopicQueue = z.infer<typeof topicQueueSchema>;

const queuePath = (personaId: string, dir?: string): string =>
  path.join(dir ?? path.join(repoRoot(), 'topics'), `${personaId}.yaml`);

export const loadTopics = (personaId: string, dir?: string): TopicQueue => {
  const file = queuePath(personaId, dir);
  if (!fs.existsSync(file)) return { topics: [] };

  try {
    return topicQueueSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')) ?? {});
  } catch (err) {
    throw new ScheduleLoadError(`${file} is not a readable topic queue: ${(err as Error).message}`);
  }
};

/**
 * Take the next topic off a show's queue and write the rest back.
 *
 * TAKEN BEFORE THE RUN, NOT AFTER. A topic consumed only on success means a
 * failing show retries the same subject on every tick forever, spending money
 * each time and never reaching the next one. Consumed up front, a failure costs
 * that topic - which is recoverable by putting it back, and is visible in the
 * diff of this file rather than invisible in a loop.
 */
export const takeTopic = (personaId: string, dir?: string): string | null => {
  const file = queuePath(personaId, dir);
  const queue = loadTopics(personaId, dir);
  const next = queue.topics[0];
  if (!next) return null;

  const rest = queue.topics.slice(1);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify({ topics: rest }), 'utf8');
  return next;
};

/** Put a topic back on the front, for a run that failed before it started. */
export const returnTopic = (personaId: string, topic: string, dir?: string): void => {
  const file = queuePath(personaId, dir);
  const queue = loadTopics(personaId, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify({ topics: [topic, ...queue.topics] }), 'utf8');
};
