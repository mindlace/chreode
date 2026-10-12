import { mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRetryingLock,
  defaultLockPath,
  fileLock,
  type Release,
  type RetryingLockDeps
} from './machine-lock.js';

const locked = () => Object.assign(new Error('held'), { code: 'ELOCKED' });

function harness(attempts: Array<'locked' | 'ok' | Error>, over: Partial<RetryingLockDeps> = {}) {
  let t = 0;
  const logs: string[] = [];
  const release: Release = async () => {};
  const deps: RetryingLockDeps = {
    tryLock: async () => {
      const next = attempts.shift() ?? 'locked';
      if (next === 'ok') return release;
      throw next === 'locked' ? locked() : next;
    },
    label: 'signoff',
    lockPath: '/tmp/x.lock',
    pollMs: 10,
    maxWaitMs: 100,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    log: (m) => logs.push(m),
    ...over
  };
  return { lock: createRetryingLock(deps), logs, release };
}

describe('createRetryingLock', () => {
  it('acquires immediately when free, logging nothing', async () => {
    const h = harness(['ok']);
    expect(await h.lock.acquire()).toBe(h.release);
    expect(h.logs).toEqual([]);
  });

  it('waits while held, logging the wait exactly once', async () => {
    const h = harness(['locked', 'locked', 'locked', 'ok']);
    expect(await h.lock.acquire()).toBe(h.release);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain('waiting');
  });

  it('gives up past maxWaitMs, naming the lock path and the hint', async () => {
    const h = harness([], { hint: 'Wait it out.' });
    await expect(h.lock.acquire()).rejects.toThrow(/\/tmp\/x\.lock.*Wait it out\./);
  });

  it('rethrows a non-ELOCKED error at once', async () => {
    const h = harness([new Error('EACCES')]);
    await expect(h.lock.acquire()).rejects.toThrow('EACCES');
    expect(h.logs).toEqual([]);
  });
});

describe('fileLock', () => {
  const lockPath = () => join(mkdtempSync(join(tmpdir(), 'chreode-lock-')), 'signoff.lock');
  const quiet = () => {};

  it('serializes two holders of the same path', async () => {
    const path = lockPath();
    const a = fileLock({ label: 't', lockPath: path, pollMs: 20, maxWaitMs: 5000, log: quiet });
    const b = fileLock({ label: 't', lockPath: path, pollMs: 20, maxWaitMs: 5000, log: quiet });
    const releaseA = await a.acquire();
    let bHeld = false;
    const pending = b.acquire().then((release) => {
      bHeld = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(bHeld).toBe(false);
    await releaseA();
    const releaseB = await pending;
    expect(bHeld).toBe(true);
    await releaseB();
  });

  it('steals a stale lock left by a crashed holder', async () => {
    const path = lockPath();
    mkdirSync(`${path}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    const release = await fileLock({
      label: 't',
      lockPath: path,
      staleMs: 5000,
      pollMs: 20,
      maxWaitMs: 2000,
      log: quiet
    }).acquire();
    expect(typeof release).toBe('function');
    await release();
  });
});

describe('defaultLockPath', () => {
  it('is one machine-global path in the OS temp dir', () => {
    expect(defaultLockPath({})).toBe(join(tmpdir(), 'chreode-signoff.lock'));
  });

  it('honors CHREODE_LOCK_PATH so tests never contend with a real signoff', () => {
    expect(defaultLockPath({ CHREODE_LOCK_PATH: '/tmp/test.lock' })).toBe('/tmp/test.lock');
  });
});
