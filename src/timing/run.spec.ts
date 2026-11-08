import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeExec } from '../../test/support/fake-exec.js';
import { resolveFlakes, resolveTiming, type ResolvedConfig } from '../config/types.js';
import { runTimingCheck, timingDiffArgs, timingNamesArgs } from './run.js';

type TimingConfig = Pick<ResolvedConfig, 'baseBranch' | 'timing' | 'flakes'>;
const config = (flakes: TimingConfig['flakes'] = null): TimingConfig => ({
  baseBranch: 'main',
  timing: resolveTiming(),
  flakes
});

const addedDiff = (path: string, line: number, text: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line},0 +${line} @@\n+${text}\n`;

const namesKey = 'git ' + timingNamesArgs('main', 'h').join(' ');
const diffKey = (paths: string[]) => 'git ' + timingDiffArgs('main', 'h', paths).join(' ');

/** Fakes both git calls: the name-only listing (`names`) and the diff of `checked`. */
function runFake(diff: string, cfg: TimingConfig, names: string[], checked = names) {
  const { exec, calls } = fakeExec({
    [namesKey]: names.map((n) => n + '\0').join(''),
    [diffKey(checked)]: diff
  });
  const logs: string[] = [];
  const code = runTimingCheck(cfg, 'h', { exec, log: (m) => logs.push(m) });
  return { code, logs, calls };
}

describe('timingNamesArgs', () => {
  it('lists added or modified paths, NUL-separated, without --text', () => {
    expect(timingNamesArgs('main', 'h')).toEqual([
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--diff-filter=AM',
      '--no-relative',
      'origin/main...h'
    ]);
  });
});

describe('timingDiffArgs', () => {
  it('pins every diff option against user config and takes paths literally', () => {
    expect(timingDiffArgs('main', 'h', ['e2e/a.spec.ts', 'e2e/[x].spec.ts'])).toEqual([
      '--literal-pathspecs',
      '-c',
      'core.quotePath=false',
      'diff',
      '--unified=0',
      '--inter-hunk-context=0',
      '--text',
      '--diff-algorithm=myers',
      '--indent-heuristic',
      '-O/dev/null',
      '--no-renames',
      '--diff-filter=AM',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-relative',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      'origin/main...h',
      '--',
      'e2e/a.spec.ts',
      'e2e/[x].spec.ts'
    ]);
  });
});

describe('runTimingCheck', () => {
  it('exits 1 and prints each violation', () => {
    const { code, logs } = runFake(
      addedDiff('e2e/editor.spec.ts', 42, 'await page.waitForTimeout(500);'),
      config(),
      ['e2e/editor.spec.ts']
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
      config(resolveFlakes({ playbookUrl: 'https://wiki/flakes' })),
      ['e2e/editor.spec.ts']
    );
    expect(logs.some((l) => l.includes('Fix: https://wiki/flakes#the-playbook'))).toBe(true);
  });

  it('exits 0 on a clean diff', () => {
    const { code, logs } = runFake(
      addedDiff('e2e/editor.spec.ts', 3, "await expect(page.getByText('saved')).toBeVisible();"),
      config(),
      ['e2e/editor.spec.ts']
    );
    expect(code).toBe(0);
    expect(logs).toEqual(['[chreode] timing: no timing crutches added in 1 checked file(s)']);
  });

  it('diffs only checked paths, never other changed files', () => {
    const { code, calls } = runFake(
      addedDiff('e2e/a.spec.ts', 1, 'await page.waitForTimeout(500);'),
      config(),
      ['assets/big.wasm', 'e2e/a.spec.ts', 'e2e/load.perf.ts', 'src/app.ts'],
      ['e2e/a.spec.ts']
    );
    expect(code).toBe(1);
    expect(calls).toEqual([namesKey, diffKey(['e2e/a.spec.ts'])]);
    expect(calls[1]).not.toMatch(/big\.wasm|load\.perf|app\.ts/);
  });

  it('skips the diff when no changed file is checked', () => {
    const { exec, calls } = fakeExec({ [namesKey]: 'assets/big.wasm\0src/app.ts\0' });
    const logs: string[] = [];
    const code = runTimingCheck(config(), 'h', { exec, log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(calls).toEqual([namesKey]);
    expect(logs).toEqual(['[chreode] timing: no test files changed; nothing to check']);
  });
});

describe('against a real repository', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'chreode-timing-'));
    // Hermetic: no GIT_* from the caller, and no global or system gitconfig.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    };
    const run = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    mkdirSync(origin);
    run(origin, 'init', '-q', '--bare', '-b', 'main');
    run(root, '-c', 'init.defaultBranch=main', 'clone', '-q', origin, work);
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
    const check = () => {
      const logs: string[] = [];
      const calls: string[][] = [];
      const exec = (file: string, args: readonly string[]) => {
        calls.push([...args]);
        return execFileSync(file, [...args], {
          cwd: work,
          encoding: 'utf8',
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      };
      const code = runTimingCheck(config(), 'HEAD', { exec, log: (m) => logs.push(m) });
      return { code, text: logs.join('\n'), calls };
    };
    return { root, work, git, write, commit, check };
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

  const body = (...l: string[]) => l.join('\n') + '\n';
  const legacy = body(
    "test('a', async ({ page }) => {",
    "  await page.goto('/');",
    "  await page.click('#one');",
    "  await page.click('#two');",
    '});'
  );
  const edited = body(
    "test('a', async ({ page }) => {",
    "  await page.goto('/home');",
    "  await page.click('#one');",
    '  await page.waitForTimeout(500);',
    "  await page.click('#two');",
    '});'
  );

  it("flags a wait despite the user's interHunkContext, diff algorithm and -diff attribute", () => {
    withBranch((t) => {
      t.write('e2e/flow.spec.ts', legacy);
      t.commit('flow');
      t.git('push', '-q', 'origin', 'feature:main');
      t.git('fetch', '-q', 'origin');
      t.git('config', 'diff.interHunkContext', '1000');
      t.git('config', 'diff.algorithm', 'patience');
      t.git('config', 'diff.indentHeuristic', 'false');
      t.git('config', 'diff.orderFile', 'README.md');
      mkdirSync(join(t.work, '.git', 'info'), { recursive: true });
      writeFileSync(join(t.work, '.git', 'info', 'attributes'), '*.spec.ts -diff\n');
      t.write('e2e/flow.spec.ts', edited);
      t.commit('edit two nearby places');
      const { code, text } = t.check();
      expect(code).toBe(1);
      expect(text).toMatch(/e2e\/flow\.spec\.ts:4 +fixed-wait/);
    });
  });

  it('diffs only checked paths: a binary outside them is never read as text', () => {
    withBranch((t) => {
      mkdirSync(join(t.work, 'assets'), { recursive: true });
      writeFileSync(join(t.work, 'assets', 'big.bin'), Buffer.from([0, 1, 2, 255, 10, 0, 254]));
      t.write('e2e/[x].spec.ts', wait);
      t.write('e2e/x.spec.ts', "await expect(page.getByText('ok')).toBeVisible();\n");
      t.commit('add');
      const { code, text, calls } = t.check();
      expect(code).toBe(1);
      expect(text).toMatch(/e2e\/\[x\]\.spec\.ts:1 +fixed-wait/);
      expect(calls).toHaveLength(2);
      expect(calls[1]).not.toContain('assets/big.bin');
      expect(calls[1].slice(calls[1].indexOf('--') + 1)).toEqual([
        'e2e/[x].spec.ts',
        'e2e/x.spec.ts'
      ]);
    });
  });

  it('makes one git call when the branch changes no checked file', () => {
    withBranch((t) => {
      t.write('src/app.ts', 'export {};\n');
      t.commit('app');
      const { code, text, calls } = t.check();
      expect(code).toBe(0);
      expect(text).toBe('[chreode] timing: no test files changed; nothing to check');
      expect(calls).toHaveLength(1);
    });
  });

  it('flags a wait in a file a committed .gitattributes marks binary', () => {
    withBranch((t) => {
      t.write('.gitattributes', 'e2e/** binary\n');
      t.write('e2e/new.spec.ts', wait);
      t.commit('add');
      const { code, text } = t.check();
      expect(code).toBe(1);
      expect(text).toMatch(/e2e\/new\.spec\.ts:1 +fixed-wait/);
    });
  });
});
