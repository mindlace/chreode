import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'src/cli.ts');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

const CONFIG = `const step = (label) =>
  'echo ' + label + ' >> "$RAN_LOG" && echo "' + label + ' $CHREODE_HEAD $CHREODE_FLAKE_LOG" >> "$ENV_LOG"' +
  ' && { test "$FLAKE_STEP" != ' + label + ' || flake; }' +
  ' && test "$FAIL_STEP" != ' + label + ' && test "$CHREODE_SIGNOFF" = 1';
export default {
  afterMerge: 'echo "afterMerge head=\${CHREODE_HEAD:-unset} log=\${CHREODE_FLAKE_LOG:-unset}" >> "$ENV_LOG"',
  rules: [
    { match: ['docs/**', '**/*.md'], triggers: ['format'] },
    { match: 'src/**', triggers: ['lint', 'unit'] }
  ],
  steps: [
    { label: 'format', run: step('format'), when: ['format'], supersededBy: ['lint'] },
    { label: 'lint', run: step('lint'), when: ['lint'] },
    { label: 'unit', run: step('unit'), when: ['unit'], policeStderr: true }
  ],
  flakes: {},
  burnIn: {
    repeats: 2,
    runners: [
      {
        name: 'unit',
        match: 'src/**/*.spec.ts',
        command: (files, n) =>
          Array.from(
            { length: n },
            () => 'echo burn ' + files.join(',') + ' >> "$RAN_LOG" && test "$FAIL_BURN" != 1'
          )
      }
    ]
  }
};
`;

