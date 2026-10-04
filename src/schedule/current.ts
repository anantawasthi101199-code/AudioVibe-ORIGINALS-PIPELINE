/**
 * The plan, built from what is actually on disk.
 *
 * SHARED BY THE COMMAND LINE AND THE STUDIO, which is the only reason it is its
 * own file. Two front ends computing "what should the studio make now" from the
 * same runs by different routes would eventually disagree, and the disagreement
 * would show up as a show that one of them thinks published last week and the
 * other thinks never did. One function, one answer.
 *
 * READ-ONLY AND FREE. Nothing here starts a run or spends anything. A schedule
 * you cannot inspect before it costs money is one nobody turns on.
 */
import { loadAllPersonas } from '../canon/load';
import { loadFormat } from '../formats/load';
import { Run } from '../run/store';
import { loadSchedule, loadTopics } from './load';
import { hasNewsDesk } from '../news/desk';
import { Plan, buildPlan, historyFor, runSummary } from './plan';

export const currentPlan = (now = new Date()): Plan => {
  const personas = loadAllPersonas();
  const known = new Set(personas.map((p) => p.id));

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
    personas: personas.filter((p) => known.has(p.id)),
    history: (personaId) => historyFor(personaId, summaries),
    // A news desk finds its own story every time; its queue is never empty.
    topicsQueued: (personaId) =>
      hasNewsDesk(personaId) ? Number.POSITIVE_INFINITY : loadTopics(personaId).topics.length,
    now,
  });
};
