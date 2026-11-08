import { describe, expect, it } from 'vitest';
import type { StepContext } from '../config/types.js';
import { validateConfig } from '../config/validate.js';
import { timingStep } from './step.js';

const ctx = (base: string, head: string): StepContext => ({
  base,
  head,
  paths: [],
  triggers: [],
  isWorktree: false
});

describe('timingStep', () => {
  it('builds a policed step that checks the branch against the base', () => {
    const step = timingStep({ when: ['unit', 'e2e'] });
    expect(step).toMatchObject({
      label: 'timing',
      when: ['unit', 'e2e'],
      policeStderr: true,
      timeoutMs: 600_000
    });
    expect(typeof step.run === 'function' && step.run(ctx('b1', 'h1'))).toBe(
      'npx chreode timing-check --head h1'
    );
  });

  it('only runs when there is a range to check', () => {
    const step = timingStep({ when: ['unit'] });
    expect(step.if?.(ctx('b', 'h'))).toBe(true);
    expect(step.if?.(ctx('h', 'h'))).toBe(false);
  });

  it('takes a timeout and validates as a step', () => {
    const step = timingStep({ when: ['unit'], timeoutMs: 20 * 60_000 });
    const config = validateConfig({ steps: [step] });
    expect(config.steps[0]).toMatchObject({ label: 'timing', timeoutMs: 1_200_000 });
  });
});
