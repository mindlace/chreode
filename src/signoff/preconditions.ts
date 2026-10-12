import { FLAKE_LOG_FILE } from '../flakes/log.js';
import { defaultExec, type Exec } from '../run/exec.js';

export class PreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreconditionError';
  }
}

export interface Preconditions {
  branch: string;
  /** git user.email: named in the status description. */
  signer: string;
}

export function checkPreconditions(
  baseBranch: string,
  exec: Exec = defaultExec,
  opts: { flakes: boolean } = { flakes: false }
): Preconditions {
  if (exec('git', ['status', '--porcelain']).trim() !== '') {
    throw new PreconditionError('working tree is dirty; commit or stash before signing off');
  }
  let branch: string;
  try {
    branch = exec('git', ['symbolic-ref', '-q', '--short', 'HEAD']).trim();
  } catch {
    throw new PreconditionError('HEAD is detached; check out a branch before signing off');
  }
  if (branch === baseBranch) {
    throw new PreconditionError(
      `on ${baseBranch} itself; signoff is for branches that merge into ${baseBranch}`
    );
  }
  let behind = '';
  try {
    behind = exec('git', ['rev-list', 'HEAD..@{u}']).trim();
  } catch {
    // No upstream yet: nothing to be behind.
  }
  if (behind !== '') {
    throw new PreconditionError('HEAD is behind its upstream; pull before signing off');
  }
  if (opts.flakes) {
    try {
      exec('git', ['check-ignore', '-q', FLAKE_LOG_FILE]);
    } catch {
      throw new PreconditionError(
        '`flakes` is configured but .chreode/ is not gitignored (the flake log would dirty ' +
          'the tree); add the line `.chreode/` to .gitignore'
      );
    }
  }
  try {
    exec('gh', ['auth', 'status']);
  } catch {
    throw new PreconditionError('gh is not authenticated; run `gh auth login`');
  }
  let signer = '';
  try {
    signer = exec('git', ['config', 'user.email']).trim();
  } catch {
    // Reported below.
  }
  if (signer === '') {
    throw new PreconditionError(
      'git config user.email is unset; the status description names the signer'
    );
  }
  return { branch, signer };
}
