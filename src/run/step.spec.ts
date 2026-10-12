import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MachineLock } from '../lock/machine-lock.js';
import type { PlannedStep } from '../signoff/plan.js';
import { StepFailure, runStep, runSteps, runWithTimeout, type RunResult } from './step.js';

const quiet = { log: () => {}, error: () => {}, writeStderr: () => {} };
const step = (over: Partial<PlannedStep> = {}): PlannedStep => ({
  label: 'test',
  command: 'true',
  policeStderr: false,
  timeoutMs: 10_000,
  ...over
});
const result = (over: Partial<RunResult>): RunResult => ({
  code: 0,
  timedOut: false,
  interrupted: false,
  ...over
});

describe('runWithTimeout', () => {
  it('reports the exit code', async () => {
    const r = await runWithTimeout('exit 3', 10_000, { signals: new EventEmitter() });
    expect(r).toMatchObject({ code: 3, timedOut: false, interrupted: false });
  });

  it('passes env to the command', async () => {
    const r = await runWithTimeout('test "$CHREODE_SIGNOFF" = 1', 10_000, {
      env: { ...process.env, CHREODE_SIGNOFF: '1' },
      signals: new EventEmitter()
    });
    expect(r.code).toBe(0);
  });

  it('SIGKILLs the whole process group on timeout, grandchildren included', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'chreode-step-')), 'pid');
    const started = Date.now();
    const r = await runWithTimeout(`sleep 30 & echo $! > ${pidFile}; wait`, 300, {
      signals: new EventEmitter()
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it('forwards SIGINT to the step group and stops listening afterwards', async () => {
    const signals = new EventEmitter();
    const pending = runWithTimeout('sleep 30', 60_000, { signals });
    setTimeout(() => signals.emit('SIGINT'), 200);
    const r = await pending;
    expect(r.interrupted).toBe(true);
    expect(r.code).not.toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('kills a TERM-ignoring grandchild after an interrupt', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'chreode-step-')), 'pid');
    const signals = new EventEmitter();
    const pending = runWithTimeout(
      `sh -c 'trap "" TERM; sleep 30' & echo $! > ${pidFile}; wait`,
      60_000,
      { signals }
    );
    setTimeout(() => signals.emit('SIGINT'), 300);
    const r = await pending;
    expect(r.interrupted).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it('a second signal escalates to SIGKILL promptly', async () => {
    const signals = new EventEmitter();
    const started = Date.now();
    const pending = runWithTimeout('trap "" TERM; sleep 30', 60_000, { signals });
    setTimeout(() => signals.emit('SIGINT'), 300);
    setTimeout(() => signals.emit('SIGINT'), 600);
    const r = await pending;
    expect(r.interrupted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('captures all of stderr, even past the pipe buffer', async () => {
    const r = await runWithTimeout(`node -e "process.stderr.write('x'.repeat(200000))"`, 10_000, {
      captureStderr: true,
      signals: new EventEmitter()
    });
    expect(r.stderr).toHaveLength(200000);
  });
});

describe('runStep', () => {
  it('a non-policed non-zero exit fails', async () => {
    const runImpl = async () => result({ code: 1 });
    await expect(
      runStep(step(), { allowStderr: false, allowlist: [], runImpl, ...quiet })
    ).rejects.toBeInstanceOf(StepFailure);
  });

  it('a non-policed step ignores stderr', async () => {
    const runImpl = async () => result({ stderr: 'noise' });
    await expect(
      runStep(step(), { allowStderr: false, allowlist: [], runImpl, ...quiet })
    ).resolves.toBe('passed');
  });

  it('a policed clean exit with unexpected stderr fails', async () => {
    const runImpl = async () => result({ stderr: 'Error: boom' });
    await expect(
      runStep(step({ policeStderr: true }), {
        allowStderr: false,
        allowlist: [],
        runImpl,
        ...quiet
      })
    ).rejects.toBeInstanceOf(StepFailure);
  });

  it('--allow-stderr downgrades unexpected stderr to a warning', async () => {
    const runImpl = async () => result({ stderr: 'Error: boom' });
    const errors: string[] = [];
    const outcome = await runStep(step({ policeStderr: true }), {
      allowStderr: true,
      allowlist: [],
      runImpl,
      ...quiet,
      error: (m) => errors.push(m)
    });
    expect(outcome).toBe('allowed-stderr');
    expect(errors.join('\n')).toContain('allowed by --allow-stderr');
  });

  it('--allow-stderr with clean stderr is an ordinary pass', async () => {
    const runImpl = async () => result({});
    await expect(
      runStep(step({ policeStderr: true }), { allowStderr: true, allowlist: [], runImpl, ...quiet })
    ).resolves.toBe('passed');
  });

  it('allowlisted stderr passes', async () => {
    const runImpl = async () => result({ stderr: '[WebServer] up' });
    await expect(
      runStep(step({ policeStderr: true }), {
        allowStderr: false,
        allowlist: [{ pattern: /^\[WebServer\]/, reason: 'r' }],
        runImpl,
        ...quiet
      })
    ).resolves.toBe('passed');
  });

  it('every step child gets CHREODE_SIGNOFF=1, keeping the caller env', async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const runImpl = async (_cmd: string, _ms: number, o: { env?: NodeJS.ProcessEnv }) => {
      seen = o.env;
      return result({});
    };
    await runStep(step(), {
      allowStderr: false,
      allowlist: [],
      env: { FOO: 'bar' },
      runImpl,
      ...quiet
    });
    expect(seen).toMatchObject({ FOO: 'bar', CHREODE_SIGNOFF: '1' });
  });

  it('a timeout fails even if the exit code looks clean', async () => {
    const runImpl = async () => result({ code: null, timedOut: true });
    await expect(
      runStep(step(), { allowStderr: true, allowlist: [], runImpl, ...quiet })
    ).rejects.toThrow('timed out');
  });
});

describe('runSteps', () => {
  function lock(events: string[]): MachineLock {
    return {
      acquire: async () => {
        events.push('acquire');
        return async () => {
          events.push('release');
        };
      }
    };
  }

  it('an empty plan touches no lock', async () => {
    const events: string[] = [];
    expect(await runSteps([], lock(events), async () => 'passed')).toEqual([]);
    expect(events).toEqual([]);
  });

  it('runs steps in order inside the lock', async () => {
    const events: string[] = [];
    await runSteps([step({ label: 'a' }), step({ label: 'b' })], lock(events), async (s) => {
      events.push(s.label);
      return 'passed';
    });
    expect(events).toEqual(['acquire', 'a', 'b', 'release']);
  });

  it('returns the labels whose stderr --allow-stderr let pass', async () => {
    const steps = [step({ label: 'a' }), step({ label: 'b' }), step({ label: 'c' })];
    const allowed = await runSteps(steps, lock([]), async (s) =>
      s.label === 'b' ? 'allowed-stderr' : 'passed'
    );
    expect(allowed).toEqual(['b']);
  });

  it('releases the lock and stops at the first failure', async () => {
    const events: string[] = [];
    const run = async (s: PlannedStep) => {
      events.push(s.label);
      if (s.label === 'a') throw new StepFailure('a', 'failed');
      return 'passed' as const;
    };
    await expect(
      runSteps([step({ label: 'a' }), step({ label: 'b' })], lock(events), run)
    ).rejects.toBeInstanceOf(StepFailure);
    expect(events).toEqual(['acquire', 'a', 'release']);
  });
});
