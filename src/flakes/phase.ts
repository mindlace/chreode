import type { ResolvedFlakes } from '../config/types.js';
import {
  LedgerError,
  processFlakeEvents,
  type FlakeLedgerDeps,
  type LedgerEntry,
  type LedgerResult,
  type RunContext
} from './ledger.js';
import { clearFlakeLog, readFlakeEvents, writeFlakeEvents } from './log.js';

export interface FlakePhaseInput {
  logPath: string;
  ctx: RunContext;
  config: ResolvedFlakes;
  ledger: FlakeLedgerDeps;
  log: (m: string) => void;
  warn: (m: string) => void;
}

export type FlakePhaseOutcome =
  | { kind: 'none' }
  | { kind: 'reported'; result: LedgerResult }
  | { kind: 'gh-error'; message: string; partial: LedgerResult };

function printResult(result: LedgerResult, log: (m: string) => void): void {
  for (const f of result.filed) log(`[chreode] flake filed: ${f.url} ${f.title}`);
  for (const b of result.bumped) {
    log(`[chreode] flake seen again (${b.count} occurrences): ${b.url} ${b.title}`);
  }
}

/**
 * Report the logged flakes to the ledger. Recorded events leave the log; on a GitHub failure
 * the unrecorded ones stay for the next run (an outage must not block merging, and each event
 * keeps its own sha and time). Escalations are returned, not acted on: the caller decides.
 */
export function runFlakePhase(input: FlakePhaseInput): FlakePhaseOutcome {
  const events = readFlakeEvents(input.logPath);
  if (events.length === 0) return { kind: 'none' };
  input.log(`\n[chreode] flakes: ${events.length} retried-then-passed result(s) recorded`);
  let result: LedgerResult;
  try {
    result = processFlakeEvents(events, input.ctx, input.config, input.ledger);
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
    printResult(err.partial, input.log);
    writeFlakeEvents(input.logPath, err.remaining);
    input.warn(
      `[chreode] flakes: a GitHub call failed (${err.message}); kept ` +
        `${err.remaining.length} event(s) in ${input.logPath} for the next run`
    );
    return { kind: 'gh-error', message: err.message, partial: err.partial };
  }
  clearFlakeLog(input.logPath);
  printResult(result, input.log);
  return { kind: 'reported', result };
}

function dedupeEscalations(escalations: readonly LedgerEntry[]): LedgerEntry[] {
  const byIssue = new Map<number, LedgerEntry>();
  for (const e of escalations) {
    const seen = byIssue.get(e.number);
    if (!seen || e.count > seen.count) byIssue.set(e.number, e);
  }
  return [...byIssue.values()];
}

/** The failure text for escalated flakes; each issue is listed once, at its highest count. */
export function escalationMessage(
  escalations: readonly LedgerEntry[],
  config: ResolvedFlakes
): string {
  const unique = dedupeEscalations(escalations);
  return [
    `\n[chreode] FAILED: ${unique.length} flake(s) reached ${config.threshold} occurrences:`,
    ...unique.map((e) => `  ${e.url} (${e.count} occurrences) ${e.title}`),
    `[chreode] Fix each one (playbook: ${config.playbookUrl}), or label its issue`,
    `[chreode] ${config.snoozeLabel} to defer it deliberately.`
  ].join('\n');
}

/**
 * The single place a phase outcome becomes a pass/fail decision: the failure message when any
 * flake escalated (including ones recorded before a GitHub error), otherwise undefined.
 * Signoff and `flake-report` both call this.
 */
export function escalationFailure(
  outcome: FlakePhaseOutcome,
  config: ResolvedFlakes
): string | undefined {
  if (outcome.kind === 'none') return undefined;
  const result = outcome.kind === 'reported' ? outcome.result : outcome.partial;
  return result.escalations.length > 0 ? escalationMessage(result.escalations, config) : undefined;
}
