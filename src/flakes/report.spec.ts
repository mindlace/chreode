import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeExec, type Response } from '../../test/support/fake-exec.js';
import { validateConfig } from '../config/validate.js';
import type { FlakeLedgerDeps } from './ledger.js';
import { appendFlakeEvent, readFlakeEvents } from './log.js';
import { runFlakeReport } from './report.js';

const TITLE = 'flake(unit): src/a.spec.ts › a';

function harness(
  logged: number,
  git: Record<string, Response> = {},
  ledger: Partial<FlakeLedgerDeps> = {}
) {
  const logPath = join(mkdtempSync(join(tmpdir(), 'chreode-report-')), 'flakes.jsonl');
  for (let i = 0; i < logged; i++) {
    appendFlakeEvent(
      {
        kind: 'unit',
        runner: 'vitest',
        project: '',
        file: 'src/a.spec.ts',
        title: 'a',
        firstAttemptError: 'boom',
        at: '2026-10-11T00:00:00.000Z'
      },
      logPath
    );
  }
  const bodies: string[] = [];
  const out: string[] = [];
  const errors: string[] = [];
  const deps = {
    exec: fakeExec({
      'git rev-parse HEAD': 'h\n',
      'git symbolic-ref -q --short HEAD': 'feature\n',
      ...git
    }).exec,
    ledger: {
      listOpenFlakeIssues: () => [],
      countOccurrenceComments: () => 0,
      createIssue: (title: string, body: string) => {
        bodies.push(body);
        return { number: 7, title, url: 'https://gh/i/7', labels: ['flake'] };
      },
      commentIssue: () => {},
      ...ledger
    },
    logPath,
    log: (m: string) => void out.push(m),
    warn: (m: string) => void out.push(m),
    error: (m: string) => void errors.push(m)
  };
  return { deps, logPath, bodies, out, errors };
}

const config = (flakes?: Record<string, unknown>) =>
  validateConfig(flakes === undefined ? { steps: [] } : { steps: [], flakes });

describe('runFlakeReport', () => {
  it('says so and exits 0 when nothing was recorded', () => {
    const h = harness(0);
    expect(runFlakeReport(config({}), h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('no flakes recorded');
  });

  it('files issues and exits 0', () => {
    const h = harness(1);
    expect(runFlakeReport(config({}), h.deps)).toBe(0);
    expect(h.bodies[0]).toContain('`feature` @ h');
    expect(readFlakeEvents(h.logPath)).toEqual([]);
  });

  it('exits 1 on escalation, using the default threshold without a flakes block', () => {
    const h = harness(
      1,
      {},
      {
        listOpenFlakeIssues: () => [
          { number: 42, title: TITLE, url: 'https://gh/i/42', labels: [] }
        ],
        countOccurrenceComments: () => 1
      }
    );
    expect(runFlakeReport(config(), h.deps)).toBe(1);
    expect(h.out.join('\n')).toContain('flakes: 1 retried-then-passed');
    expect(h.errors.join('\n')).toContain('https://gh/i/42');
  });

  it('a GitHub failure keeps the log and exits 0', () => {
    const h = harness(
      1,
      {},
      {
        listOpenFlakeIssues: () => {
          throw new Error('HTTP 502');
        }
      }
    );
    expect(runFlakeReport(config({}), h.deps)).toBe(0);
    expect(readFlakeEvents(h.logPath)).toHaveLength(1);
  });

  it('names a detached HEAD as HEAD (a CI checkout of a sha)', () => {
    const h = harness(1, { 'git symbolic-ref -q --short HEAD': new Error('detached') });
    expect(runFlakeReport(config({}), h.deps)).toBe(0);
    expect(h.bodies[0]).toContain('`HEAD` @ h');
  });
});
