import { spawn } from 'node:child_process';
import type { AllowlistEntry } from '../config/types.js';
import type { MachineLock } from '../lock/machine-lock.js';
import type { PlannedStep } from '../signoff/plan.js';
import { decidePolicedOutcome } from './stderr.js';

export interface RunResult {
  /** Exit code, or null when killed by a signal. */
  code: number | null;
  timedOut: boolean;
  interrupted: boolean;
  /** Present only when captureStderr was set. */
  stderr?: string;
}

export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', fn: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', fn: () => void): unknown;
}

export interface RunOptions {
  /** stdout stays live; stderr is piped, buffered and returned. */
  captureStderr?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Where SIGINT/SIGTERM arrive; defaults to the process. Injectable for tests. */
  signals?: SignalSource;
}

/** After exit, how long to wait for a captured stderr pipe to drain. A grandchild that
 *  inherited the pipe can hold it open; this bounds the wait. */
const STDERR_DRAIN_MS = 2_000;

/** After forwarding SIGINT/SIGTERM, how long a step gets to exit before its group is SIGKILLed. */
export const INTERRUPT_GRACE_MS = 3_000;

/**
 * Run a shell command with a hard wall-clock timeout. The command runs in its OWN process
 * group (detached) so a timeout can SIGKILL the whole tree, not just the wrapping shell.
 * Being in its own group, it no longer receives the terminal's Ctrl-C, so SIGINT/SIGTERM
 * delivered to us are forwarded to the group. Never rejects.
 */
export function runWithTimeout(
  cmd: string,
  timeoutMs: number,
  opts: RunOptions = {}
): Promise<RunResult> {
  const capture = opts.captureStderr ?? false;
  const signals: SignalSource = opts.signals ?? process;
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: capture ? ['inherit', 'inherit', 'pipe'] : 'inherit',
      detached: true,
      env: opts.env ?? process.env,
      cwd: opts.cwd
    });
    let stderrBuf = '';
    let stderrEnded = !capture || child.stderr === null;
    let exitCode: number | null | undefined;
    let timedOut = false;
    let interrupted = false;
    let settled = false;

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Group already gone.
      }
    };
    let graceTimer: NodeJS.Timeout | undefined;
    const onSignal = () => {
      if (interrupted) {
        // A second Ctrl-C means "now".
        killGroup('SIGKILL');
        return;
      }
      interrupted = true;
      killGroup('SIGTERM');
      graceTimer = setTimeout(() => killGroup('SIGKILL'), INTERRUPT_GRACE_MS);
      graceTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, timeoutMs);
    signals.on('SIGINT', onSignal);
    signals.on('SIGTERM', onSignal);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      // Reap survivors of the leader's exit (e.g. TERM-ignoring grandchildren).
      if (interrupted) killGroup('SIGKILL');
      signals.off('SIGINT', onSignal);
      signals.off('SIGTERM', onSignal);
      resolve({ code, timedOut, interrupted, stderr: capture ? stderrBuf : undefined });
    };

    if (capture && child.stderr) {
      // setEncoding decodes through a StringDecoder, so a multi-byte character split across
      // chunks is not corrupted.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuf += chunk;
      });
      child.stderr.on('end', () => {
        stderrEnded = true;
        if (exitCode !== undefined) finish(exitCode);
      });
    }
    child.on('exit', (code) => {
      exitCode = code;
      if (stderrEnded) finish(code);
      else setTimeout(() => finish(code), STDERR_DRAIN_MS).unref();
    });
    child.on('error', () => finish(1));
  });
}

