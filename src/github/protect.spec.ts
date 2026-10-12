import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../config/types.js';
import type { Exec } from '../run/exec.js';
import { protectionPayloads, runProtect } from './protect.js';

const base: ResolvedConfig = {
  baseBranch: 'main',
  statusContext: 'chreode/signoff',
  rules: [],
  steps: [],
  afterMerge: null,
  stderrAllowlist: [],
  protection: {},
  flakes: null,
  burnIn: null
};

describe('protectionPayloads', () => {
  it('requires the status context, strict, with the default policy', () => {
    const { branch, repo } = protectionPayloads(base);
    expect(branch).toMatchObject({
      required_status_checks: { strict: true, contexts: ['chreode/signoff'] },
      enforce_admins: true,
      required_linear_history: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        required_approving_review_count: 0
      }
    });
    expect(repo).toMatchObject({
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true
    });
  });

  it('merges overrides but always keeps the status context', () => {
    const { branch, repo } = protectionPayloads({
      ...base,
      protection: {
        branch: {
          enforce_admins: false,
          required_status_checks: { contexts: ['ci/build', 'chreode/signoff'] }
        },
        repo: { delete_branch_on_merge: false }
      }
    });
    expect(branch.enforce_admins).toBe(false);
    expect(branch.required_status_checks).toEqual({
      strict: true,
      contexts: ['chreode/signoff', 'ci/build']
    });
    expect(repo.delete_branch_on_merge).toBe(false);
  });
});

describe('runProtect', () => {
  it('--dry-run prints both payloads and calls no gh api', () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const exec: Exec = (file, args) => {
      calls.push([file, ...args].join(' '));
      return '';
    };
    const code = runProtect(
      base,
      { dryRun: true, repo: { owner: 'acme', name: 'widget' } },
      {
        exec,
        log: (m) => void logs.push(m)
      }
    );
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(logs.join('\n')).toContain('PUT repos/acme/widget/branches/main/protection');
    expect(logs.join('\n')).toContain('PATCH repos/acme/widget');
  });

  it('applies the branch protection and the repo settings through gh api', () => {
    const calls: { args: string[]; body: unknown }[] = [];
    const exec: Exec = (file, args) => {
      const i = args.indexOf('--input');
      calls.push({
        args: [file, ...args.slice(0, i)],
        body: JSON.parse(readFileSync(args[i + 1]!, 'utf8'))
      });
      return '{}';
    };
    runProtect(
      base,
      { dryRun: false, repo: { owner: 'acme', name: 'widget' } },
      {
        exec,
        log: () => {}
      }
    );
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'gh api -X PUT repos/acme/widget/branches/main/protection',
      'gh api -X PATCH repos/acme/widget'
    ]);
    expect(calls[0]!.body).toMatchObject({
      required_status_checks: { contexts: ['chreode/signoff'] }
    });
  });
});
