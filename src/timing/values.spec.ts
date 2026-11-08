import { describe, expect, it } from 'vitest';
import type { Hunk } from './diff.js';
import { parseValue, retriesRaise, timeoutRaise } from './values.js';

const h = (removed: string[], added: string[]): Hunk => ({
  removed,
  added: added.map((text, i) => ({ line: i + 1, text }))
});

describe('parseValue', () => {
  it.each([
    ['60_000', 60000],
    ['30 * 1000', 30000],
    ['2 * 60 * 1_000', 120000],
    ['0', Infinity],
    ['TIMEOUT', null],
    ['ms(5)', null],
    ['1.5', null]
  ])('parseValue(%s)', (expr, value) => expect(parseValue(expr)).toBe(value));
});

describe('timeoutRaise', () => {
  it('flags a raised timeout with the old value', () => {
    expect(timeoutRaise(h(['test.setTimeout(30_000);'], ['test.setTimeout(60_000);']))).toEqual([
      { rule: 'timeout-raise', line: 1, text: 'test.setTimeout(60_000);', was: '30_000' }
    ]);
  });

  it('ignores a lowered timeout', () => {
    expect(timeoutRaise(h(['  timeout: 30_000,'], ['  timeout: 5_000,']))).toEqual([]);
  });

  it('flags a new timeout with no was', () => {
    expect(timeoutRaise(h([], ['const o = { timeout: 5000 };']))).toEqual([
      { rule: 'timeout-raise', line: 1, text: 'const o = { timeout: 5000 };' }
    ]);
  });

  it('flags a timeout changed to 0 (no limit)', () => {
    expect(timeoutRaise(h(['timeout: 30_000,'], ['timeout: 0,']))).toEqual([
      { rule: 'timeout-raise', line: 1, text: 'timeout: 0,', was: '30_000' }
    ]);
  });

  it('treats different keys as different settings', () => {
    expect(timeoutRaise(h(['testTimeout: 5000,'], ['timeout: 5000,']))).toHaveLength(1);
  });

  it('ignores an unchanged non-literal value', () => {
    expect(timeoutRaise(h(['timeout:   TIMEOUT_MS,'], ['timeout: TIMEOUT_MS,']))).toEqual([]);
  });

  it('flags a changed non-literal value', () => {
    expect(timeoutRaise(h(['timeout: TIMEOUT_MS,'], ['timeout: LONG_TIMEOUT_MS,']))).toHaveLength(
      1
    );
  });

  it('flags a timeout inside an expect option', () => {
    expect(timeoutRaise(h([], ['expect(el).toBeVisible({ timeout: 10_000 });']))).toHaveLength(1);
  });

  it('flags added test.slow() and ignores a moved one', () => {
    expect(timeoutRaise(h([], ['test.slow();']))).toHaveLength(1);
    expect(timeoutRaise(h(['test.slow();'], ['test.slow();']))).toEqual([]);
  });

  it('ignores comments', () => {
    expect(timeoutRaise(h([], ['// timeout: 99_999 for local debugging']))).toEqual([]);
  });
});

describe('retriesRaise', () => {
  it('flags a raise above 1 with the old value', () => {
    expect(retriesRaise(h(['retries: 1,'], ['retries: 3,']))).toEqual([
      { rule: 'retries-raise', line: 1, text: 'retries: 3,', was: '1' }
    ]);
    expect(retriesRaise(h(['retries: 1,'], ['retries: 2,']))).toEqual([
      { rule: 'retries-raise', line: 1, text: 'retries: 2,', was: '1' }
    ]);
  });

  it('ignores a lowered value', () => {
    expect(retriesRaise(h(['retries: 3,'], ['retries: 1,']))).toEqual([]);
  });

  it('flags 3 to 4', () => {
    expect(retriesRaise(h(['retries: 3,'], ['retries: 4,']))).toHaveLength(1);
  });

  it('flags a non-literal value', () => {
    expect(retriesRaise(h([], ['retries: process.env.CI ? 2 : 0,']))).toHaveLength(1);
  });

  it('allows retries up to 1', () => {
    expect(retriesRaise(h([], ['retries: 0,']))).toEqual([]);
    expect(retriesRaise(h([], ['retries: 1,']))).toEqual([]);
    expect(retriesRaise(h(['retries: 0,'], ['retries: 1,']))).toEqual([]);
  });

  it('flags a new retries of 2', () => {
    expect(retriesRaise(h([], ['retries: 2,']))).toEqual([
      { rule: 'retries-raise', line: 1, text: 'retries: 2,' }
    ]);
  });

  it('flags CLI flags and retry:', () => {
    expect(retriesRaise(h([], ["'--retries=2'"]))).toHaveLength(1);
    expect(retriesRaise(h([], ['retry: 2,']))).toHaveLength(1);
  });

  it('ignores comments', () => {
    expect(retriesRaise(h([], ['// retries: 5 on CI']))).toEqual([]);
  });
});
