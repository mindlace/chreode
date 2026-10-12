import { describe, expect, it } from 'vitest';
import type { ResolvedFlakes } from '../config/types.js';
import {
  LedgerError,
  OCCURRENCE_MARKER,
  issueTitle,
  processFlakeEvents,
  type FlakeIssue,
  type FlakeLedgerDeps
} from './ledger.js';
import type { FlakeEvent } from './log.js';

const CTX = { branch: 'my-feature', sha: 'run-sha' };
const CONFIG: ResolvedFlakes = {
  threshold: 3,
  snoozeLabel: 'flake-snoozed',
  playbookUrl: 'https://example.com/flakes.md'
};

function event(over: Partial<FlakeEvent> = {}): FlakeEvent {
  return {
    kind: 'e2e',
    runner: 'playwright',
    project: 'chromium',
    file: 'e2e/dep.spec.ts',
    title: 'link navigates',
    firstAttemptError: 'boom',
    at: '2026-10-11T00:00:00.000Z',
    ...over
  };
}

const TITLE = 'flake(e2e): e2e/dep.spec.ts › link navigates';
const issue = (labels: string[] = ['flake']): FlakeIssue => ({
  number: 42,
  title: TITLE,
  url: 'https://gh/i/42',
  labels
});

function fakeDeps(
  open: FlakeIssue[],
  prior: Record<number, number> = {},
  failOn?: 'list' | 'comment'
) {
  const created: { title: string; body: string }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const deps: FlakeLedgerDeps = {
    listOpenFlakeIssues: () => {
      if (failOn === 'list') throw new Error('HTTP 502\nbad gateway');
      return open;
    },
    countOccurrenceComments: (n) => prior[n] ?? 0,
    createIssue: (title, body) => {
      created.push({ title, body });
      const number = 900 + created.length;
      return { number, title, url: `https://gh/i/${number}`, labels: ['flake'] };
    },
    commentIssue: (n, body) => {
      if (failOn === 'comment') throw new Error('HTTP 502');
      comments.push({ issue: n, body });
    }
  };
  return { deps, created, comments };
}

describe('issueTitle', () => {
  it('is stable and capped at 256 characters', () => {
    expect(issueTitle(event())).toBe(TITLE);
    const long = issueTitle(event({ title: 'x'.repeat(400) }));
    expect(long).toHaveLength(256);
    expect(long.startsWith('flake(e2e): e2e/dep.spec.ts › xxx')).toBe(true);
  });

  it('trims whitespace exposed by the cut, and a re-run still matches its issue', () => {
    const prefix = 'flake(e2e): e2e/dep.spec.ts › ';
    const title = `${'x'.repeat(256 - prefix.length - 1)} tail`;
    const cut = issueTitle(event({ title }));
    expect(cut.length).toBeLessThan(256);
    expect(cut).toBe(cut.trimEnd());
    const existing = { ...issue(), title: cut };
    const { deps, created, comments } = fakeDeps([existing]);
    processFlakeEvents([event({ title })], CTX, CONFIG, deps);
    expect(created).toHaveLength(0);
    expect(comments).toHaveLength(1);
  });
});

