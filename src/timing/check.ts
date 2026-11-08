import { TIMING_RULE_IDS, type ResolvedTiming, type TimingAllowEntry } from '../config/types.js';
import { matchesAny } from '../signoff/plan.js';
import type { FileDiff } from './diff.js';
import { evaluateHunk, type Finding } from './rules.js';

export interface Violation extends Finding {
  path: string;
}

export interface UsedExemption {
  entry: TimingAllowEntry;
  violations: Violation[];
}

export interface TimingResult {
  checked: string[];
  violations: Violation[];
  exempted: UsedExemption[];
}

export function isTimingChecked(path: string, timing: ResolvedTiming): boolean {
  return matchesAny(path, timing.match) && !matchesAny(path, timing.perf);
}

function findExemption(v: Violation, allow: readonly TimingAllowEntry[]): TimingAllowEntry | null {
  for (const entry of allow) {
    if (entry.rule !== v.rule || !matchesAny(v.path, entry.path)) continue;
    if (entry.pattern) {
      entry.pattern.lastIndex = 0;
      if (!entry.pattern.test(v.text)) continue;
    }
    return entry;
  }
  return null;
}

export function checkTiming(files: readonly FileDiff[], timing: ResolvedTiming): TimingResult {
  const kept = files.filter((f) => isTimingChecked(f.path, timing));
  const rules = TIMING_RULE_IDS.filter((r) => !timing.disable.includes(r));
  const violations: Violation[] = [];
  const used = new Map<TimingAllowEntry, Violation[]>();
  for (const file of kept) {
    for (const hunk of file.hunks) {
      for (const finding of evaluateHunk(hunk, rules)) {
        const violation: Violation = { ...finding, path: file.path };
        const entry = findExemption(violation, timing.allow);
        if (entry) used.set(entry, [...(used.get(entry) ?? []), violation]);
        else violations.push(violation);
      }
    }
  }
  return {
    checked: kept.map((f) => f.path),
    violations,
    exempted: timing.allow
      .filter((e) => used.has(e))
      .map((e) => ({ entry: e, violations: used.get(e) ?? [] }))
  };
}
