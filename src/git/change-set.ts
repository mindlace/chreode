import { defaultExec, lines, type Exec } from '../run/exec.js';

/** Successful signoffs are recorded as notes under refs/notes/chreode. */
export const NOTES_REF = 'chreode';

export interface BaseInfo {
  base: string;
  head: string;
  source: 'note' | 'merge-base';
}

export function hasNote(sha: string, exec: Exec = defaultExec): boolean {
  try {
    exec('git', ['notes', `--ref=${NOTES_REF}`, 'show', sha]);
    return true;
  } catch {
    return false;
  }
}

/** The nearest commit on this branch (not on origin/<baseBranch>) carrying a signoff note;
 *  else the merge-base with origin/<baseBranch>. */
export function resolveBase(baseBranch: string, exec: Exec = defaultExec): BaseInfo {
  const head = exec('git', ['rev-parse', 'HEAD']).trim();
  const upstream = `origin/${baseBranch}`;
  for (const sha of lines(exec('git', ['rev-list', '--topo-order', 'HEAD', `^${upstream}`]))) {
    if (hasNote(sha, exec)) return { base: sha, head, source: 'note' };
  }
  return { base: exec('git', ['merge-base', 'HEAD', upstream]).trim(), head, source: 'merge-base' };
}

export function resolveRef(ref: string, exec: Exec = defaultExec): string {
  return exec('git', ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

/** Paths changed between base and head. --no-renames lists both sides of a rename, so a
 *  file moved out of a rule's reach still fires that rule; deletions are included. */
export function committedPaths(base: string, head: string, exec: Exec = defaultExec): string[] {
  if (base === head) return [];
  return lines(exec('git', ['diff', '--name-only', '--no-renames', `${base}..${head}`]));
}

export function isWorktree(exec: Exec = defaultExec): boolean {
  const [gitDir, commonDir] = lines(
    exec('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  );
  return gitDir !== commonDir;
}

export function writeNote(
  sha: string,
  ranLabels: readonly string[],
  exec: Exec = defaultExec
): void {
  const summary = ranLabels.length > 0 ? ranLabels.join(' ') : 'no-op';
  exec('git', ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-m', summary, sha]);
}
