import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { stripAnsi } from '../run/stderr.js';

/** One retried-then-passed test, as a reporter saw it. */
export interface FlakeEvent {
  /** Issue-title bucket, e.g. 'e2e', 'unit', 'client'. */
  kind: string;
  runner: 'playwright' | 'vitest';
  /** Runner project name ('' if none). */
  project: string;
  /** Repo-relative, '/'-separated. */
  file: string;
  /** Describe chain joined with ' › '. */
  title: string;
  /** At most ERROR_LINE_CAP lines, ANSI-stripped. */
  firstAttemptError: string;
  /** Playwright trace of the failed attempt. */
  tracePath?: string;
  /** CHREODE_HEAD when run under signoff. */
  sha?: string;
  /** ISO timestamp. */
  at: string;
}

/** Repo-relative. Not under test-results/: Playwright wipes its outputDir at start and would
 *  delete events an earlier vitest step wrote. */
export const FLAKE_LOG_FILE = '.chreode/flakes.jsonl';
export const ERROR_LINE_CAP = 40;

export function flakeLogPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const fromEnv = env.CHREODE_FLAKE_LOG;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(cwd, FLAKE_LOG_FILE);
}

/** jsonl, append-only: sequential writer processes in one run never clobber each other. */
export function appendFlakeEvent(event: FlakeEvent, logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

const REQUIRED = ['kind', 'runner', 'project', 'file', 'title', 'firstAttemptError', 'at'] as const;

function isFlakeEvent(v: unknown): v is FlakeEvent {
  if (typeof v !== 'object' || v === null) return false;
  const record = v as Record<string, unknown>;
  return REQUIRED.every((key) => typeof record[key] === 'string');
}

export function readFlakeEvents(logPath: string): FlakeEvent[] {
  if (!existsSync(logPath)) return [];
  const events: FlakeEvent[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isFlakeEvent(parsed)) events.push(parsed);
    } catch {
      // An interrupted write: skip it rather than fail the report.
    }
  }
  return events;
}

export function clearFlakeLog(logPath: string): void {
  rmSync(logPath, { force: true });
}

export function writeFlakeEvents(logPath: string, events: readonly FlakeEvent[]): void {
  if (events.length === 0) {
    clearFlakeLog(logPath);
    return;
  }
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

export function flakeKey(event: FlakeEvent): string {
  return `${event.kind}/${event.file}/${event.title}`;
}

/** One report per test per run: the same flake seen in two projects counts once. */
export function dedupeEvents(events: readonly FlakeEvent[]): FlakeEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const key = flakeKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function truncateError(message: string | undefined): string {
  if (message === undefined || message === '') return '(first attempt error unavailable)';
  return stripAnsi(message).split('\n').slice(0, ERROR_LINE_CAP).join('\n');
}

/** The nearest ancestor holding `.git`: a directory in a checkout, a file in a worktree. */
export function findRepoRoot(
  start: string,
  exists: (path: string) => boolean = existsSync
): string | null {
  let dir = start;
  for (;;) {
    if (exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Relative to the git root found from the file itself, so a runner started in a subpackage
 *  still yields repo paths; '/'-separated. */
export function repoRelative(
  file: string,
  cwd: string = process.cwd(),
  exists: (path: string) => boolean = existsSync
): string {
  const root = findRepoRoot(dirname(file), exists) ?? cwd;
  return relative(root, file).split(sep).join('/');
}
