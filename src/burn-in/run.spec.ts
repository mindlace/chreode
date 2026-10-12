import { describe, expect, it } from 'vitest';
import { fakeExec } from '../../test/support/fake-exec.js';
import type { ResolvedBurnIn } from '../config/types.js';
import { runBurnIn } from './run.js';

const DIFF = 'git diff --name-only --no-renames --diff-filter=d -z b..h';

const CONFIG: ResolvedBurnIn = {
  repeats: 2,
  maxFiles: 12,
  runners: [
    {
      name: 'unit',
      match: 'src/**/*.spec.ts',
      command: (files, n) => Array.from({ length: n }, (_, i) => `vitest#${i} ${files.join(' ')}`)
    }
  ]
};

function harness(diff: string, failOn?: string) {
  const out: string[] = [];
  const ran: string[] = [];
  const deps = {
    exec: fakeExec({ [DIFF]: diff }).exec,
    run: (command: string) => {
      ran.push(command);
      if (command === failOn) throw new Error('exit 1');
    },
    mtime: () => 1,
    log: (m: string) => void out.push(m)
  };
  return { deps, out, ran };
}

const range = { base: 'b', head: 'h' };

describe('runBurnIn', () => {
  it('runs every command for the changed test files, in order', () => {
    const h = harness('src/a.spec.ts\0src/a.ts\0');
    expect(runBurnIn(CONFIG, range, h.deps)).toBe(0);
    expect(h.ran).toEqual(['vitest#0 src/a.spec.ts', 'vitest#1 src/a.spec.ts']);
    expect(h.out.join('\n')).toContain('every changed test file survived');
  });

  it('has nothing to do when no changed file is a test', () => {
    const h = harness('src/a.ts\0');
    expect(runBurnIn(CONFIG, range, h.deps)).toBe(0);
    expect(h.ran).toEqual([]);
    expect(h.out.join('\n')).toContain('nothing to burn in');
  });

  it('stops at the first failure, naming the files and the command', () => {
    const h = harness('src/a.spec.ts\0', 'vitest#0 src/a.spec.ts');
    expect(runBurnIn(CONFIG, range, h.deps)).toBe(1);
    expect(h.ran).toEqual(['vitest#0 src/a.spec.ts']);
    const out = h.out.join('\n');
    expect(out).toContain('burn-in FAILED (unit): src/a.spec.ts');
    expect(out).toContain('command: vitest#0 src/a.spec.ts');
  });

  it('lists files over the cap as not burned in', () => {
    const h = harness('src/a.spec.ts\0src/b.spec.ts\0');
    expect(runBurnIn({ ...CONFIG, maxFiles: 1 }, range, h.deps)).toBe(0);
    const out = h.out.join('\n');
    expect(out).toContain('NOT burned in');
    expect(out).toContain('  src/b.spec.ts');
    expect(h.ran).toEqual(['vitest#0 src/a.spec.ts', 'vitest#1 src/a.spec.ts']);
  });

  it('exits 1 without a burnIn config', () => {
    const h = harness('');
    expect(runBurnIn(null, range, h.deps)).toBe(1);
    expect(h.out.join('\n')).toContain('no burnIn block');
  });

  it('exits 1 when a runner builds an empty command', () => {
    const h = harness('src/a.spec.ts\0');
    const bad = { ...CONFIG, runners: [{ ...CONFIG.runners[0]!, command: () => '' }] };
    expect(runBurnIn(bad, range, h.deps)).toBe(1);
    expect(h.ran).toEqual([]);
  });
});
