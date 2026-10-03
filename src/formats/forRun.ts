import { loadPersona } from '../canon/load';
import { Run } from '../run/store';
import { loadFormat } from './load';
import { EpisodeFormat } from './schema';

/**
 * The format a run's script is written against.
 *
 * THE SERIES INTRO LIVES HERE, not in five writers. A long episode filed into a
 * named series (`make --series "Founder Stories"`) opens by naming it, which the
 * owner's channel sheet asks for on every long-form show. Every writer already
 * builds its prompt from each beat's constraints, so the intro is one more
 * constraint on the first beat, added for this run only.
 */
export const formatForRun = (run: Run): EpisodeFormat => {
  const format = loadFormat(run.manifest.formatId);
  const title = run.manifest.seriesTitle;
  if (!title || format.kind === 'short' || format.beats.length === 0) return format;

  const show = loadPersona(run.manifest.personaId).name;
  const [first, ...rest] = format.beats;
  return {
    ...format,
    beats: [
      {
        ...first!,
        constraints: [
          `THE SERIES INTRO COMES FIRST. The very first line names the series and the show, in your own words, for example: "This is ${title}, from ${show}." One line, then begin.`,
          ...first!.constraints,
        ],
      },
      ...rest,
    ],
  };
};
