import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestModule } from 'vitest/node';
import type { FlakeEvent } from '../flakes/log.js';
import type { FlakeReporterOptions } from './options.js';
import VitestFlakeReporter from './vitest.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Entity = Record<string, unknown>;

function testCase(
  name: string,
  state: string,
  retryCount: number,
  errors?: { message: string }[]
): Entity {
  return {
    type: 'test',
    name,
    result: () => ({ state, errors }),
    diagnostic: () => ({ retryCount })
  };
}

function testSuite(name: string, children: Entity[]): Entity {
  return { type: 'suite', name, children: { array: () => children } };
}

function testModule(project: string, file: string, children: Entity[]): TestModule {
  return {
    project: { name: project },
    moduleId: join(ROOT, file),
    children: { array: () => children }
  } as unknown as TestModule;
}

const TREE = [
  testSuite('store', [
    testSuite('realtime', [
      testCase('broadcasts', 'passed', 1, [{ message: 'waitFor: not satisfied within 1000ms' }])
    ]),
    testCase('straight pass', 'passed', 0),
    testCase('hard fail', 'failed', 1, [{ message: 'nope' }])
  ])
];

function collect(options: FlakeReporterOptions = {}) {
  const events: FlakeEvent[] = [];
  const reporter = new VitestFlakeReporter({ ...options, append: (e) => void events.push(e) });
  return { events, reporter };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('VitestFlakeReporter', () => {
  it('records a retried pass with its nested suite title and first error', () => {
    vi.stubEnv('CHREODE_HEAD', 'abc123');
    const { events, reporter } = collect();
    reporter.onTestRunEnd([testModule('client', 'src/store.spec.ts', TREE)]);
    expect(events).toEqual([
      {
        kind: 'client',
        runner: 'vitest',
        project: 'client',
        file: 'src/store.spec.ts',
        title: 'store › realtime › broadcasts',
        firstAttemptError: 'waitFor: not satisfied within 1000ms',
        sha: 'abc123',
        at: expect.any(String)
      }
    ]);
  });

  it("defaults the kind to 'unit' when the project has no name", () => {
    const { events, reporter } = collect();
    reporter.onTestRunEnd([testModule('', 'src/store.spec.ts', TREE)]);
    expect(events.map((e) => [e.kind, e.project])).toEqual([['unit', '']]);
  });

  it('honours the kind and projects options, and tolerates an empty run', () => {
    const { events, reporter } = collect({ kind: 'ui', projects: ['client'] });
    reporter.onTestRunEnd([
      testModule('server', 'src/a.spec.ts', TREE),
      testModule('client', 'src/b.spec.ts', TREE)
    ]);
    reporter.onTestRunEnd([]);
    expect(events.map((e) => [e.kind, e.file])).toEqual([['ui', 'src/b.spec.ts']]);
  });

  it('tolerates a test with no diagnostic (it never ran)', () => {
    const { events, reporter } = collect();
    const neverRan = { ...testCase('skipped', 'skipped', 0), diagnostic: () => undefined };
    reporter.onTestRunEnd([testModule('client', 'src/c.spec.ts', [neverRan])]);
    expect(events).toEqual([]);
  });
});
