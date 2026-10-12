import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';

// Steps hold gigabytes. Several agents in parallel worktrees running a suite at once swap
// the machine to death and produce spurious failures, and the contended resource is the
// machine, not the repo, so every chreode repo on the box shares ONE lock.
//
// A live holder refreshes the lock mtime every UPDATE; a holder that dies stops refreshing,
// so the lock goes stale after STALE and the next waiter steals it.
export const LOCK_STALE_MS = 30_000;
export const LOCK_UPDATE_MS = 10_000;
export const LOCK_POLL_MS = 2_000;
export const LOCK_MAX_WAIT_MS = 60 * 60_000;

export type Release = () => Promise<void>;

export interface MachineLock {
  /** Resolves to a release fn once held; while held elsewhere, logs once and polls. */
  acquire(): Promise<Release>;
}

export interface RetryingLockDeps {
  /** One attempt; must reject with an `ELOCKED`-coded error when held. */
  tryLock: () => Promise<Release>;
  label: string;
  lockPath: string;
  pollMs: number;
  maxWaitMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  /** One-line remedy appended to the timeout error. */
  hint?: string;
}

/** Poll-until-free around a one-shot lock. All I/O injected so the retry/log/timeout logic
 *  is testable without the filesystem or real timers. */
export function createRetryingLock(deps: RetryingLockDeps): MachineLock {
  return {
    async acquire(): Promise<Release> {
      const deadline = deps.now() + deps.maxWaitMs;
      let logged = false;
      for (;;) {
        try {
          return await deps.tryLock();
        } catch (err) {
          if ((err as { code?: string }).code !== 'ELOCKED') throw err;
          if (!logged) {
            deps.log(`[chreode] another run holds the ${deps.label} lock; waiting…`);
            logged = true;
          }
          if (deps.now() >= deadline) {
            const hint = deps.hint ? ` ${deps.hint}` : '';
            throw new Error(
              `[chreode] timed out after ${Math.round(deps.maxWaitMs / 60_000)}m waiting for ` +
                `the ${deps.label} lock (${deps.lockPath}).${hint}`,
              { cause: err }
            );
          }
          await deps.sleep(deps.pollMs);
        }
      }
    }
  };
}

/** proper-lockfile at a fixed path, with stale-steal. */
export function fileLock(opts: {
  label: string;
  lockPath: string;
  staleMs?: number;
  updateMs?: number;
  pollMs?: number;
  maxWaitMs?: number;
  hint?: string;
  log?: (msg: string) => void;
}): MachineLock {
  return createRetryingLock({
    tryLock: () =>
      lockfile.lock(opts.lockPath, {
        realpath: false, // the target need not exist; the lock is the `${lockPath}.lock` dir
        stale: opts.staleMs ?? LOCK_STALE_MS,
        update: opts.updateMs ?? LOCK_UPDATE_MS,
        retries: 0, // we own the retry loop so we can log once and bound the wait
        // The default handler throws from a timer: a stalled mtime refresh (laptop sleep) would crash
        // chreode uncaught and orphan the detached step group. Log and carry on instead.
        onCompromised: (err) => console.error(`[chreode] lock compromised: ${err.message}`)
      }),
    label: opts.label,
    lockPath: opts.lockPath,
    pollMs: opts.pollMs ?? LOCK_POLL_MS,
    maxWaitMs: opts.maxWaitMs ?? LOCK_MAX_WAIT_MS,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: opts.log ?? ((msg) => console.log(msg)),
    hint: opts.hint
  });
}

/** `CHREODE_LOCK_PATH` exists for test isolation: chreode's own suite runs `chreode signoff`
 *  while an outer signoff holds the real lock. */
export function defaultLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHREODE_LOCK_PATH || path.join(os.tmpdir(), 'chreode-signoff.lock');
}

export function signoffLock(env: NodeJS.ProcessEnv = process.env): MachineLock {
  return fileLock({
    label: 'signoff',
    lockPath: defaultLockPath(env),
    hint: 'The holder is another chreode signoff on this machine (any repo). Do not kill it; wait it out.'
  });
}