const GH_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = issue ] && [ "$GH_FAIL_ISSUES" = 1 ]; then exit 1; fi
case "$1" in
  auth) exit 0 ;;
  repo) echo '{"owner":{"login":"acme"},"name":"widget"}' ;;
  pr) exit 1 ;;
  api) echo '{}' ;;
  label) if [ "$2" = list ]; then echo '[]'; fi ;;
  issue)
    case "$2" in
      list) if [ -n "$GH_ISSUES" ]; then cat "$GH_ISSUES"; else echo '[]'; fi ;;
      view) if [ -n "$GH_COMMENTS" ]; then cat "$GH_COMMENTS"; else echo '{"comments":[]}'; fi ;;
      create) echo 'https://github.com/acme/widget/issues/7' ;;
      comment) echo 'https://github.com/acme/widget/issues/7#issuecomment-1' ;;
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
`;

/** What a test runner's flake reporter would append for one retried-then-passed test. */
const FLAKE_SCRIPT = `#!/bin/sh
mkdir -p "$(dirname "$CHREODE_FLAKE_LOG")"
printf '{"kind":"unit","runner":"vitest","project":"","file":"src/flaky.spec.ts","title":"flaky test","firstAttemptError":"boom","sha":"%s","at":"2026-10-11T00:00:00.000Z"}\\n' "$CHREODE_HEAD" >> "$CHREODE_FLAKE_LOG"
`;

interface Sandbox {
  dir: string;
  work: string;
  ranLog: string;
  ghLog: string;
  envLog: string;
  env: NodeJS.ProcessEnv;
}

/** The parent's env minus anything that would change chreode's or git's behavior. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CHREODE_') && !key.startsWith('GIT_')) env[key] = value;
  }
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function initRepo(path: string): void {
  git(path, 'config', 'user.email', 'signer@example.com');
  git(path, 'config', 'user.name', 'Signer');
  git(path, 'config', 'commit.gpgsign', 'false');
}

function write(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function commit(cwd: string, file: string, content: string, message: string): string {
  write(cwd, file, content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function setup(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'chreode-it-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const bin = join(dir, 'bin');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: cleanEnv() });
  mkdirSync(work);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work, env: cleanEnv() });
  initRepo(work);
  git(work, 'remote', 'add', 'origin', origin);
  write(work, 'chreode.config.ts', CONFIG);
  write(work, 'src/a.ts', 'export const a = 1;\n');
  write(work, 'docs/guide.md', '# Guide\n');
  write(work, '.gitignore', '.chreode/\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), GH_SHIM);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(bin, 'flake'), FLAKE_SCRIPT);
  chmodSync(join(bin, 'flake'), 0o755);
  const ranLog = join(dir, 'ran.log');
  const ghLog = join(dir, 'gh.log');
  const envLog = join(dir, 'env.log');
  return {
    dir,
    work,
    ranLog,
    ghLog,
    envLog,
    env: {
      ...cleanEnv(),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RAN_LOG: ranLog,
      GH_LOG: ghLog,
      ENV_LOG: envLog,
      CHREODE_LOCK_PATH: join(dir, 'signoff.lock')
    }
  };
}

function cli(sb: Sandbox, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(TSX, [CLI, ...args], {
    cwd: sb.work,
    env: { ...sb.env, ...extraEnv },
    encoding: 'utf8'
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function signoff(sb: Sandbox, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
  return cli(sb, ['signoff', ...args], extraEnv);
}

const readLines = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const ran = (sb: Sandbox) => readLines(sb.ranLog);
const clearRan = (sb: Sandbox) => writeFileSync(sb.ranLog, '');
const statusPosts = (sb: Sandbox) =>
  readLines(sb.ghLog).filter((l) => l.startsWith('api -X POST repos/acme/widget/statuses/'));
const remoteFeature = (sb: Sandbox) => git(sb.work, 'ls-remote', 'origin', 'refs/heads/feature');
const ghLines = (sb: Sandbox) => readLines(sb.ghLog);
const flakeLog = (sb: Sandbox) => join(realpathSync(sb.work), '.chreode', 'flakes.jsonl');
const FLAKE_TITLE = 'flake(unit): src/flaky.spec.ts › flaky test';

function note(sb: Sandbox, sha: string): string | null {
  try {
    return git(sb.work, 'notes', '--ref=chreode', 'show', sha);
  } catch {
    return null;
  }
}

describe('chreode signoff, end to end', { timeout: 60_000 }, () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = setup();
  });
  afterEach(() => {
    rmSync(sb.dir, { recursive: true, force: true });
  });

  it('first signoff: an unmatched path runs everything, then pushes, posts and notes', () => {
    const head = commit(sb.work, 'Makefile', 'all:\n', 'build: add a Makefile');
    const r = signoff(sb);
    expect(r.status, r.out).toBe(0);
    expect(ran(sb)).toEqual(['lint', 'unit']);
    expect(statusPosts(sb)).toEqual([
      `api -X POST repos/acme/widget/statuses/${head} -f state=success -f context=chreode/signoff -f description=signed off by signer@example.com`
    ]);
    expect(note(sb, head)).toBe('lint unit');
    expect(remoteFeature(sb)).toContain(head);
  });

  it('a docs-only commit after a signoff runs only the docs step', () => {
    commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    expect(signoff(sb).status).toBe(0);
    clearRan(sb);
    const head = commit(sb.work, 'docs/guide.md', '# Guide\n\nMore.\n', 'docs: more');
    const r = signoff(sb);
    expect(r.status, r.out).toBe(0);
    expect(ran(sb)).toEqual(['format']);
    expect(note(sb, head)).toBe('format');
  });

  it('a --skip run is not a base: the next signoff re-plans the skipped step', () => {
    const skipped = commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    const partial = signoff(sb, ['--skip', 'unit']);
    expect(partial.status, partial.out).toBe(0);
    expect(ran(sb)).toEqual(['lint']);
    expect(statusPosts(sb).at(-1)).toContain('(skipped: unit)');
    expect(note(sb, skipped)).toBeNull();
    clearRan(sb);
    const head = commit(sb.work, 'docs/guide.md', '# Guide\n\nMore.\n', 'docs: more');
    const r = signoff(sb);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain(`base=${skipped}`);
    expect(ran(sb)).toEqual(['lint', 'unit']);
    expect(note(sb, head)).toBe('lint unit');
  });

  it('a failing step exits 1, posts nothing, notes nothing, pushes nothing', () => {
    const head = commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    const r = signoff(sb, [], { FAIL_STEP: 'lint' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('FAILED at: lint');
    expect(ran(sb)).toEqual(['lint']);
    expect(statusPosts(sb)).toEqual([]);
    expect(note(sb, head)).toBeNull();
    expect(remoteFeature(sb)).toBe('');
  });

  it('--no-push posts the status without pushing', () => {
    commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    const r = signoff(sb, ['--no-push']);
    expect(r.status, r.out).toBe(0);
    expect(remoteFeature(sb)).toBe('');
    expect(statusPosts(sb)).toHaveLength(1);
  });

  it('a merge conflict exits 1, runs nothing, and leaves the merge in progress', () => {
    const other = join(sb.dir, 'other');
    execFileSync('git', ['clone', '-q', join(sb.dir, 'origin.git'), other], { env: cleanEnv() });
    initRepo(other);
    commit(other, 'src/a.ts', 'export const a = "main";\n', 'feat: main a');
    git(other, 'push', '-q', 'origin', 'main');
    commit(sb.work, 'src/a.ts', 'export const a = "branch";\n', 'feat: branch a');
    const r = signoff(sb);
    expect(r.status).toBe(1);
    expect(r.out).toContain('conflict');
    expect(existsSync(join(sb.work, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(ran(sb)).toEqual([]);
  });

  it('re-running with nothing new is a no-op; CHREODE_FULL=1 runs everything again', () => {
    commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    expect(signoff(sb).status).toBe(0);
    clearRan(sb);
    const posted = statusPosts(sb).length;
    const again = signoff(sb);
    expect(again.status).toBe(0);
    expect(again.out).toContain('already signed off');
    expect(ran(sb)).toEqual([]);
    expect(statusPosts(sb)).toHaveLength(posted);
    const full = signoff(sb, [], { CHREODE_FULL: '1' });
    expect(full.status, full.out).toBe(0);
    expect(ran(sb)).toEqual(['lint', 'unit']);
  });
});

describe('flake ledger, end to end', { timeout: 60_000 }, () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = setup();
  });
  afterEach(() => {
    rmSync(sb.dir, { recursive: true, force: true });
  });

  it('a step that records a flake files an issue, clears the log, and signs off', () => {
    const head = commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    const r = signoff(sb, [], { FLAKE_STEP: 'lint' });
    expect(r.status, r.out).toBe(0);
    expect(
      ghLines(sb).some((l) => l.startsWith(`issue create --title ${FLAKE_TITLE} --body`))
    ).toBe(true);
    expect(ghLines(sb).some((l) => l.startsWith('label create flake'))).toBe(true);
    // The event carries the CHREODE_HEAD the step saw.
    expect(readFileSync(sb.ghLog, 'utf8')).toContain(`@ ${head}`);
    expect(existsSync(flakeLog(sb))).toBe(false);
    expect(statusPosts(sb)).toHaveLength(1);
    expect(r.out).toContain('https://github.com/acme/widget/issues/7');
  });

  it('steps see CHREODE_HEAD and CHREODE_FLAKE_LOG; afterMerge does not', () => {
    const other = join(sb.dir, 'other');
    execFileSync('git', ['clone', '-q', join(sb.dir, 'origin.git'), other], { env: cleanEnv() });
    initRepo(other);
    commit(other, 'README.txt', 'hi\n', 'chore: readme');
    git(other, 'push', '-q', 'origin', 'main');
    commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    const r = signoff(sb);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('afterMerge');
    const head = git(sb.work, 'rev-parse', 'HEAD');
    const lines = readLines(sb.envLog);
    expect(lines).toContain('afterMerge head=unset log=unset');
    expect(lines).toContain(`lint ${head} ${flakeLog(sb)}`);
    expect(lines).toContain(`unit ${head} ${flakeLog(sb)}`);
  });

  it('a failing step still reports its flake, and posts nothing', () => {
    commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    const r = signoff(sb, [], { FLAKE_STEP: 'lint', FAIL_STEP: 'lint' });
    expect(r.status).toBe(1);
    expect(ghLines(sb).some((l) => l.startsWith('issue create'))).toBe(true);
    expect(statusPosts(sb)).toEqual([]);
  });

  it('the third occurrence fails the run, names the issue, and pushes nothing', () => {
    const issues = join(sb.dir, 'issues.json');
    writeFileSync(
      issues,
      JSON.stringify([
        {
          number: 7,
          title: FLAKE_TITLE,
          url: 'https://github.com/acme/widget/issues/7',
          labels: [{ name: 'flake' }]
        }
      ])
    );
    const comments = join(sb.dir, 'comments.json');
    writeFileSync(
      comments,
      JSON.stringify({ comments: [{ body: '<!-- chreode:flake-occurrence -->\n\nFlaked again.' }] })
    );
    commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    const r = signoff(sb, [], { FLAKE_STEP: 'lint', GH_ISSUES: issues, GH_COMMENTS: comments });
    expect(r.status).toBe(1);
    expect(r.out).toContain('https://github.com/acme/widget/issues/7');
    expect(r.out).toContain('flake-snoozed');
    expect(
      ghLines(sb).some((l) =>
        l.startsWith('issue comment 7 --body <!-- chreode:flake-occurrence -->')
      )
    ).toBe(true);
    expect(statusPosts(sb)).toEqual([]);
    expect(remoteFeature(sb)).toBe('');
  });

  it('a GitHub failure keeps the log and still signs off', () => {
    commit(sb.work, 'src/b.ts', 'export const b = 2;\n', 'feat: b');
    const r = signoff(sb, [], { FLAKE_STEP: 'lint', GH_FAIL_ISSUES: '1' });
    expect(r.status, r.out).toBe(0);
    expect(readLines(flakeLog(sb))).toHaveLength(1);
    expect(statusPosts(sb)).toHaveLength(1);
  });

  it('refuses to run when .chreode/ is not gitignored', () => {
    commit(sb.work, '.gitignore', '', 'chore: drop the ignore');
    const r = signoff(sb);
    expect(r.status).toBe(1);
    expect(r.out).toContain('add the line `.chreode/` to .gitignore');
    expect(ran(sb)).toEqual([]);
  });
});

describe('chreode burn-in, end to end', { timeout: 60_000 }, () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = setup();
  });
  afterEach(() => {
    rmSync(sb.dir, { recursive: true, force: true });
  });

  it('burns in added and renamed test files, never deleted ones', () => {
    commit(sb.work, 'src/old.spec.ts', 'old\n', 'test: old');
    const base = commit(sb.work, 'src/gone.spec.ts', 'gone\n', 'test: gone');
    git(sb.work, 'mv', 'src/old.spec.ts', 'src/renamed.spec.ts');
    git(sb.work, 'rm', '-q', 'src/gone.spec.ts');
    write(sb.work, 'src/added.spec.ts', 'added\n');
    write(sb.work, 'src/plain.ts', 'export const p = 1;\n');
    git(sb.work, 'add', '-A');
    git(sb.work, 'commit', '-q', '-m', 'test: churn');
    const head = git(sb.work, 'rev-parse', 'HEAD');
    const r = cli(sb, ['burn-in', '--base', base, '--head', head]);
    expect(r.status, r.out).toBe(0);
    const runs = ran(sb);
    expect(runs).toHaveLength(2);
    for (const line of runs) {
      expect(line.replace('burn ', '').split(',').sort()).toEqual([
        'src/added.spec.ts',
        'src/renamed.spec.ts'
      ]);
    }
  });

  it('a failing burn-in exits 1 and names the files', () => {
    const base = git(sb.work, 'rev-parse', 'HEAD');
    const head = commit(sb.work, 'src/x.spec.ts', 'x\n', 'test: x');
    const r = cli(sb, ['burn-in', '--base', base, '--head', head], { FAIL_BURN: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('burn-in FAILED (unit): src/x.spec.ts');
    expect(ran(sb)).toHaveLength(1);
  });
});
