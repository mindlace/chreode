import { describe, expect, it } from 'vitest';
import type { Hunk } from './diff.js';
import { evaluateHunk } from './rules.js';

const added = (...texts: string[]): Hunk => ({
  removed: [],
  added: texts.map((text, i) => ({ line: i + 1, text }))
});

describe('fixed-wait', () => {
  it.each([
    'await page.waitForTimeout(500);',
    'await new Promise((r) => setTimeout(r, 100));',
    'await new Promise(resolve => setTimeout(resolve, 1_000))',
    'await sleep(200);',
    'await delay(50);',
    'await wait(1000);'
  ])('flags %s', (t) => {
    expect(evaluateHunk(added(t), ['fixed-wait'])).toHaveLength(1);
  });

  it.each([
    'vi.advanceTimersByTime(500);',
    'await vi.advanceTimersByTimeAsync(500);',
    'clock.tick(1000);',
    'await page.clock.runFor(2000);',
    "await page.clock.fastForward('01:00');",
    'await wait(() => ready);',
    "await page.waitForSelector('#x');",
    "setTimeout(() => emit('tick'), 0);",
    'await retryDelay(3);',
    "await page.keyboard.type('hi', { delay: 50 });",
    '// never page.waitForTimeout(500) here',
    '* await sleep(100) would hide it'
  ])('ignores %s', (t) => {
    expect(evaluateHunk(added(t), ['fixed-wait'])).toEqual([]);
  });
});

describe('skip', () => {
  it.each([
    "test.skip('flaky on CI', async () => {",
    'it.skip("x", () => {',
    'describe.skip(`suite`, () => {',
    "test.fixme('later', async () => {",
    'test.skip();',
    'test.fixme()',
    "test.describe.skip('x', () => {",
    'test.describe.fixme(() => {',
    "xit('x', () => {",
    "xtest('x', () => {",
    "xdescribe('x', () => {"
  ])('flags %s', (t) => {
    expect(evaluateHunk(added(t), ['skip'])).toHaveLength(1);
  });

  it.each([
    "test.skip(browserName === 'webkit', 'no webkit');",
    "test.skip(({ browserName }) => browserName === 'webkit');",
    "test.fixme(isMobile, 'later');",
    "it.skipIf(process.platform === 'win32')('x', () => {",
    "// test.skip('x')",
    'const skip = items.slice(1);'
  ])('ignores %s', (t) => {
    expect(evaluateHunk(added(t), ['skip'])).toEqual([]);
  });
});

describe('net-new counting', () => {
  it('does not flag a reformatted existing wait', () => {
    const hunk: Hunk = {
      removed: ['await page.waitForTimeout(500)'],
      added: [{ line: 7, text: '  await page.waitForTimeout(500);' }]
    };
    expect(evaluateHunk(hunk, ['fixed-wait'])).toEqual([]);
  });

  it('flags only the excess, last ones first in the hunk', () => {
    const hunk: Hunk = {
      removed: ['await sleep(1);'],
      added: [
        { line: 3, text: 'await sleep(1);' },
        { line: 4, text: 'await sleep(2);' }
      ]
    };
    expect(evaluateHunk(hunk, ['fixed-wait'])).toEqual([
      { rule: 'fixed-wait', line: 4, text: 'await sleep(2);' }
    ]);
  });

  it('runs only the listed rules', () => {
    expect(evaluateHunk(added("test.skip('x', () => {"), ['fixed-wait'])).toEqual([]);
  });
});
