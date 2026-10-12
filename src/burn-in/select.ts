import type { BurnInRunner, ResolvedBurnIn } from '../config/types.js';
import type { Exec } from '../run/exec.js';
import { matchesAny } from '../signoff/plan.js';

export class BurnInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BurnInError';
  }
}

/**
 * Paths added or modified in base..head, newest mtime first so the file cap keeps the most
 * recently touched. --no-renames lists a rename as delete + add and --diff-filter=d drops
 * deletions, so a renamed file appears under its new name only. Files missing on disk
 * (mtime null) are dropped.
 */
export function burnInCandidates(
  base: string,
  head: string,
  exec: Exec,
  mtime: (path: string) => number | null
): string[] {
  if (base === head) return [];
  const out = exec('git', [
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=d',
    '-z',
    `${base}..${head}`
  ]);
  return out
    .split('\0')
    .filter((p) => p !== '')
    .map((path) => ({ path, time: mtime(path) }))
    .filter((c): c is { path: string; time: number } => c.time !== null)
    .sort((a, b) => b.time - a.time)
    .map((c) => c.path);
}

/** The first runner that matches the path and does not ignore it. */
export function runnerFor(path: string, runners: readonly BurnInRunner[]): BurnInRunner | null {
  for (const runner of runners) {
    if (!matchesAny(path, runner.match)) continue;
    if (runner.ignore !== undefined && matchesAny(path, runner.ignore)) continue;
    return runner;
  }
  return null;
}

export interface BurnInGroup {
  runner: BurnInRunner;
  files: string[];
}

export interface BurnInPlan {
  groups: BurnInGroup[];
  /** Burnable files past maxFiles: listed, never silently dropped. */
  skipped: string[];
}

export function selectBurnIn(paths: readonly string[], config: ResolvedBurnIn): BurnInPlan {
  const byRunner = new Map<BurnInRunner, string[]>();
  const skipped: string[] = [];
  let kept = 0;
  for (const path of paths) {
    const runner = runnerFor(path, config.runners);
    if (runner === null) continue;
    if (kept >= config.maxFiles) {
      skipped.push(path);
      continue;
    }
    byRunner.set(runner, [...(byRunner.get(runner) ?? []), path]);
    kept += 1;
  }
  const groups = config.runners
    .filter((runner) => byRunner.has(runner))
    .map((runner) => ({ runner, files: byRunner.get(runner)! }));
  return { groups, skipped };
}

export interface BurnInCommand {
  runner: string;
  files: string[];
  command: string;
}

export function burnInCommands(plan: BurnInPlan, repeats: number): BurnInCommand[] {
  const out: BurnInCommand[] = [];
  for (const { runner, files } of plan.groups) {
    const produced = runner.command([...files], repeats);
    const commands = Array.isArray(produced) ? produced : [produced];
    const ok =
      commands.length > 0 && commands.every((c) => typeof c === 'string' && c.trim() !== '');
    if (!ok) {
      throw new BurnInError(
        `burnIn runner "${runner.name}": command() must return a non-empty command or a ` +
          `non-empty array of them`
      );
    }
    for (const command of commands) out.push({ runner: runner.name, files, command });
  }
  return out;
}
