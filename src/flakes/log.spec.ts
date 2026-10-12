import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendFlakeEvent,
  clearFlakeLog,
  dedupeEvents,
  findRepoRoot,
  flakeLogPath,
  readFlakeEvents,
  repoRelative,
  truncateError,
  writeFlakeEvents,
  type FlakeEvent
} from './log.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'chreode-log-'));

function event(over: Partial<FlakeEvent> = {}): FlakeEvent {
  return {
    kind: 'e2e',
    runner: 'playwright',
    project: 'chromium',
    file: 'e2e/a.spec.ts',
    title: 'suite › works',
    firstAttemptError: 'boom',
    at: '2026-10-11T00:00:00.000Z',
    ...over
  };
}

describe('flake log IO', () => {
  it('appends events, creating the directory, and reads them back in order', () => {
    const log = join(tmp(), '.chreode', 'flakes.jsonl');
    appendFlakeEvent(event({ title: 'one' }), log);
    appendFlakeEvent(event({ title: 'two' }), log);
    expect(readFlakeEvents(log).map((e) => e.title)).toEqual(['one', 'two']);
  });

  it('reads a missing log as empty', () => {
    expect(readFlakeEvents(join(tmp(), 'nope.jsonl'))).toEqual([]);
  });

  it('skips malformed and half-written lines', () => {
    const log = join(tmp(), 'flakes.jsonl');
    writeFileSync(
      log,
      [
        JSON.stringify(event({ title: 'good' })),
        'not json',
        '{"kind":"e2e","file":"x"}',
        '{"kind":"e2e","runner":"playwright","pro',
        ''
      ].join('\n')
    );
    expect(readFlakeEvents(log).map((e) => e.title)).toEqual(['good']);
  });

  it('rewrites the log with the given events, or removes it when there are none', () => {
    const log = join(tmp(), 'flakes.jsonl');
    appendFlakeEvent(event({ title: 'a' }), log);
    appendFlakeEvent(event({ title: 'b' }), log);
    writeFlakeEvents(log, [event({ title: 'b' })]);
    expect(readFlakeEvents(log).map((e) => e.title)).toEqual(['b']);
    writeFlakeEvents(log, []);
    expect(readFlakeEvents(log)).toEqual([]);
    clearFlakeLog(log);
    expect(readFlakeEvents(log)).toEqual([]);
  });
});

describe('dedupeEvents', () => {
  it('keeps the first event per kind/file/title, whatever the project', () => {
    const out = dedupeEvents([
      event({ project: 'chromium' }),
      event({ project: 'mobile' }),
      event({ kind: 'unit' })
    ]);
    expect(out.map((e) => `${e.kind}:${e.project}`)).toEqual(['e2e:chromium', 'unit:chromium']);
  });
});

describe('flakeLogPath', () => {
  it('prefers CHREODE_FLAKE_LOG, else <cwd>/.chreode/flakes.jsonl', () => {
    expect(flakeLogPath({ CHREODE_FLAKE_LOG: '/r/.chreode/flakes.jsonl' }, '/elsewhere')).toBe(
      '/r/.chreode/flakes.jsonl'
    );
    expect(flakeLogPath({}, '/r')).toBe('/r/.chreode/flakes.jsonl');
    expect(flakeLogPath({ CHREODE_FLAKE_LOG: '' }, '/r')).toBe('/r/.chreode/flakes.jsonl');
  });
});

describe('truncateError', () => {
  it('keeps the first 40 lines and strips ANSI colour codes', () => {
    const esc = String.fromCharCode(27);
    const message = Array.from({ length: 100 }, (_, i) => `${esc}[31mline ${i}${esc}[39m`).join(
      '\n'
    );
    const out = truncateError(message);
    expect(out.split('\n')).toHaveLength(40);
    expect(out.split('\n')[0]).toBe('line 0');
    expect(out).not.toContain(esc);
  });

  it('says so when the runner gave no error', () => {
    expect(truncateError(undefined)).toBe('(first attempt error unavailable)');
  });
});

describe('repo-relative paths', () => {
  it('finds a worktree root, where .git is a file', () => {
    const root = tmp();
    writeFileSync(join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    mkdirSync(join(root, 'e2e', 'deep'), { recursive: true });
    expect(findRepoRoot(join(root, 'e2e', 'deep'))).toBe(root);
    expect(repoRelative(join(root, 'e2e', 'deep', 'a.spec.ts'), '/unrelated')).toBe(
      'e2e/deep/a.spec.ts'
    );
  });

  it('finds a normal checkout, where .git is a directory', () => {
    const root = tmp();
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'src'));
    expect(repoRelative(join(root, 'src', 'a.spec.ts'), '/unrelated')).toBe('src/a.spec.ts');
  });

  it('falls back to the cwd outside any repo', () => {
    expect(findRepoRoot('/x/y', () => false)).toBeNull();
    expect(repoRelative('/x/y/a/b.spec.ts', '/x', () => false)).toBe('y/a/b.spec.ts');
  });
});
