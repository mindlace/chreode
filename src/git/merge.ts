import { defaultExec, type Exec } from '../run/exec.js';

export type MergeOutcome =
  | { kind: 'skipped' }
  | { kind: 'up-to-date' }
  | { kind: 'merged' }
  | { kind: 'conflict' }
  | { kind: 'failed'; message: string };

/**
 * Fold the latest origin/<baseBranch> into the branch so what is signed off is what will
 * land. Merge, never rebase: existing SHAs (and their notes) survive and the push stays a
 * fast-forward. On conflict the merge is left in progress for the user to resolve.
 */
export function mergeBaseBranch(
  baseBranch: string,
  opts: { noMerge: boolean },
  exec: Exec = defaultExec,
  warn: (m: string) => void = (m) => console.warn(m)
): MergeOutcome {
  if (opts.noMerge) return { kind: 'skipped' };
  const upstream = `origin/${baseBranch}`;
  try {
    exec('git', ['fetch', 'origin', baseBranch]);
  } catch (err) {
    warn(
      `[chreode] git fetch origin ${baseBranch} failed (${(err as Error).message.trim()}); ` +
        `continuing with the local view of ${upstream}`
    );
  }
  if (exec('git', ['rev-list', `HEAD..${upstream}`]).trim() === '') return { kind: 'up-to-date' };
  try {
    exec('git', ['merge', '--no-edit', upstream]);
  } catch (err) {
    try {
      exec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
      return { kind: 'conflict' };
    } catch {
      return { kind: 'failed', message: (err as Error).message.trim() };
    }
  }
  return { kind: 'merged' };
}
