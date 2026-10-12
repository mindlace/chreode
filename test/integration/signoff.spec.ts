import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  'echo ' + label + ' >> "$RAN_LOG" && test "$FAIL_STEP" != ' + label + ' && test "$CHREODE_SIGNOFF" = 1';
export default {
  rules: [
    { match: ['docs/**', '**/*.md'], triggers: ['format'] },
    { match: 'src/**', triggers: ['lint', 'unit'] }
  ],
  steps: [
    { label: 'format', run: step('format'), when: ['format'], supersededBy: ['lint'] },
    { label: 'lint', run: step('lint'), when: ['lint'] },
    { label: 'unit', run: step('unit'), when: ['unit'], policeStderr: true }
  ]
};
`;

const GH_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1" in
  auth) exit 0 ;;
  repo) echo '{"owner":{"login":"acme"},"name":"widget"}' ;;
  pr) exit 1 ;;
  api) echo '{}' ;;
  *) exit 2 ;;
esac
`;

interface Sandbox {
  dir: string;
  work: string;
  ranLog: string;
  ghLog: string;
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
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), GH_SHIM);
  chmodSync(join(bin, 'gh'), 0o755);
  const ranLog = join(dir, 'ran.log');
  const ghLog = join(dir, 'gh.log');
  return {
    dir,
    work,
    ranLog,
    ghLog,
    env: {
      ...cleanEnv(),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RAN_LOG: ranLog,
      GH_LOG: ghLog,
      CHREODE_LOCK_PATH: join(dir, 'signoff.lock')
    }
  };
}

function signoff(sb: Sandbox, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(TSX, [CLI, 'signoff', ...args], {
    cwd: sb.work,
    env: { ...sb.env, ...extraEnv },
    encoding: 'utf8'
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const readLines = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const ran = (sb: Sandbox) => readLines(sb.ranLog);
const clearRan = (sb: Sandbox) => writeFileSync(sb.ranLog, '');
const statusPosts = (sb: Sandbox) =>
  readLines(sb.ghLog).filter((l) => l.startsWith('api -X POST repos/acme/widget/statuses/'));
const remoteFeature = (sb: Sandbox) => git(sb.work, 'ls-remote', 'origin', 'refs/heads/feature');

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
