import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildProgram,
  isInvokedDirectly,
  resolveSignoffOptions,
  type SignoffFlags
} from './cli.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src/cli.ts');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

function linkToCli(): string {
  const link = join(mkdtempSync(join(tmpdir(), 'chreode-bin-')), 'chreode.ts');
  symlinkSync(CLI, link);
  return link;
}

describe('resolveSignoffOptions', () => {
  it('defaults to an incremental, merging, pushing, policed run', () => {
    expect(resolveSignoffOptions({ merge: true, push: true }, {})).toEqual({
      full: false,
      dryRun: false,
      noMerge: false,
      noPush: false,
      allowStderr: false,
      base: null,
      skip: []
    });
  });

  it('honors CHREODE_* env set to exactly 1', () => {
    const env = {
      CHREODE_FULL: '1',
      CHREODE_NO_MERGE: '1',
      CHREODE_NO_PUSH: '1',
      CHREODE_ALLOW_STDERR: 'true'
    };
    expect(resolveSignoffOptions({ merge: true, push: true }, env)).toMatchObject({
      full: true,
      noMerge: true,
      noPush: true,
      allowStderr: false
    });
  });

  it('honors CHREODE_ALLOW_STDERR=1', () => {
    expect(resolveSignoffOptions({}, { CHREODE_ALLOW_STDERR: '1' }).allowStderr).toBe(true);
  });
});

describe('buildProgram', () => {
  it('parses repeatable --skip and the negated flags', async () => {
    let seen: SignoffFlags | null = null;
    const program = buildProgram(
      {
        signoff: async (flags) => {
          seen = flags;
          return 0;
        },
        protect: async () => 0
      },
      () => {}
    );
    program.exitOverride();
    await program.parseAsync(
      ['signoff', '--skip', 'lint', '--skip', 'test:e2e', '--no-merge', '--base', 'abc'],
      { from: 'user' }
    );
    expect(seen).toMatchObject({
      skip: ['lint', 'test:e2e'],
      merge: false,
      push: true,
      base: 'abc'
    });
  });
});

describe('invocation', () => {
  it('recognizes itself through a symlink, as npm installs bins', () => {
    const link = linkToCli();
    expect(isInvokedDirectly(pathToFileURL(CLI).href, link)).toBe(true);
    expect(isInvokedDirectly(pathToFileURL(CLI).href, join(ROOT, 'package.json'))).toBe(false);
    expect(isInvokedDirectly(pathToFileURL(CLI).href, undefined)).toBe(false);
  });

  it('prints the package version', () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const r = spawnSync(TSX, [CLI, '--version'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });

  it('runs identically when launched through a symlink', () => {
    const r = spawnSync(TSX, [linkToCli(), '--version'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).not.toBe('');
  });

  it('exits 1 on a config error, via the top-level catch', () => {
    const r = spawnSync(TSX, [CLI, 'signoff', '--config', '/nonexistent/chreode.config.ts'], {
      encoding: 'utf8',
      cwd: ROOT
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[chreode]');
  });
});