export class StepFailure extends Error {
  constructor(
    readonly label: string,
    message: string
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

function formatDuration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

export function timeoutMessage(label: string, timeoutMs: number): string {
  return (
    `\n[chreode] TIMED OUT at: ${label} after ${formatDuration(timeoutMs)}. Suspect a ` +
    `contending process or a genuinely slow machine. Killed the step's process tree.`
  );
}

export interface StepRunOptions {
  allowStderr: boolean;
  allowlist: readonly AllowlistEntry[];
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
  error?: (m: string) => void;
  writeStderr?: (s: string) => void;
  runImpl?: (cmd: string, timeoutMs: number, opts: RunOptions) => Promise<RunResult>;
}

/** How a step passed: 'allowed-stderr' means it would have failed stderr policing but for
 *  --allow-stderr, which makes the run partial. */
export type StepOutcome = 'passed' | 'allowed-stderr';

/** Run one planned step. Every failure throws StepFailure so the caller's `finally`
 *  releases the lock before the run exits. */
export async function runStep(step: PlannedStep, opts: StepRunOptions): Promise<StepOutcome> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const error = opts.error ?? ((m: string) => console.error(m));
  const writeStderr = opts.writeStderr ?? ((s: string) => void process.stderr.write(s));
  const runImpl = opts.runImpl ?? runWithTimeout;

  log(`\n[chreode] ${step.label}: ${step.command}`);
  const r = await runImpl(step.command, step.timeoutMs, {
    captureStderr: step.policeStderr,
    env: { ...(opts.env ?? process.env), CHREODE_SIGNOFF: '1' }
  });

  if (r.timedOut) {
    if (r.stderr) writeStderr(r.stderr);
    error(timeoutMessage(step.label, step.timeoutMs));
    throw new StepFailure(step.label, `${step.label} timed out`);
  }
  if (r.interrupted) {
    if (r.stderr) writeStderr(r.stderr);
    error(`\n[chreode] INTERRUPTED at: ${step.label}`);
    throw new StepFailure(step.label, `${step.label} interrupted`);
  }
  if (!step.policeStderr) {
    if (r.code !== 0) {
      error(`\n[chreode] FAILED at: ${step.label} (exit ${r.code})`);
      throw new StepFailure(step.label, `${step.label} failed`);
    }
    return 'passed';
  }

  const outcome = decidePolicedOutcome({ code: r.code, stderr: r.stderr }, opts.allowlist);
  if (outcome.kind === 'fail-exit') {
    if (outcome.rawStderr) writeStderr(outcome.rawStderr);
    error(`\n[chreode] FAILED at: ${step.label} (exit ${r.code})`);
    throw new StepFailure(step.label, `${step.label} failed`);
  }
  if (outcome.kind === 'fail-stderr') {
    if (opts.allowStderr) {
      error(`\n[chreode] ${step.label} wrote unexpected stderr, allowed by --allow-stderr:`);
      for (const line of outcome.offendingLines) writeStderr(`${line}\n`);
      return 'allowed-stderr';
    }
    error(
      `\n[chreode] FAILED at: ${step.label}: it exited 0 but wrote unexpected stderr.\n` +
        `[chreode] A passing step that logs errors is still a failure: fix it at the source.\n` +
        `[chreode] Allowlisting genuinely benign noise is a reviewed change to stderrAllowlist\n` +
        `[chreode] in chreode.config.ts, with a reason. --allow-stderr bypasses for one run.\n` +
        `[chreode] Offending lines:`
    );
    for (const line of outcome.offendingLines) writeStderr(`${line}\n`);
    throw new StepFailure(step.label, `${step.label} wrote unexpected stderr`);
  }
  return 'passed';
}

/** Run the plan holding the machine lock; an empty plan touches no lock. The lock is
 *  released on every exit path. Returns the labels whose stderr --allow-stderr waived. */
export async function runSteps(
  steps: readonly PlannedStep[],
  lock: MachineLock,
  run: (step: PlannedStep) => Promise<StepOutcome>
): Promise<string[]> {
  if (steps.length === 0) return [];
  const release = await lock.acquire();
  const allowed: string[] = [];
  try {
    for (const step of steps) {
      if ((await run(step)) === 'allowed-stderr') allowed.push(step.label);
    }
    return allowed;
  } finally {
    await release();
  }
}
