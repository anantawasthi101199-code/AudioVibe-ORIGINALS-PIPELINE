import { Persona } from '../canon/schema';
import { loadFormat } from '../formats/load';

/**
 * Whether a run gets a music bed.
 *
 * THE RUN'S OWN CHOICE WINS (--music or --no-music, carried as true or false).
 * Left undefined, the channel decides by the format's length, which is how the
 * owner's sheet puts it: shorts with music, long form without. Every pipeline
 * asks here, so make, approve, resume, the schedule and the studio agree.
 */
export const musicFor = (requested: boolean | undefined, persona: Persona, formatId: string): boolean =>
  requested ?? persona.music[loadFormat(formatId).kind === 'short' ? 'short' : 'long'];
