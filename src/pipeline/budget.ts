import { REVOICE_ALLOWANCE_PENCE, episodeBudgetPence, shortBudgetPence } from '../config';
import { loadFormat } from '../formats/load';
import { Run } from '../run/store';

/**
 * What this run may spend: 15p for a short, 120p for an episode - safety nets
 * above the owner's targets of about 10p and about a pound (2026-10-04) - plus one voicing's allowance for every time an edit made it
 * voice again. A run that would pass it stops at the call that passed it.
 */
export const budgetFor = (run: Run): number => {
  const short = loadFormat(run.manifest.formatId).kind === 'short';
  const base = short ? shortBudgetPence() : episodeBudgetPence();
  return base + (run.manifest.revoicings ?? 0) * REVOICE_ALLOWANCE_PENCE[short ? 'short' : 'long'];
};
