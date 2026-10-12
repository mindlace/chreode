import type { Reporter, TestCase, TestModule, TestSuite } from 'vitest/node';
import { repoRelative, truncateError, type FlakeEvent } from '../flakes/log.js';
import {
  defaultAppend,
  headSha,
  resolveKind,
  wants,
  type FlakeReporterOptions
} from './options.js';

interface Where {
  project: string;
  file: string;
}

/**
 * Records every test that passed after at least one retry. vitest reporters are a root-level
 * option, so instantiate this in the root config's `reporters`; it sees every project and
 * filters with `projects`. Imports vitest's types only.
 */
export class VitestFlakeReporter implements Reporter {
  private readonly options: FlakeReporterOptions;
  private readonly append: (event: FlakeEvent) => void;

  constructor(options: FlakeReporterOptions = {}) {
    this.options = options;
    this.append = options.append ?? defaultAppend;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    for (const testModule of testModules) {
      const project = testModule.project.name;
      if (!wants(this.options.projects, project)) continue;
      const where = { project, file: repoRelative(testModule.moduleId) };
      this.walk(testModule.children.array(), [], where);
    }
  }

  private walk(
    entities: ReadonlyArray<TestSuite | TestCase>,
    titles: string[],
    where: Where
  ): void {
    for (const entity of entities) {
      if (entity.type === 'suite') {
        this.walk(entity.children.array(), [...titles, entity.name], where);
        continue;
      }
      const result = entity.result();
      if (result.state !== 'passed' || (entity.diagnostic()?.retryCount ?? 0) === 0) continue;
      this.append({
        kind: resolveKind(this.options.kind, where.project, where.project || 'unit'),
        runner: 'vitest',
        project: where.project,
        file: where.file,
        title: [...titles, entity.name].join(' › '),
        // A test that passed on retry still reports the errors of its failed attempts.
        firstAttemptError: truncateError(result.errors?.[0]?.message),
        ...headSha(),
        at: new Date().toISOString()
      });
    }
  }
}

export default VitestFlakeReporter;
