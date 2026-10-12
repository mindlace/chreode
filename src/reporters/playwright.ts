import type { Reporter, TestCase, TestResult } from 'playwright/types/testReporter';
import { repoRelative, truncateError, type FlakeEvent } from '../flakes/log.js';
import {
  defaultAppend,
  headSha,
  resolveKind,
  wants,
  type FlakeReporterOptions
} from './options.js';

/**
 * Records every test that failed (or timed out) and then passed on a retry. Playwright loads
 * reporters by module specifier, hence the default export. Imports Playwright's types only.
 */
export default class PlaywrightFlakeReporter implements Reporter {
  private readonly options: FlakeReporterOptions;
  private readonly append: (event: FlakeEvent) => void;
  /** The first failed attempt of each test that has not passed yet. */
  private readonly failed = new Map<string, TestResult>();

  constructor(options: FlakeReporterOptions = {}) {
    this.options = options;
    this.append = options.append ?? defaultAppend;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'failed' || result.status === 'timedOut') {
      if (!this.failed.has(test.id)) this.failed.set(test.id, result);
      return;
    }
    const first = this.failed.get(test.id);
    if (result.status !== 'passed' || result.retry === 0 || first === undefined) return;
    this.failed.delete(test.id);
    // ['', project, file, ...describes, title]
    const titlePath = test.titlePath();
    const project = titlePath[1] ?? '';
    if (!wants(this.options.projects, project)) return;
    const trace = first.attachments.find((a) => a.name === 'trace')?.path;
    this.append({
      kind: resolveKind(this.options.kind, project, 'e2e'),
      runner: 'playwright',
      project,
      file: repoRelative(test.location.file),
      title: titlePath.slice(3).join(' › '),
      firstAttemptError: truncateError(first.error?.message),
      ...(trace ? { tracePath: trace } : {}),
      ...headSha(),
      at: new Date().toISOString()
    });
  }

  printsToStdio(): boolean {
    return false;
  }
}
