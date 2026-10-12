import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeExec } from '../../test/support/fake-exec.js';
import { committedPaths, isWorktree, resolveBase, writeNote } from './change-set.js';

const noNote = new Error('no note');

describe('resolveBase', () => {
  it('uses the nearest branch commit carrying a chreode note', () => {
    const { exec } = fakeExec({
      'git rev-parse HEAD': 'c3\n',
      'git rev-list --topo-order HEAD ^origin/main': 'c3\nc2\nc1\n',
      'git notes --ref=chreode show c3': noNote,
      'git notes --ref=chreode show c2': 'lint unit\n',
      'git notes --ref=chreode show c1': 'lint\n'
    });
    expect(resolveBase('main', exec)).toEqual({ base: 'c2', head: 'c3', source: 'note' });
  });

  it('falls back to the merge-base with origin/<baseBranch>', () => {
    const { exec } = fakeExec({
      'git rev-parse HEAD': 'c2\n',
      'git rev-list --topo-order HEAD ^origin/trunk': 'c2\nc1\n',
      'git notes --ref=chreode show c2': noNote,
      'git notes --ref=chreode show c1': noNote,
      'git merge-base HEAD origin/trunk': 'm0\n'
    });
    expect(resolveBase('trunk', exec)).toEqual({ base: 'm0', head: 'c2', source: 'merge-base' });
  });
});

describe('committedPaths', () => {
  it('is empty when base is head, without asking git', () => {
    const { exec, calls } = fakeExec({});
    expect(committedPaths('h', 'h', exec)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('lists both sides of a rename so moving a file out of a rule still fires it', () => {
    const { exec } = fakeExec({
      'git diff --name-only --no-renames b..h': 'scratch/x.ts\nsrc/x.ts\n'
    });
    expect(committedPaths('b', 'h', exec)).toEqual(['scratch/x.ts', 'src/x.ts']);
  });

  it('counts both sides of a real rename and a deletion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chreode-cs-'));
    try {
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-C',
            dir,
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@example.com',
            '-c',
            'commit.gpgsign=false',
            ...args
          ],
          { encoding: 'utf8' }
        );
      git('init', '-q');
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src/x.ts'), 'export const x = 1;\nexport const y = 2;\n');
      writeFileSync(join(dir, 'gone.txt'), 'bye\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'one');
      const base = git('rev-parse', 'HEAD').trim();
      mkdirSync(join(dir, 'scratch'));
      renameSync(join(dir, 'src/x.ts'), join(dir, 'scratch/x.ts'));
      rmSync(join(dir, 'gone.txt'));
      git('add', '-A');
      git('commit', '-q', '-m', 'two');
      const head = git('rev-parse', 'HEAD').trim();
      const exec = (file: string, args: readonly string[]) =>
        execFileSync(file, [...args], { encoding: 'utf8', cwd: dir });
      expect(committedPaths(base, head, exec).sort()).toEqual([
        'gone.txt',
        'scratch/x.ts',
        'src/x.ts'
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isWorktree', () => {
  it('is true when the git dir differs from the common dir', () => {
    const { exec } = fakeExec({
      'git rev-parse --path-format=absolute --git-dir --git-common-dir':
        '/r/.git/worktrees/x\n/r/.git\n'
    });
    expect(isWorktree(exec)).toBe(true);
  });

  it('is false in the main checkout', () => {
    const { exec } = fakeExec({
      'git rev-parse --path-format=absolute --git-dir --git-common-dir': '/r/.git\n/r/.git\n'
    });
    expect(isWorktree(exec)).toBe(false);
  });
});

describe('writeNote', () => {
  it('records the labels that ran, or no-op', () => {
    const { exec, calls } = fakeExec({
      'git notes --ref=chreode add -f -m lint unit h': '',
      'git notes --ref=chreode add -f -m no-op h': ''
    });
    writeNote('h', ['lint', 'unit'], exec);
    writeNote('h', [], exec);
    expect(calls).toEqual([
      'git notes --ref=chreode add -f -m lint unit h',
      'git notes --ref=chreode add -f -m no-op h'
    ]);
  });
});
