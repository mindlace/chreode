import { DEFAULT_TIMEOUT_MS, type StepConfig } from '../config/types.js';

export const BURN_IN_LABEL = 'burn-in';

export interface BurnInStepOptions {
  /** The triggers of your test steps: chreode cannot tell which steps are tests. */
  when: string[];
  timeoutMs?: number;
}

/** A signoff step that burns in the test files changed since the base. Place it after the
 *  test steps. */
export function burnInStep(opts: BurnInStepOptions): StepConfig {
  return {
    label: BURN_IN_LABEL,
    run: ({ base, head }) => `npx chreode burn-in --base ${base} --head ${head}`,
    when: [...opts.when],
    if: ({ base, head }) => base !== head,
    policeStderr: true,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
}
