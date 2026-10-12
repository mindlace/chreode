import { describe, expect, it } from 'vitest';
import { fakeExec, type Response } from '../../test/support/fake-exec.js';
import type { ResolvedConfig } from '../config/types.js';
import type { MachineLock } from '../lock/machine-lock.js';
import { StepFailure, type StepOutcome } from '../run/step.js';
import { runSignoff, type SignoffDeps, type SignoffOptions } from './run.js';
import type { TailEffects } from './tail.js';

const CONFIG: ResolvedConfig = {
  baseBranch: 'main',
  statusContext: 'chreode/signoff',
  afterMerge: null,
  stderrAllowlist: [],
  protection: {},
  flakes: null,
  burnIn: null,
  rules: [
    { match: 'docs/**', triggers: [] },
    { match: 'src/**', triggers: ['lint'] }
  ],
  steps: [
    {
      label: 'lint',
      run: 'npm run lint',
      when: ['lint'],
      supersededBy: [],
      policeStderr: false,
      timeoutMs: 1000
    }
  ]
};

const OPTS: SignoffOptions = {
  full: false,
  dryRun: false,
  noMerge: true,
  noPush: false,
  allowStderr: false,
  base: null,
  skip: []
};

const load = (config: ResolvedConfig) => async () => config;

const MERGED: Record<string, Response> = {
  'git fetch origin main': '',
  'git rev-list HEAD..origin/main': 'abc\n',
  'git merge --no-edit origin/main': ''
};

function scripted(over: Record<string, Response> = {}) {
  return fakeExec({
    'git status --porcelain': '',
    'git symbolic-ref -q --short HEAD': 'feature\n',
    'git rev-list HEAD..@{u}': new Error('no upstream'),
    'gh auth status': '',
    'git config user.email': 'me@example.com\n',
    'git rev-parse HEAD': 'h\n',
    'git rev-list --topo-order HEAD ^origin/main': '',
    'git merge-base HEAD origin/main': 'b\n',
    'git rev-parse --verify b^{commit}': 'b\n',
    'git rev-parse --verify h^{commit}': 'h\n',
    'git rev-parse --path-format=absolute --git-dir --git-common-dir': '/r/.git\n/r/.git\n',
    'git diff --name-only --no-renames -z b..h': 'src/x.ts\0',
    ...over
  });
}

function harness(
  over: Record<string, Response> = {},
  failStep = false,
  outcome: StepOutcome = 'passed'
) {
  const events: string[] = [];
  const errors: string[] = [];
  const { exec, calls } = scripted(over);
  const lock: MachineLock = {
    acquire: async () => {
      events.push('acquire');
      return async () => void events.push('release');
    }
  };
  const tail: TailEffects = {
    push: () => void events.push('push'),
    postStatus: (sha, d) => void events.push(`status ${sha} ${d}`),
    writeNote: (sha, labels) => void events.push(`note ${sha} ${JSON.stringify(labels)}`),
    prUrl: () => null
  };
  const deps: Partial<SignoffDeps> = {
    exec,
    run: () => {},
    lock,
    tail,
    runStep: async (s) => {
      events.push(`run ${s.label}`);
      if (failStep) throw new StepFailure(s.label, 'failed');
      return outcome;
    },
    log: () => {},
    warn: () => {},
    error: (m) => void errors.push(m)
  };
  return { events, errors, calls, deps };
}

