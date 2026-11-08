import { describe, expect, it } from 'vitest';
import { resolveTiming } from '../config/types.js';
import { checkTiming } from './check.js';
import type { FileDiff } from './diff.js';

const wait = (n: number) => `await page.waitForTimeout(${n});`;
const file = (path: string, ...texts: string[]): FileDiff => ({
  path,
  hunks: texts.map((text, i) => ({ removed: [], added: [{ line: i + 1, text }] }))
});

describe('checkTiming', () => {
  it('drops unmatched and perf files', () => {
    const result = checkTiming(
      [
        file('src/a.ts', wait(1)),
        file('e2e/a.spec.ts', wait(1)),
        file('e2e/load.perf.spec.ts', wait(1))
      ],
      resolveTiming()
    );
    expect(result.checked).toEqual(['e2e/a.spec.ts']);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].path).toBe('e2e/a.spec.ts');
  });

  it('skips disabled rules', () => {
    const result = checkTiming(
      [file('e2e/a.spec.ts', wait(1))],
      resolveTiming({ disable: ['fixed-wait'] })
    );
    expect(result.violations).toEqual([]);
  });

  it('exempts by path, rule and pattern', () => {
    const entry = {
      path: 'e2e/**',
      rule: 'fixed-wait' as const,
      pattern: /waitForTimeout\(1\)/,
      reason: 'r'
    };
    const result = checkTiming(
      [file('e2e/a.spec.ts', wait(1), wait(2), "test.skip('x', () => {});")],
      resolveTiming({ allow: [entry] })
    );
    expect(result.violations.map((v) => v.rule)).toEqual(['fixed-wait', 'skip']);
    expect(result.violations[0].text).toBe(wait(2));
    expect(result.exempted).toHaveLength(1);
    expect(result.exempted[0].entry).toBe(entry);
    expect(result.exempted[0].violations).toHaveLength(1);
  });

  it('tests a global pattern fresh on every line', () => {
    const entry = { path: 'e2e/**', rule: 'fixed-wait' as const, pattern: /sleep/g, reason: 'r' };
    const result = checkTiming(
      [file('e2e/a.spec.ts', 'await sleep(1);', 'await sleep(1);', 'await sleep(1);')],
      resolveTiming({ allow: [entry] })
    );
    expect(result.violations).toEqual([]);
    expect(result.exempted[0].violations).toHaveLength(3);
  });
});
