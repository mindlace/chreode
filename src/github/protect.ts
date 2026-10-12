import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/types.js';
import { isRecord } from '../config/validate.js';
import { defaultExec, type Exec } from '../run/exec.js';
import { repoInfo, type RepoInfo } from './status.js';

export const DEFAULT_BRANCH_PROTECTION: Record<string, unknown> = {
  enforce_admins: true,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    required_approving_review_count: 0
  },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
  required_linear_history: true,
  required_conversation_resolution: false
};

export const DEFAULT_REPO_SETTINGS: Record<string, unknown> = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'PR_BODY',
  delete_branch_on_merge: true
};

/** Defaults shallow-merged with config.protection; the status context is always required. */
export function protectionPayloads(config: ResolvedConfig): {
  branch: Record<string, unknown>;
  repo: Record<string, unknown>;
} {
  const override = config.protection.branch ?? {};
  const checks = isRecord(override.required_status_checks) ? override.required_status_checks : {};
  const extra = Array.isArray(checks.contexts)
    ? checks.contexts.filter((c): c is string => typeof c === 'string')
    : [];
  return {
    branch: {
      ...DEFAULT_BRANCH_PROTECTION,
      ...override,
      required_status_checks: {
        strict: true,
        ...checks,
        contexts: [...new Set([config.statusContext, ...extra])]
      }
    },
    repo: { ...DEFAULT_REPO_SETTINGS, ...(config.protection.repo ?? {}) }
  };
}

export interface ProtectDeps {
  exec: Exec;
  log: (m: string) => void;
  repo: () => RepoInfo;
}

/** Idempotently require the signoff status on the base branch and set squash-only merges. */
export function runProtect(
  config: ResolvedConfig,
  opts: { dryRun: boolean; repo: RepoInfo | null },
  overrides: Partial<ProtectDeps> = {}
): number {
  const d: ProtectDeps = {
    exec: defaultExec,
    log: (m) => console.log(m),
    repo: () => repoInfo(defaultExec),
    ...overrides
  };
  let repo = opts.repo;
  if (repo === null) {
    try {
      repo = d.repo();
    } catch (err) {
      if (!opts.dryRun) throw err;
      d.log('[chreode] gh repo view failed; showing payloads for <owner>/<repo>');
      repo = { owner: '<owner>', name: '<repo>' };
    }
  }
  const { branch, repo: settings } = protectionPayloads(config);
  const apply = (method: 'PUT' | 'PATCH', path: string, body: unknown) => {
    if (opts.dryRun) {
      d.log(`[dry-run] ${method} ${path}\n${JSON.stringify(body, null, 2)}`);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'chreode-protect-'));
    const file = join(dir, 'payload.json');
    writeFileSync(file, JSON.stringify(body));
    try {
      d.exec('gh', ['api', '-X', method, path, '--input', file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const target = `${repo.owner}/${repo.name}`;
  d.log(`[chreode] protecting ${target} ${config.baseBranch} (dry-run=${opts.dryRun})`);
  apply('PUT', `repos/${target}/branches/${config.baseBranch}/protection`, branch);
  apply('PATCH', `repos/${target}`, settings);
  d.log(`[chreode] ${config.baseBranch} now requires ${config.statusContext}`);
  return 0;
}
