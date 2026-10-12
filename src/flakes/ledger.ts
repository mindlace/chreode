import type { ResolvedFlakes } from '../config/types.js';
import { dedupeEvents, type FlakeEvent } from './log.js';

export const FLAKE_LABEL = 'flake';
export const OCCURRENCE_MARKER = '<!-- chreode:flake-occurrence -->';
export const ISSUE_TITLE_MAX = 256;

export interface RunContext {
  branch: string;
  sha: string;
}

export interface FlakeIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

/** The GitHub side, injected: see gh.ts for the real one. */
export interface FlakeLedgerDeps {
  /** Open issues labelled FLAKE_LABEL. */
  listOpenFlakeIssues(): FlakeIssue[];
  /** Comments on the issue that carry OCCURRENCE_MARKER. */
  countOccurrenceComments(issue: number): number;
  /** Creates an issue labelled FLAKE_LABEL. */
  createIssue(title: string, body: string): FlakeIssue;
  commentIssue(issue: number, body: string): void;
}

export interface LedgerEntry {
  number: number;
  title: string;
  url: string;
  /** Occurrences so far: 1 (the issue) + marker comments. */
  count: number;
}

export interface LedgerResult {
  filed: LedgerEntry[];
  bumped: LedgerEntry[];
  escalations: LedgerEntry[];
}

export function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
}

/** A GitHub call failed partway: `partial` was recorded, `remaining` was not. */
export class LedgerError extends Error {
  constructor(
    readonly partial: LedgerResult,
    readonly remaining: FlakeEvent[],
    cause: unknown
  ) {
    super(firstLine(cause), { cause });
    this.name = 'LedgerError';
  }
}

export function issueTitle(event: FlakeEvent): string {
  return `flake(${event.kind}): ${event.file} › ${event.title}`.slice(0, ISSUE_TITLE_MAX).trimEnd();
}

function longestRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

/** Inline code span that survives backticks in `text`; keeps @mentions and #refs inert. */
function codeSpan(text: string): string {
  const fence = '`'.repeat(longestRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Fenced block whose fence is longer than any backtick run inside (minimum 3). */
function codeFence(text: string): string[] {
  const fence = '`'.repeat(Math.max(3, longestRun(text) + 1));
  return [fence, text, fence];
}

function details(event: FlakeEvent, ctx: RunContext): string {
  const where = event.project === '' ? event.runner : `${event.runner}, project ${event.project}`;
  return [
    `- **Test:** ${codeSpan(`${event.file} › ${event.title}`)} (${where})`,
    `- **Observed:** ${event.at} on \`${ctx.branch}\` @ ${event.sha ?? ctx.sha}`,
    ...(event.tracePath ? [`- **First-attempt trace:** \`${event.tracePath}\``] : []),
    '',
    '**First-attempt error:**',
    ...codeFence(event.firstAttemptError)
  ].join('\n');
}

export function issueBody(event: FlakeEvent, ctx: RunContext, config: ResolvedFlakes): string {
  return [
    'Filed by chreode flake tracking: this test failed, then passed on retry.',
    '',
    details(event, ctx),
    '',
    `A flake is a bug, not noise. Diagnose it with the playbook: ${config.playbookUrl}`,
    `At ${config.threshold} recorded occurrences it fails signoff until fixed; label this issue`,
    `\`${config.snoozeLabel}\` to defer that deliberately.`
  ].join('\n');
}

export function occurrenceBody(event: FlakeEvent, ctx: RunContext): string {
  return [OCCURRENCE_MARKER, '', 'Flaked again.', '', details(event, ctx)].join('\n');
}

/**
 * One open issue per flaking test (exact title match); each later sighting adds a marker
 * comment. An issue at `threshold` occurrences without the snooze label is an escalation.
 * Any GitHub failure throws LedgerError naming what was and was not recorded.
 */
export function processFlakeEvents(
  events: readonly FlakeEvent[],
  ctx: RunContext,
  config: ResolvedFlakes,
  deps: FlakeLedgerDeps
): LedgerResult {
  const result: LedgerResult = { filed: [], bumped: [], escalations: [] };
  const unique = dedupeEvents(events);
  if (unique.length === 0) return result;
  let open: FlakeIssue[];
  try {
    open = [...deps.listOpenFlakeIssues()];
  } catch (err) {
    throw new LedgerError(result, unique, err);
  }
  for (const [i, event] of unique.entries()) {
    try {
      const title = issueTitle(event);
      const existing = open.find((candidate) => candidate.title === title);
      let entry: LedgerEntry;
      let labels: string[];
      if (existing === undefined) {
        const created = deps.createIssue(title, issueBody(event, ctx, config));
        // A later event whose title truncates to the same string bumps this issue.
        open.push(created);
        entry = { number: created.number, title, url: created.url, count: 1 };
        labels = created.labels;
        result.filed.push(entry);
      } else {
        const prior = deps.countOccurrenceComments(existing.number);
        deps.commentIssue(existing.number, occurrenceBody(event, ctx));
        entry = { number: existing.number, title, url: existing.url, count: prior + 2 };
        labels = existing.labels;
        result.bumped.push(entry);
      }
      if (entry.count >= config.threshold && !labels.includes(config.snoozeLabel)) {
        result.escalations.push(entry);
      }
    } catch (err) {
      throw new LedgerError(result, unique.slice(i), err);
    }
  }
  return result;
}
