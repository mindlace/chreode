import { describe, expect, it } from 'vitest';
import type { TimingResult } from './check.js';
import { formatTimingReport } from './report.js';

const url = 'https://x/flakes.md';

describe('formatTimingReport', () => {
  it('lists violations in aligned columns', () => {
    const result: TimingResult = {
      checked: ['e2e/editor.spec.ts'],
      exempted: [],
      violations: [
        {
          path: 'e2e/editor.spec.ts',
          rule: 'fixed-wait',
          line: 42,
          text: 'await page.waitForTimeout(500);'
        },
        {
          path: 'e2e/editor.spec.ts',
          rule: 'timeout-raise',
          line: 57,
          text: 'test.setTimeout(60_000);',
          was: '30_000'
        }
      ]
    };
    expect(formatTimingReport(result, url)).toEqual([
      '[chreode] timing: 2 violations in 1 file',
      '  e2e/editor.spec.ts:42  fixed-wait     await page.waitForTimeout(500);',
      '  e2e/editor.spec.ts:57  timeout-raise  test.setTimeout(60_000);  (was 30_000)',
      '  Fix: https://x/flakes.md#the-playbook — add a readiness signal or drive the deferred work.',
      '  Exempt only with a reviewed timing.allow entry in chreode.config.ts.'
    ]);
  });

  it('reports a clean run', () => {
    const result: TimingResult = { checked: ['a', 'b', 'c'], violations: [], exempted: [] };
    expect(formatTimingReport(result, url)).toEqual([
      '[chreode] timing: no timing crutches added in 3 checked file(s)'
    ]);
  });

  it('reports nothing to check', () => {
    const result: TimingResult = { checked: [], violations: [], exempted: [] };
    expect(formatTimingReport(result, url)).toEqual([
      '[chreode] timing: no test files changed; nothing to check'
    ]);
  });

  it('lists used exemptions', () => {
    const v = { path: 'src/timing/rules.spec.ts', rule: 'fixed-wait' as const, line: 1, text: 'x' };
    const result: TimingResult = {
      checked: ['src/timing/rules.spec.ts'],
      violations: [],
      exempted: [
        {
          entry: {
            path: 'src/timing/**',
            rule: 'fixed-wait',
            reason: 'rule fixtures: banned text as data'
          },
          violations: [v, { ...v, line: 2 }]
        }
      ]
    };
    expect(formatTimingReport(result, url)).toEqual([
      '[chreode] timing: no timing crutches added in 1 checked file(s)',
      '[chreode] timing: exempted by timing.allow:',
      '  fixed-wait  2 line(s) in src/timing/rules.spec.ts: rule fixtures: banned text as data'
    ]);
  });
});
