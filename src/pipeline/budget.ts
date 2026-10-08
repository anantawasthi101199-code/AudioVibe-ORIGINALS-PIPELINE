import {
  REGENERATE_ALLOWANCE_PENCE,
  REVOICE_ALLOWANCE_PENCE,
  episodeBudgetPence,
  episodeTargetPence,
  shortBudgetPence,
  shortTargetPence,
} from '../config';
import { loadFormat } from '../formats/load';
import { Run } from '../run/store';

const isShort = (run: Run): boolean => {
  try {
    return loadFormat(run.manifest.formatId).kind === 'short';
  } catch {
    return false;
  }
};

/** One voicing's allowance for every time an edit made the run voice again. */
const revoiceAllowance = (run: Run): number => {
  const kind = isShort(run) ? 'short' : 'long';
  return (
    (run.manifest.revoicings ?? 0) * REVOICE_ALLOWANCE_PENCE[kind] +
    // Plus a whole voicing's room for every regeneration: 15p for a short.
    (run.manifest.regenerations ?? 0) * REGENERATE_ALLOWANCE_PENCE[kind]
  );
};

/**
 * The HARD ceiling: 50p for a short, 200p for an episode (owner, 2026-10-08),
 * plus the re-voice allowance. A run that would pass it stops at the call
 * that passed it. See config's episodeBudgetPence for why there are two numbers.
 */
export const budgetFor = (run: Run): number =>
  (isShort(run) ? shortBudgetPence() : episodeBudgetPence()) + revoiceAllowance(run);

/**
 * The TARGET: 15p for a short, 120p for an episode, plus the same allowance.
 * Passing it is journalled and shown, never a stop.
 */
export const targetFor = (run: Run): number =>
  (isShort(run) ? shortTargetPence() : episodeTargetPence()) + revoiceAllowance(run);

/** Both, for anything that shows a run's spend against them. */
export const budgetsFor = (run: Run): { targetPence: number; ceilingPence: number } => ({
  targetPence: targetFor(run),
  ceilingPence: budgetFor(run),
});
