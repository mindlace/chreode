import { defaultExec, type Exec } from '../run/exec.js';

/** GitHub rejects longer descriptions with a 422; truncate rather than fail the post. */
export const STATUS_DESCRIPTION_MAX = 140;

/** Honest about --skip, so a skipped required step cannot wear the same green as a full run. */
export function statusDescription(signer: string, skipped: readonly string[]): string {
  const desc =
    skipped.length === 0
      ? `signed off by ${signer}`
      : `signed off by ${signer} (skipped: ${skipped.join(', ')})`;
  if (desc.length <= STATUS_DESCRIPTION_MAX) return desc;
  return `${desc.slice(0, STATUS_DESCRIPTION_MAX - 3)}...`;
}

export interface RepoInfo {
  owner: string;
  name: string;
}

export function parseRepo(s: string): RepoInfo {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) throw new Error(`repo must look like owner/name, got "${s}"`);
  return { owner: m[1]!, name: m[2]! };
}

export function repoInfo(exec: Exec = defaultExec): RepoInfo {
  const parsed = JSON.parse(exec('gh', ['repo', 'view', '--json', 'owner,name'])) as {
    owner: { login: string };
    name: string;
  };
  return { owner: parsed.owner.login, name: parsed.name };
}

export function statusArgs(
  repo: RepoInfo,
  sha: string,
  context: string,
  description: string
): string[] {
  return [
    'api',
    '-X',
    'POST',
    `repos/${repo.owner}/${repo.name}/statuses/${sha}`,
    '-f',
    'state=success',
    '-f',
    `context=${context}`,
    '-f',
    `description=${description}`
  ];
}

export function postStatus(
  repo: RepoInfo,
  sha: string,
  context: string,
  description: string,
  exec: Exec = defaultExec
): void {
  exec('gh', statusArgs(repo, sha, context, description));
}

export function prUrl(exec: Exec = defaultExec): string | null {
  try {
    return (JSON.parse(exec('gh', ['pr', 'view', '--json', 'url'])) as { url: string }).url;
  } catch {
    return null;
  }
}
