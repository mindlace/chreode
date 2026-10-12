import { describe, expect, it } from 'vitest';
import type { StepContext } from '../config/types.js';
import { validateConfig } from '../config/validate.js';
import { burnInStep } from './step.js';

const ctx = (base: string, head: string): StepContext => ({
  base,
  head,
  paths: [],
  triggers: [],
  isWorktree: false
});

describe('burnInStep', () => {
  it('builds a policed step that burns in base..head', () => {
    const step = burnInStep({ when: ['unit', 'e2e'] });
    expect(step).toMatchObject({
      label: 'burn-in',
      when: ['unit', 'e2e'],
      policeStderr: true,
      timeoutMs: 600_000
    });
    expect(typeof step.run === 'function' && step.run(ctx('b1', 'h1'))).toBe(
      'npx chreode burn-in --base b1 --head h1'
    );
  });

  it('only runs when there is a range to burn in', () => {
    const step = burnInStep({ when: ['unit'] });
    expect(step.if?.(ctx('b', 'h'))).toBe(true);
    expect(step.if?.(ctx('h', 'h'))).toBe(false);
  });

  it('takes a timeout and validates as a step', () => {
    const step = burnInStep({ when: ['unit'], timeoutMs: 20 * 60_000 });
    const config = validateConfig({ steps: [step] });
    expect(config.steps[0]).toMatchObject({ label: 'burn-in', timeoutMs: 1_200_000 });
  });
});
