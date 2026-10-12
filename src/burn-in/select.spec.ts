import { describe, expect, it } from 'vitest';
import { fakeExec } from '../../test/support/fake-exec.js';
import type { BurnInRunner, ResolvedBurnIn } from '../config/types.js';
import {
  BurnInError,
  burnInCandidates,
  burnInCommands,
  runnerFor,
  selectBurnIn
} from './select.js';

const DIFF = 'git diff --name-only --no-renames --diff-filter=d -z b..h';

const e2e: BurnInRunner = {
  name: 'e2e',
  match: 'e2e/**/*.spec.ts',
  ignore: ['e2e/helpers/**', 'e2e/**/*.perf.spec.ts'],
  command: (files, n) => `playwright test --repeat-each=${n} --retries=0 ${files.join(' ')}`
};
const client: BurnInRunner = {
  name: 'client',
  match: 'src/**/*.svelte.spec.ts',
  command: (files, n) =>
    Array.from({ length: n }, () => `vitest --project client ${files.join(' ')}`)
};
const server: BurnInRunner = {
  name: 'server',
  match: ['src/**/*.spec.ts', /^scripts\/.*\.spec\.ts$/],
  command: (files, n) =>
    Array.from({ length: n }, () => `vitest --project server ${files.join(' ')}`)
};
const config = (over: Partial<ResolvedBurnIn> = {}): ResolvedBurnIn => ({
  repeats: 2,
  maxFiles: 12,
  runners: [e2e, client, server],
  ...over
});

describe('burnInCandidates', () => {
  it('asks git for added/modified paths only (renames as their new path), newest first', () => {
    const { exec, calls } = fakeExec({
      [DIFF]: 'old.spec.ts\0mid.spec.ts\0new.spec.ts\0gone.ts\0'
    });
    const mtimes: Record<string, number | null> = {
      'old.spec.ts': 1,
      'mid.spec.ts': 2,
      'new.spec.ts': 3,
      'gone.ts': null
    };
    expect(burnInCandidates('b', 'h', exec, (p) => mtimes[p] ?? null)).toEqual([
      'new.spec.ts',
      'mid.spec.ts',
      'old.spec.ts'
    ]);
    expect(calls).toEqual([DIFF]);
  });

  it('keeps git order among equal mtimes', () => {
    const { exec } = fakeExec({ [DIFF]: 'a\0b\0c\0' });
    expect(burnInCandidates('b', 'h', exec, () => 5)).toEqual(['a', 'b', 'c']);
  });

  it('is empty when base is head', () => {
    const { exec, calls } = fakeExec({});
    expect(burnInCandidates('h', 'h', exec, () => 1)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('runnerFor', () => {
  it('takes the first runner that matches and does not ignore the path', () => {
    expect(runnerFor('e2e/a.spec.ts', [e2e, server])).toBe(e2e);
    expect(runnerFor('src/a.svelte.spec.ts', [e2e, client, server])).toBe(client);
    expect(runnerFor('scripts/x.spec.ts', [e2e, client, server])).toBe(server);
    expect(runnerFor('e2e/helpers/x.spec.ts', [e2e, server])).toBeNull();
    expect(runnerFor('src/a.ts', [e2e, client, server])).toBeNull();
  });

  it('lets a later runner take a path an earlier one ignores', () => {
    const perf: BurnInRunner = { name: 'perf', match: '**/*.perf.spec.ts', command: () => 'perf' };
    expect(runnerFor('e2e/x.perf.spec.ts', [e2e, perf])).toBe(perf);
  });
});

describe('selectBurnIn', () => {
  it('groups burnable files by runner, in runner order, dropping the rest', () => {
    const plan = selectBurnIn(
      ['src/b.spec.ts', 'README.md', 'e2e/a.spec.ts', 'src/c.svelte.spec.ts', 'src/d.spec.ts'],
      config()
    );
    expect(plan.groups.map((g) => [g.runner.name, g.files])).toEqual([
      ['e2e', ['e2e/a.spec.ts']],
      ['client', ['src/c.svelte.spec.ts']],
      ['server', ['src/b.spec.ts', 'src/d.spec.ts']]
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('keeps the first maxFiles burnable files and lists the overflow', () => {
    const plan = selectBurnIn(
      ['src/1.spec.ts', 'docs/x.md', 'src/2.spec.ts', 'e2e/3.spec.ts', 'src/4.spec.ts'],
      config({ maxFiles: 2 })
    );
    expect(plan.groups.flatMap((g) => g.files)).toEqual(['src/1.spec.ts', 'src/2.spec.ts']);
    expect(plan.skipped).toEqual(['e2e/3.spec.ts', 'src/4.spec.ts']);
  });
});

describe('burnInCommands', () => {
  it('runs a string once and each element of an array, with the repeats', () => {
    const plan = selectBurnIn(['e2e/a.spec.ts', 'src/b.spec.ts'], config());
    expect(burnInCommands(plan, 2)).toEqual([
      {
        runner: 'e2e',
        files: ['e2e/a.spec.ts'],
        command: 'playwright test --repeat-each=2 --retries=0 e2e/a.spec.ts'
      },
      {
        runner: 'server',
        files: ['src/b.spec.ts'],
        command: 'vitest --project server src/b.spec.ts'
      },
      {
        runner: 'server',
        files: ['src/b.spec.ts'],
        command: 'vitest --project server src/b.spec.ts'
      }
    ]);
  });

  it.each([
    ['an empty string', ''],
    ['an empty array', []],
    ['an array with a blank entry', ['ok', ' ']]
  ])('rejects %s', (_name, produced) => {
    const bad: BurnInRunner = { name: 'bad', match: '**', command: () => produced };
    const plan = selectBurnIn(['x.spec.ts'], config({ runners: [bad] }));
    expect(() => burnInCommands(plan, 1)).toThrow(BurnInError);
    expect(() => burnInCommands(plan, 1)).toThrow('runner "bad"');
  });
});
