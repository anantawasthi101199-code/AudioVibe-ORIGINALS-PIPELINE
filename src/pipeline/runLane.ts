/**
 * Run a channel's own pipeline - ONE place that decides which.
 *
 * WHY THIS EXISTS. The command line chose the lane (news, business,
 * psychology, story, fiction) but the studio called the story pipeline for
 * every non-fiction channel, so a Business Decoded run started in the studio
 * skipped its single scored source, a Psyche Session run skipped its research
 * AND its safety floor, and a news run skipped its desk. Every caller - the
 * command line, the schedule, the studio's start and approve - now comes here.
 */
import { loadPersona } from '../canon/load';
import { GateReport } from '../qa/gate';
import { Run } from '../run/store';
import { runBusiness } from './business';
import { PipelineDeps, runEpisode } from './episode';
import { runFiction } from './fiction';
import { laneOf } from './lanes';
import { runNews } from './news';
import { runPsych } from './psych';

export const runLane = async (run: Run, deps: PipelineDeps): Promise<{ run: Run; gate: GateReport }> => {
  const persona = loadPersona(run.manifest.personaId);
  if (persona.fiction) return runFiction({ run }, deps);
  switch (laneOf(persona)) {
    case 'news':
      return runNews(run, deps);
    case 'business':
      return runBusiness(run, deps);
    case 'psychology':
      return runPsych(run, deps);
    default:
      return runEpisode(run, deps);
  }
};
