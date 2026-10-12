import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestCase, TestResult } from 'playwright/types/testReporter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlakeEvent } from '../flakes/log.js';
import type { FlakeReporterOptions } from './options.js';
import PlaywrightFlakeReporter from './playwright.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fakeTest(id: string, project = 'chromium'): TestCase {
  return {
    id,
    titlePath: () => ['', project, 'dep.spec.ts', 'deps', 'link navigates'],
    location: { file: join(ROOT, 'e2e/dep.spec.ts'), line: 27, column: 1 }
  } as unknown as TestCase;
}

function attempt(retry: number, status: string, over: Record<string, unknown> = {}): TestResult {
  return {
    retry,
    status,
    attachments: [],
    error: { message: `attempt ${retry} failed` },
    ...over
  } as unknown as TestResult;
}

function collect(options: FlakeReporterOptions = {}) {
  const events: FlakeEvent[] = [];
  const reporter = new PlaywrightFlakeReporter({ ...options, append: (e) => void events.push(e) });
  return { events, reporter };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PlaywrightFlakeReporter', () => {
  it('records a retry-pass with the first attempt error, its trace, and the sha', () => {
    vi.stubEnv('CHREODE_HEAD', 'abc123');
    const { events, reporter } = collect();
    const test = fakeTest('t1');
    const trace = {
      name: 'trace',
      path: 'test-results/x/trace.zip',
      contentType: 'application/zip'
    };
    reporter.onTestEnd(test, attempt(0, 'failed', { attachments: [trace] }));
    reporter.onTestEnd(test, attempt(1, 'passed'));
    expect(events).toEqual([
      {
        kind: 'e2e',
        runner: 'playwright',
        project: 'chromium',
        file: 'e2e/dep.spec.ts',
        title: 'deps › link navigates',
        firstAttemptError: 'attempt 0 failed',
        tracePath: 'test-results/x/trace.zip',
        sha: 'abc123',
        at: expect.any(String)
      }
    ]);
  });

  it('records nothing for a straight pass, a hard fail, or a first-attempt pass', () => {
    const { events, reporter } = collect();
    reporter.onTestEnd(fakeTest('pass'), attempt(0, 'passed'));
    const failing = fakeTest('fail');
    reporter.onTestEnd(failing, attempt(0, 'failed'));
    reporter.onTestEnd(failing, attempt(1, 'failed'));
    reporter.onTestEnd(fakeTest('lone-retry'), attempt(1, 'passed'));
    expect(events).toEqual([]);
  });

  it('charges the first failed attempt when several fail before a pass', () => {
    const { events, reporter } = collect();
    const test = fakeTest('t2');
    reporter.onTestEnd(test, attempt(0, 'failed'));
    reporter.onTestEnd(test, attempt(1, 'timedOut'));
    reporter.onTestEnd(test, attempt(2, 'passed'));
    expect(events).toHaveLength(1);
    expect(events[0]!.firstAttemptError).toBe('attempt 0 failed');
  });

  it('honours the kind and projects options', () => {
    const { events, reporter } = collect({
      kind: (project) => `e2e-${project}`,
      projects: ['chromium']
    });
    for (const project of ['chromium', 'mobile']) {
      const test = fakeTest(`t-${project}`, project);
      reporter.onTestEnd(test, attempt(0, 'failed'));
      reporter.onTestEnd(test, attempt(1, 'passed'));
    }
    expect(events.map((e) => [e.kind, e.project])).toEqual([['e2e-chromium', 'chromium']]);
  });

  it('strips ANSI colour codes from the error and omits an absent sha', () => {
    vi.stubEnv('CHREODE_HEAD', '');
    const esc = String.fromCharCode(27);
    const { events, reporter } = collect();
    const test = fakeTest('t3');
    reporter.onTestEnd(
      test,
      attempt(0, 'failed', { error: { message: `${esc}[31mexpected 1${esc}[39m` } })
    );
    reporter.onTestEnd(test, attempt(1, 'passed'));
    expect(events[0]!.firstAttemptError).toBe('expected 1');
    expect(events[0]).not.toHaveProperty('sha');
    expect(events[0]).not.toHaveProperty('tracePath');
  });
});
