import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeExec } from '../../test/support/fake-exec.js';
import { resolveFlakes, resolveTiming, type ResolvedConfig } from '../config/types.js';
import { runTimingCheck, timingDiffArgs } from './run.js';

type TimingConfig = Pick<ResolvedConfig, 'baseBranch' | 'timing' | 'flakes'>;
const config = (flakes: TimingConfig['flakes'] = null): TimingConfig => ({
  baseBranch: 'main',
  timing: resolveTiming(),
  flakes
});

const addedDiff = (path: string, line: number, text: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line},0 +${line} @@\n+${text}\n`;

function runFake(diff: string, cfg: TimingConfig) {
  const { exec } = fakeExec({ ['git ' + timingDiffArgs('main', 'h').join(' ')]: diff });
  const logs: string[] = [];
  const code = runTimingCheck(cfg, 'h', { exec, log: (m) => logs.push(m) });
  return { code, logs };
}

describe('timingDiffArgs', () => {
  it('pins every diff option against user config', () => {
    expect(timingDiffArgs('main', 'h')).toEqual([
      '-c',
      'core.quotePath=false',
      'diff',
      '--unified=0',
      '--no-renames',
      '--diff-filter=AM',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-relative',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      'origin/main...h'
    ]);
  });
});

describe('runTimingCheck', () => {
  it('exits 1 and prints each violation', () => {
    const { code, logs } = runFake(
      addedDiff('e2e/editor.spec.ts', 42, 'await page.waitForTimeout(500);'),
      config()
    );
    expect(code).toBe(1);
    expect(logs).toContain('[chreode] timing: 1 violation in 1 file');
    expect(
      logs.some((l) =>
        /e2e\/editor\.spec\.ts:42 +fixed-wait +await page\.waitForTimeout\(500\);/.test(l)
      )
    ).toBe(true);
    expect(
      logs.some((l) =>
        l.includes('Fix: https://github.com/mindlace/chreode/blob/main/docs/flakes.md#the-playbook')
      )
    ).toBe(true);
  });

  it('links the configured playbook', () => {
    const { logs } = runFake(
      addedDiff('e2e/editor.spec.ts', 1, 'await page.waitForTimeout(500);'),
      config(resolveFlakes({ playbookUrl: 'https://wiki/flakes' }))
    );
    expect(logs.some((l) => l.includes('Fix: https://wiki/flakes#the-playbook'))).toBe(true);
  });

  it('exits 0 on a clean diff', () => {
    const { code, logs } = runFake(
      addedDiff('e2e/editor.spec.ts', 3, "await expect(page.getByText('saved')).toBeVisible();"),
      config()
    );
    expect(code).toBe(0);
    expect(logs).toEqual(['[chreode] timing: no timing crutches added in 1 checked file(s)']);
  });
});

describe('against a real repository', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'chreode-timing-'));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
    );
    const run = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    mkdirSync(origin);
    run(origin, 'init', '-q', '--bare', '-b', 'main');
    run(root, 'clone', '-q', origin, work);
    for (const [k, v] of [
      ['user.email', 't@example.com'],
      ['user.name', 't'],
      ['commit.gpgsign', 'false']
    ]) {
      run(work, 'config', k, v);
    }
    const git = (...args: string[]) => run(work, ...args);
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    };
    const commit = (msg: string) => {
      git('add', '-A');
      git('commit', '-q', '-m', msg);
    };
    const exec = (file: string, args: readonly string[]) =>
      execFileSync(file, [...args], {
        cwd: work,
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    const check = () => {
      const logs: string[] = [];
      const code = runTimingCheck(config(), 'HEAD', { exec, log: (m) => logs.push(m) });
      return { code, text: logs.join('\n') };
    };
    return { root, git, write, commit, check };
  }

  const wait = 'await page.waitForTimeout(100);\n';

  function withBranch(body: (t: ReturnType<typeof setup>) => void) {
    const t = setup();
    try {
      t.write('README.md', 'x\n');
      t.write('e2e/legacy.spec.ts', wait);
      t.write('e2e/other.spec.ts', wait);
      t.commit('init');
      t.git('push', '-q', 'origin', 'main');
      t.git('checkout', '-q', '-b', 'feature');
      body(t);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  }

  it("checks only the branch's own changes", () => {
    const t = setup();
    try {
      t.write('README.md', 'x\n');
      t.commit('init');
      t.git('push', '-q', 'origin', 'main');
      t.write('e2e/legacy.spec.ts', wait);
      t.commit('legacy');
      t.git('push', '-q', 'origin', 'main');
      t.git('checkout', '-q', '-b', 'feature');
      t.write('e2e/new.spec.ts', "test.skip('later', () => {});\n");
      t.commit('feature');
      t.git('checkout', '-q', 'main');
      t.write('e2e/later.spec.ts', wait);
      t.commit('later');
      t.git('push', '-q', 'origin', 'main');
      t.git('checkout', '-q', 'feature');
      t.git('merge', '-q', '--no-edit', 'main');
      const { code, text } = t.check();
      expect(code).toBe(1);
      expect(text).toMatch(/e2e\/new\.spec\.ts:1 +skip/);
      expect(text).not.toContain('legacy.spec.ts');
      expect(text).not.toContain('later.spec.ts');
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  it('reads a renamed file as added and ignores a deleted one', () => {
    withBranch((t) => {
      t.git('mv', 'e2e/legacy.spec.ts', 'e2e/moved.spec.ts');
      t.git('rm', '-q', 'e2e/other.spec.ts');
      t.commit('move');
      const { code, text } = t.check();
      expect(code).toBe(1);
      expect(text).toMatch(/e2e\/moved\.spec\.ts:1 +fixed-wait/);
      expect(text).not.toContain('other.spec.ts');
    });
  });

  it("honours a user's diff.noprefix and color config", () => {
    withBranch((t) => {
      t.git('config', 'diff.noprefix', 'true');
      t.git('config', 'color.diff', 'always');
      t.write('e2e/new.spec.ts', wait);
      t.commit('add');
      const { code, text } = t.check();
      expect(code).toBe(1);
      expect(text).toMatch(/e2e\/new\.spec\.ts:1 +fixed-wait/);
    });
  });
});
