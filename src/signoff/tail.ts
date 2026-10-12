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
  /** Policed steps that passed only because --allow-stderr waived their stderr. */
  allowedStderr: readonly string[];
  /** The --base ref as given, or null when the base came from the last signoff. */
  baseFlag: string | null;
  context: string;
}

/** Why this run must not become an incremental base: the note means "everything the
 *  changes since the last note needed passed", and a partial run cannot vouch for that. */
export function noteWithheldReasons(work: TailWork): string[] {
  return [
    ...(work.skippedByFlag.length > 0 ? [`--skip ${work.skippedByFlag.join(', ')}`] : []),
    ...(work.allowedStderr.length > 0
      ? [`--allow-stderr waived ${work.allowedStderr.join(', ')}`]
      : []),
    ...(work.baseFlag !== null ? [`--base ${work.baseFlag}`] : [])
  ];
}

/**
 * After every step passed: push, post the status, then write the note. The note is the
 * incremental cache ("this commit is signed off"), so it goes last: a failed post must not
 * leave a note that makes the next run a no-op with no status on GitHub. A partial run
 * (--skip, --base, or stderr waived by --allow-stderr) posts a status that says so but
 * writes no note, so the next signoff diffs from the last full one.
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
  effects.postStatus(
    work.sha,
    statusDescription(work.signer, {
      skipped: work.skippedByFlag,
      allowedStderr: work.allowedStderr,
      base: work.baseFlag
    })
  );
  log(`[chreode] ${work.context} = success posted on ${work.sha}`);
  const withheld = noteWithheldReasons(work);
  if (withheld.length === 0) {
    effects.writeNote(work.sha, work.ranLabels);
  } else {
    log(
      `[chreode] not writing the signoff note (partial run: ${withheld.join('; ')}); ` +
        `the next signoff diffs from the last full one`
    );
  }
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
