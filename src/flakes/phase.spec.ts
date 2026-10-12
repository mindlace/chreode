import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedFlakes } from '../config/types.js';
import type { FlakeLedgerDeps } from './ledger.js';
import { appendFlakeEvent, readFlakeEvents, type FlakeEvent } from './log.js';
import {
  escalationFailure,
  escalationMessage,
  runFlakePhase,
  type FlakePhaseOutcome
} from './phase.js';

const CONFIG: ResolvedFlakes = {
  threshold: 3,
  snoozeLabel: 'flake-snoozed',
  playbookUrl: 'https://example.com/flakes.md'
};

function event(title: string): FlakeEvent {
  return {
    kind: 'unit',
    runner: 'vitest',
    project: '',
    file: 'src/a.spec.ts',
    title,
    firstAttemptError: 'boom',
    at: '2026-10-11T00:00:00.000Z'
  };
}

const KNOWN = 'flake(unit): src/a.spec.ts › known';

function ledger(over: Partial<FlakeLedgerDeps> = {}): FlakeLedgerDeps {
  return {
    listOpenFlakeIssues: () => [{ number: 42, title: KNOWN, url: 'https://gh/i/42', labels: [] }],
    countOccurrenceComments: () => 1,
    createIssue: (title) => ({ number: 7, title, url: 'https://gh/i/7', labels: ['flake'] }),
    commentIssue: () => {},
    ...over
  };
}

function setup(titles: string[], deps: FlakeLedgerDeps = ledger()) {
  const logPath = join(mkdtempSync(join(tmpdir(), 'chreode-phase-')), 'flakes.jsonl');
  for (const t of titles) appendFlakeEvent(event(t), logPath);
  const logs: string[] = [];
  const warns: string[] = [];
  const input = {
    logPath,
    ctx: { branch: 'b', sha: 's' },
    config: CONFIG,
    ledger: deps,
    log: (m: string) => void logs.push(m),
    warn: (m: string) => void warns.push(m)
  };
  return { input, logPath, logs, warns };
}

describe('runFlakePhase', () => {
  it('is silent and touches no GitHub when nothing was logged', () => {
    const s = setup(
      [],
      ledger({
        listOpenFlakeIssues: () => {
          throw new Error('must not be called');
        }
      })
    );
    expect(runFlakePhase(s.input)).toEqual({ kind: 'none' });
    expect(s.logs).toEqual([]);
  });

  it('files and bumps, prints the issue URLs, and clears the log', () => {
    const s = setup(['new', 'known']);
    const outcome = runFlakePhase(s.input);
    expect(outcome.kind).toBe('reported');
    expect(existsSync(s.logPath)).toBe(false);
    const out = s.logs.join('\n');
    expect(out).toContain('https://gh/i/7');
    expect(out).toContain('https://gh/i/42');
    expect(outcome.kind === 'reported' && outcome.result.escalations.map((e) => e.number)).toEqual([
      42
    ]);
  });

  it('a GitHub failure partway keeps only the events not yet recorded', () => {
    const s = setup(
      ['new', 'known'],
      ledger({
        commentIssue: () => {
          throw new Error('HTTP 502');
        }
      })
    );
    const outcome = runFlakePhase(s.input);
    expect(outcome).toMatchObject({ kind: 'gh-error', message: 'HTTP 502' });
    expect(readFlakeEvents(s.logPath).map((e) => e.title)).toEqual(['known']);
    expect(s.logs.join('\n')).toContain('https://gh/i/7');
    expect(s.warns.join('\n')).toContain('kept 1 event(s)');
  });

  it('a failed listing keeps every event', () => {
    const s = setup(
      ['new', 'known'],
      ledger({
        listOpenFlakeIssues: () => {
          throw new Error('gh: not logged in');
        }
      })
    );
    expect(runFlakePhase(s.input).kind).toBe('gh-error');
    expect(readFlakeEvents(s.logPath)).toHaveLength(2);
  });
});

describe('escalationMessage', () => {
  it('names each escalated issue, the playbook and the snooze label', () => {
    const message = escalationMessage(
      [{ number: 42, title: KNOWN, url: 'https://gh/i/42', count: 3 }],
      CONFIG
    );
    expect(message).toContain('https://gh/i/42 (3 occurrences)');
    expect(message).toContain(KNOWN);
    expect(message).toContain('https://example.com/flakes.md');
    expect(message).toContain('flake-snoozed');
  });
});

describe('escalationMessage dedupe', () => {
  it('lists each issue once, keeping the highest count', () => {
    const message = escalationMessage(
      [
        { number: 42, title: KNOWN, url: 'https://gh/i/42', count: 1 },
        { number: 42, title: KNOWN, url: 'https://gh/i/42', count: 3 },
        { number: 9, title: 'other', url: 'https://gh/i/9', count: 3 }
      ],
      CONFIG
    );
    expect(message.match(/https:\/\/gh\/i\/42/g)).toHaveLength(1);
    expect(message).toContain('https://gh/i/42 (3 occurrences)');
    expect(message).toContain('2 flake(s)');
  });
});

describe('escalationFailure', () => {
  const empty = { filed: [], bumped: [], escalations: [] };
  const esc = [{ number: 42, title: KNOWN, url: 'https://gh/i/42', count: 3 }];

  it('is undefined when nothing escalated', () => {
    const outcomes: FlakePhaseOutcome[] = [
      { kind: 'none' },
      { kind: 'reported', result: empty },
      { kind: 'gh-error', message: 'x', partial: empty }
    ];
    expect(outcomes.map((o) => escalationFailure(o, CONFIG))).toEqual([
      undefined,
      undefined,
      undefined
    ]);
  });

  it('returns the failure message for a reported escalation', () => {
    const outcome: FlakePhaseOutcome = {
      kind: 'reported',
      result: { ...empty, escalations: esc }
    };
    expect(escalationFailure(outcome, CONFIG)).toBe(escalationMessage(esc, CONFIG));
  });

  it('still fails on escalations recorded before a GitHub error', () => {
    const outcome: FlakePhaseOutcome = {
      kind: 'gh-error',
      message: 'x',
      partial: { ...empty, escalations: esc }
    };
    expect(escalationFailure(outcome, CONFIG)).toContain('https://gh/i/42');
  });
});
