import { appendFlakeEvent, flakeLogPath, type FlakeEvent } from '../flakes/log.js';

export interface FlakeReporterOptions {
  /** Issue-title bucket: fixed, or derived from the runner project name. */
  kind?: string | ((project: string) => string);
  /** Record only these runner projects (default: all). */
  projects?: string[];
  /** Where events go (default: appended to the flake log). A seam for tests. */
  append?: (event: FlakeEvent) => void;
}

export function resolveKind(
  kind: FlakeReporterOptions['kind'],
  project: string,
  fallback: string
): string {
  if (typeof kind === 'function') return kind(project);
  return kind ?? fallback;
}

export function wants(projects: readonly string[] | undefined, project: string): boolean {
  return projects === undefined || projects.includes(project);
}

/** The sha under test when running under signoff. */
export function headSha(env: NodeJS.ProcessEnv = process.env): { sha?: string } {
  const sha = env.CHREODE_HEAD;
  return sha ? { sha } : {};
}

/** Resolved at write time, so CHREODE_FLAKE_LOG set by signoff is honoured. */
export function defaultAppend(event: FlakeEvent): void {
  appendFlakeEvent(event, flakeLogPath());
}
