import { DEFAULT_TIMEOUT_MS, type StepConfig } from '../config/types.js';

export const TIMING_LABEL = 'timing';

export interface TimingStepOptions {
  /** The triggers of your test steps: chreode cannot tell which steps are tests. */
  when: string[];
  timeoutMs?: number;
}

/** A signoff step that fails when the branch adds timing crutches to tests. */
export function timingStep(opts: TimingStepOptions): StepConfig {
  return {
    label: TIMING_LABEL,
    run: ({ head }) => `npx chreode timing-check --head ${head}`,
    when: [...opts.when],
    if: ({ base, head }) => base !== head,
    policeStderr: true,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
}
