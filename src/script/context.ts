/**
 * Placing things, so a listener knows where and when they are.
 *
 * WHY THIS IS SEPARATE FROM PLAIN WORDS. A listener heard an episode where the
 * hard words were, by the measure of the rule that covers them, explained:
 *
 *   "settled them along the new border as hajduks, militiamen who were given
 *    land they could not sell or lose, on the understanding that in exchange
 *    they would guard the frontier in peacetime and fight for the emperor"
 *
 * That is a good explanation, and the listener still came away asking "what is
 * a hajduk, what are the city names, which kingdom, what was the timeline,
 * what was the war about". The words were defined. Nothing was PLACED.
 *
 * Three specific failures, all of them in that episode:
 *
 *   NOTHING WAS ANCHORED TO ANYTHING ALREADY KNOWN. Pozarevac, Medvegia and
 *   Belgrade were named; none was put on a map a listener carries. "Medvegia, a
 *   village in what is now central Serbia" costs five words and is the
 *   difference between a name and a place.
 *
 *   THE WAR WAS NAMED BY ITS EFFECT. "A peace ending a war that had been going
 *   badly for the Ottomans" says who was losing and never says who was fighting,
 *   over what, or for how long. A listener cannot picture a war they have not
 *   been told the shape of.
 *
 *   ALL OF IT ARRIVED AT ONCE. The treaty, the frontier, the settlement policy,
 *   the belief system and the burial custom were delivered in a single beat, and
 *   by the time the story needed any of it, it had gone. Context is not a
 *   prologue to get through; it is information that lands where it is used.
 *
 * THE TEST FOR ALL OF IT: could the listener draw a rough map and a rough
 * timeline from what they have been told? Not an accurate one. A rough one.
 */

export const CONTEXT_GUIDANCE = [
  'PLACE EVERY PLACE AGAINST SOMETHING THE LISTENER ALREADY KNOWS. A name on its own is not a place. "Medvegia, a village in what is now central Serbia, a few days ride south of Belgrade" costs a clause and turns a sound into somewhere. Modern countries, big cities, coastlines, rivers - whatever they are likeliest to have a picture of.',
  'ANCHOR EVERY DATE THE SAME WAY. A year is a number until it is attached to something. "1732" becomes real as "three hundred years ago", or "while Bach was still alive", or "two generations before the French Revolution". Give the year AND the anchor, not one or the other.',
  'SAY WHAT A THING WAS FOR, not only what it did. A war gets who was fighting whom and what over. A treaty gets what it settled. An institution, an army, a court or an office gets the job it existed to do. "A war that was going badly for the Ottomans" tells the listener who was losing and never tells them what the war was.',
  'A TITLE OR A RANK IS A JOB. Give it in ordinary words the first time - not "a Kameralprovisor" but "the civilian official who ran the district for Vienna". The foreign word can follow; it cannot lead.',
  'DELIVER CONTEXT WHERE IT IS USED, NOT ALL AT THE FRONT. A listener cannot hold five things about a place in reserve for later. Say what is needed when it becomes needed, so the explanation and the thing it explains are in the same breath.',
  'RE-PLACE ANYTHING RETURNING AFTER A LONG ABSENCE. A name last heard six minutes ago is a new name. One phrase is enough - "Flueckinger, the second army surgeon" - and it costs nothing next to a listener quietly losing the thread.',
  'THE TEST: from what you have said, could somebody sketch a rough map and a rough timeline? If not, something they need has been assumed.',
];