describe('processFlakeEvents', () => {
  it('files a new issue with the error, where it was seen, and the playbook', () => {
    const { deps, created } = fakeDeps([]);
    const result = processFlakeEvents([event()], CTX, CONFIG, deps);
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe(TITLE);
    for (const text of ['boom', 'my-feature', 'run-sha', 'https://example.com/flakes.md']) {
      expect(created[0]!.body).toContain(text);
    }
    expect(created[0]!.body).toContain('`flake-snoozed`');
    expect(result.filed).toEqual([
      { number: 901, title: TITLE, url: 'https://gh/i/901', count: 1 }
    ]);
    expect(result.escalations).toEqual([]);
  });

  it('renders the title in a code span and fences errors longer than any backtick run', () => {
    const { deps, created } = fakeDeps([]);
    processFlakeEvents(
      [event({ title: 'pings @user and #12', firstAttemptError: 'a\n```\nb' })],
      CTX,
      CONFIG,
      deps
    );
    const body = created[0]!.body;
    expect(body).toContain('`e2e/dep.spec.ts › pings @user and #12`');
    expect(body).toContain('\n````\na\n```\nb\n````');
  });

  it("names the event's own sha over the run's", () => {
    const { deps, created } = fakeDeps([]);
    processFlakeEvents([event({ sha: 'event-sha' })], CTX, CONFIG, deps);
    expect(created[0]!.body).toContain('@ event-sha');
    expect(created[0]!.body).not.toContain('run-sha');
  });

  it('comments on the exact-title match and reports the running count', () => {
    const { deps, comments } = fakeDeps([issue()], { 42: 0 });
    const result = processFlakeEvents([event()], CTX, CONFIG, deps);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.issue).toBe(42);
    expect(comments[0]!.body.startsWith(OCCURRENCE_MARKER)).toBe(true);
    expect(result.bumped).toEqual([{ number: 42, title: TITLE, url: 'https://gh/i/42', count: 2 }]);
    expect(result.escalations).toEqual([]);
  });

  it('escalates at the threshold unless snoozed, and a snoozed flake still records', () => {
    // 1 (the issue) + 1 earlier marker comment + this run's comment = 3.
    const hot = fakeDeps([issue()], { 42: 1 });
    expect(processFlakeEvents([event()], CTX, CONFIG, hot.deps).escalations).toEqual([
      { number: 42, title: TITLE, url: 'https://gh/i/42', count: 3 }
    ]);
    const snoozed = fakeDeps([issue(['flake', 'flake-snoozed'])], { 42: 5 });
    expect(processFlakeEvents([event()], CTX, CONFIG, snoozed.deps).escalations).toEqual([]);
    expect(snoozed.comments).toHaveLength(1);
  });

  it('honours a configured threshold and snooze label', () => {
    const config = { ...CONFIG, threshold: 2, snoozeLabel: 'later' };
    const hot = fakeDeps([issue()], { 42: 0 });
    expect(processFlakeEvents([event()], CTX, config, hot.deps).escalations).toHaveLength(1);
    const snoozed = fakeDeps([issue(['flake', 'later'])], { 42: 0 });
    expect(processFlakeEvents([event()], CTX, config, snoozed.deps).escalations).toEqual([]);
  });

  it('with threshold 1, escalates on filing', () => {
    const { deps } = fakeDeps([]);
    const result = processFlakeEvents([event()], CTX, { ...CONFIG, threshold: 1 }, deps);
    expect(result.escalations).toEqual(result.filed);
  });

  it('counts the same test seen in two projects once', () => {
    const { deps, comments } = fakeDeps([issue()]);
    processFlakeEvents(
      [event({ project: 'chromium' }), event({ project: 'mobile' })],
      CTX,
      CONFIG,
      deps
    );
    expect(comments).toHaveLength(1);
  });

  it('bumps an issue filed earlier in the same run when titles collide after truncation', () => {
    const { deps, created, comments } = fakeDeps([]);
    const long = 'x'.repeat(400);
    processFlakeEvents(
      [event({ title: `${long}a` }), event({ title: `${long}b` })],
      CTX,
      CONFIG,
      deps
    );
    expect(created).toHaveLength(1);
    expect(comments.map((c) => c.issue)).toEqual([901]);
  });

  it('a failed listing records nothing and returns every event as remaining', () => {
    const { deps } = fakeDeps([], {}, 'list');
    const events = [event({ title: 'a' }), event({ title: 'b' })];
    let caught: unknown;
    try {
      processFlakeEvents(events, CTX, CONFIG, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LedgerError);
    const err = caught as LedgerError;
    expect(err.message).toBe('HTTP 502');
    expect(err.partial).toEqual({ filed: [], bumped: [], escalations: [] });
    expect(err.remaining.map((e) => e.title)).toEqual(['a', 'b']);
  });

  it('a failure partway keeps what was recorded out of the remaining events', () => {
    const { deps } = fakeDeps([issue()], {}, 'comment');
    let caught: unknown;
    try {
      processFlakeEvents([event({ title: 'new one' }), event()], CTX, CONFIG, deps);
    } catch (err) {
      caught = err;
    }
    const err = caught as LedgerError;
    expect(err.partial.filed.map((f) => f.number)).toEqual([901]);
    expect(err.remaining.map((e) => e.title)).toEqual(['link navigates']);
  });
});
