import { writeNote } from '../git/change-set.js';
import { postStatus, prUrl, statusDescription, type RepoInfo } from '../github/status.js';
import { defaultExec, defaultRun, type Exec, type Run } from '../run/exec.js';

export interface TailEffects {
  push(): void;
  postStatus(sha: string, description: string): void;
  writeNote(sha: string, ranLabels: readonly string[]): void;
  prUrl(): string | null;
}

export interface TailWork {
  sha: string;
  signer: string;
  noPush: boolean;
  ranLabels: readonly string[];
  skippedByFlag: readonly string[];
  context: string;
}

/**
 * After every step passed: push, post the status, then write the note. The note is the
 * incremental cache ("this commit is signed off"), so it goes last: a failed post must not
 * leave a note that makes the next run a no-op with no status on GitHub.
 */
export function runTail(
  work: TailWork,
  effects: TailEffects,
  log: (m: string) => void = (m) => console.log(m)
): void {
  if (work.noPush) {
    log('[chreode] --no-push: not pushing (the commit must already be on origin)');
  } else {
    log('\n[chreode] git push -u origin HEAD');
    effects.push();
  }
  effects.postStatus(work.sha, statusDescription(work.signer, work.skippedByFlag));
  log(`[chreode] ${work.context} = success posted on ${work.sha}`);
  effects.writeNote(work.sha, work.ranLabels);
  const url = effects.prUrl();
  if (url) log(`[chreode] PR: ${url}`);
}

export function defaultTailEffects(
  repo: () => RepoInfo,
  context: string,
  exec: Exec = defaultExec,
  run: Run = defaultRun
): TailEffects {
  return {
    push: () => run('git push -u origin HEAD'),
    postStatus: (sha, description) => postStatus(repo(), sha, context, description, exec),
    writeNote: (sha, labels) => writeNote(sha, labels, exec),
    prUrl: () => prUrl(exec)
  };
}
