import { statSync } from 'node:fs';
import type { ResolvedBurnIn } from '../config/types.js';
import { defaultExec, defaultRun, type Exec, type Run } from '../run/exec.js';
import {
  BurnInError,
  burnInCandidates,
  burnInCommands,
  selectBurnIn,
  type BurnInCommand
} from './select.js';

export interface BurnInDeps {
  exec: Exec;
  /** Inherited stdio: the test runners' own output streams through. */
  run: Run;
  mtime: (path: string) => number | null;
  log: (m: string) => void;
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Run every test file added or changed in base..head `repeats` times with retries off. The
 * first failure exits 1. All of chreode's own output goes to stdout: this runs inside a
 * policed signoff step.
 */
export function runBurnIn(
  config: ResolvedBurnIn | null,
  range: { base: string; head: string },
  overrides: Partial<BurnInDeps> = {}
): number {
  const d: BurnInDeps = {
    exec: defaultExec,
    run: (command) => defaultRun(command),
    mtime: mtimeOf,
    log: (m) => console.log(m),
    ...overrides
  };
  if (config === null) {
    d.log(
      '[chreode] burn-in: chreode.config.ts has no burnIn block; nothing knows how to run tests'
    );
    return 1;
  }
  const candidates = burnInCandidates(range.base, range.head, d.exec, d.mtime);
  const plan = selectBurnIn(candidates, config);
  let commands: BurnInCommand[];
  try {
    commands = burnInCommands(plan, config.repeats);
  } catch (err) {
    if (err instanceof BurnInError) {
      d.log(`[chreode] ${err.message}`);
      return 1;
    }
    throw err;
  }
  const kept = plan.groups.reduce((n, g) => n + g.files.length, 0);
  if (kept === 0) {
    d.log('[chreode] burn-in: no changed test files; nothing to burn in');
    return 0;
  }
  d.log(`[chreode] burn-in: ${kept} changed test file(s) × ${config.repeats}, retries off:`);
  for (const group of plan.groups) {
    for (const file of group.files) d.log(`  ${file} (${group.runner.name})`);
  }
  if (plan.skipped.length > 0) {
    d.log(`[chreode] burn-in: over the ${config.maxFiles}-file cap, NOT burned in:`);
    for (const file of plan.skipped) d.log(`  ${file}`);
  }
  for (const c of commands) {
    d.log(`[chreode] burn-in (${c.runner}): ${c.command}`);
    try {
      d.run(c.command);
    } catch {
      d.log(
        `\n[chreode] burn-in FAILED (${c.runner}): ${c.files.join(' ')}\n` +
          `[chreode] command: ${c.command}\n` +
          `[chreode] A test that flakes at birth flakes forever: fix it before it lands.`
      );
      return 1;
    }
  }
  d.log('[chreode] burn-in: every changed test file survived');
  return 0;
}
