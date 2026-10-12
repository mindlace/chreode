import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readFlakeEvents } from '../../src/flakes/log.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The parent's env minus chreode's and vitest's own variables, so the nested runner behaves
 *  as if started by hand (under signoff the parent has CHREODE_FLAKE_LOG set). */
function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CHREODE_') && !key.startsWith('VITEST')) env[key] = value;
  }
  return { ...env, ...extra };
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'chreode-smoke-'));
  return { dir, log: join(dir, 'flakes.jsonl'), marker: join(dir, 'attempted') };
}

function runner(bin: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(join(ROOT, 'node_modules/.bin', bin), args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: childEnv(env)
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('reporters against real runners', { timeout: 120_000 }, () => {
  it('playwright: a test that fails once and then passes is logged', () => {
    const sb = sandbox();
    const r = runner(
      'playwright',
      ['test', '--config', 'test/fixtures/playwright-flake/playwright.config.ts'],
      {
        CHREODE_FLAKE_LOG: sb.log,
        CHREODE_HEAD: 'abc123',
        FLAKE_MARKER: sb.marker,
        PW_OUTPUT_DIR: join(sb.dir, 'pw-out')
      }
    );
    expect(r.status, r.out).toBe(0);
    const events = readFlakeEvents(sb.log);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'e2e',
      runner: 'playwright',
      project: '',
      file: 'test/fixtures/playwright-flake/flaky.pw.ts',
      title: 'smoke › fails once, then passes',
      sha: 'abc123'
    });
    expect(events[0]!.firstAttemptError).toContain('first attempt fails on purpose');
  });

  it('vitest: a test that fails once and then passes is logged', () => {
    const sb = sandbox();
    const r = runner('vitest', ['run', '--config', 'test/fixtures/vitest-flake/vitest.config.ts'], {
      CHREODE_FLAKE_LOG: sb.log,
      CHREODE_HEAD: 'abc123',
      FLAKE_MARKER: sb.marker
    });
    expect(r.status, r.out).toBe(0);
    const events = readFlakeEvents(sb.log);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'smoke',
      runner: 'vitest',
      project: 'smoke',
      file: 'test/fixtures/vitest-flake/flaky.fixture.ts',
      title: 'smoke › fails once, then passes',
      sha: 'abc123'
    });
    expect(events[0]!.firstAttemptError).toContain('first attempt fails on purpose');
  });
});