describe('runSignoff', () => {
  it('runs the plan under the lock, then pushes, posts and notes', async () => {
    const h = harness();
    expect(await runSignoff(load(CONFIG), OPTS, h.deps)).toBe(0);
    expect(h.events).toEqual([
      'acquire',
      'run lint',
      'release',
      'push',
      'status h signed off by me@example.com',
      'note h ["lint"]'
    ]);
  });

  it('an empty plan touches no lock and still signs off as a no-op', async () => {
    const h = harness({ 'git diff --name-only --no-renames -z b..h': 'docs/a.md\0' });
    expect(await runSignoff(load(CONFIG), OPTS, h.deps)).toBe(0);
    expect(h.events).toEqual(['push', 'status h signed off by me@example.com', 'note h []']);
  });

  it('a failing step exits 1, releases the lock, and posts nothing', async () => {
    const h = harness({}, true);
    expect(await runSignoff(load(CONFIG), OPTS, h.deps)).toBe(1);
    expect(h.events).toEqual(['acquire', 'run lint', 'release']);
  });

  it('--dry-run plans and stops: no lock, no tail', async () => {
    const h = harness();
    expect(await runSignoff(load(CONFIG), { ...OPTS, dryRun: true }, h.deps)).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('refuses to post when the steps dirtied the tree', async () => {
    const h = harness({ 'git status --porcelain': ['', ' M package-lock.json\n'] });
    expect(await runSignoff(load(CONFIG), OPTS, h.deps)).toBe(1);
    expect(h.events).toEqual(['acquire', 'run lint', 'release']);
    expect(h.errors.join('\n')).toContain('Nothing was posted');
  });

  it('a failed precondition exits 1 before merging', async () => {
    const h = harness({ 'git status --porcelain': ' M x\n' });
    expect(await runSignoff(load(CONFIG), { ...OPTS, noMerge: false }, h.deps)).toBe(1);
    expect(h.calls.some((c) => c.startsWith('git fetch'))).toBe(false);
  });

  it('a merge conflict exits 1 and runs nothing', async () => {
    const h = harness({
      'git fetch origin main': '',
      'git rev-list HEAD..origin/main': 'abc\n',
      'git merge --no-edit origin/main': new Error('CONFLICT'),
      'git rev-parse -q --verify MERGE_HEAD': 'abc\n'
    });
    expect(await runSignoff(load(CONFIG), { ...OPTS, noMerge: false }, h.deps)).toBe(1);
    expect(h.events).toEqual([]);
    expect(h.errors.join('\n')).toContain('conflict');
  });

  it('nothing between base and HEAD exits 0 without running or posting', async () => {
    const h = harness();
    expect(await runSignoff(load(CONFIG), { ...OPTS, base: 'h' }, h.deps)).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('an unknown --skip label exits 1', async () => {
    const h = harness();
    expect(await runSignoff(load(CONFIG), { ...OPTS, skip: ['lnt'] }, h.deps)).toBe(1);
    expect(h.events).toEqual([]);
  });

  it('refuses to post when HEAD moved during the steps', async () => {
    const h = harness({ 'git rev-parse HEAD': ['h\n', 'other\n'] });
    expect(await runSignoff(load(CONFIG), OPTS, h.deps)).toBe(1);
    expect(h.events).toEqual(['acquire', 'run lint', 'release']);
    expect(h.errors.join('\n')).toContain('Nothing was posted');
  });

  it('refuses to run when afterMerge dirtied the tree', async () => {
    const h = harness({
      'git fetch origin main': '',
      'git rev-list HEAD..origin/main': 'abc\n',
      'git merge --no-edit origin/main': '',
      'git status --porcelain': ['', ' M package-lock.json\n']
    });
    const config = { ...CONFIG, afterMerge: 'npm install' };
    expect(await runSignoff(load(config), { ...OPTS, noMerge: false }, h.deps)).toBe(1);
    expect(h.events).toEqual([]);
    expect(h.errors.join('\n')).toContain('afterMerge');
  });

  describe('a partial run posts but writes no note', () => {
    it('--skip', async () => {
      const h = harness();
      expect(await runSignoff(load(CONFIG), { ...OPTS, skip: ['lint'] }, h.deps)).toBe(0);
      expect(h.events).toEqual(['push', 'status h signed off by me@example.com (skipped: lint)']);
    });

    it('--base', async () => {
      const h = harness();
      expect(await runSignoff(load(CONFIG), { ...OPTS, base: 'b' }, h.deps)).toBe(0);
      expect(h.events).toEqual([
        'acquire',
        'run lint',
        'release',
        'push',
        'status h signed off by me@example.com (base=b)'
      ]);
    });

    it('--allow-stderr that let a step pass', async () => {
      const h = harness({}, false, 'allowed-stderr');
      expect(await runSignoff(load(CONFIG), { ...OPTS, allowStderr: true }, h.deps)).toBe(0);
      expect(h.events).toEqual([
        'acquire',
        'run lint',
        'release',
        'push',
        'status h signed off by me@example.com (allowed stderr: lint)'
      ]);
    });
  });

  describe('after a merge', () => {
    const MERGED_CONFIG: ResolvedConfig = {
      ...CONFIG,
      rules: [{ match: 'src/**', triggers: ['unit'] }],
      steps: [{ ...CONFIG.steps[0]!, label: 'unit', run: 'npm test', when: ['unit'] }]
    };

    it('plans with the config the merge brought in', async () => {
      const h = harness(MERGED);
      const loads: ResolvedConfig[] = [CONFIG, MERGED_CONFIG];
      const loader = async () => loads.shift()!;
      expect(await runSignoff(loader, { ...OPTS, noMerge: false }, h.deps)).toBe(0);
      expect(loads).toEqual([]);
      expect(h.events).toContain('run unit');
      expect(h.events).not.toContain('run lint');
    });

    it('does not reload when nothing was merged', async () => {
      const h = harness();
      let n = 0;
      const loader = async () => {
        n += 1;
        return CONFIG;
      };
      expect(await runSignoff(loader, OPTS, h.deps)).toBe(0);
      expect(n).toBe(1);
    });

    it('a merged config that fails to load exits 1 and runs nothing', async () => {
      const h = harness(MERGED);
      const loads: Array<() => ResolvedConfig> = [
        () => CONFIG,
        () => {
          throw new Error('steps[0].label must be a string');
        }
      ];
      const loader = async () => loads.shift()!();
      expect(await runSignoff(loader, { ...OPTS, noMerge: false }, h.deps)).toBe(1);
      expect(h.events).toEqual([]);
      expect(h.errors.join('\n')).toContain('steps[0].label must be a string');
    });
  });
});
