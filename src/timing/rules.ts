import type { TimingRuleId } from '../config/types.js';
import type { Hunk } from './diff.js';
import { retriesRaise, timeoutRaise } from './values.js';

export interface Finding {
  rule: TimingRuleId;
  line: number;
  text: string;
  was?: string;
}

export function isComment(text: string): boolean {
  const t = text.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

/**
 * Counts non-comment matching lines among removed (R) and added (A) and returns the last
 * max(0, A - R) matching added lines, so reformatting an existing line is not a new one.
 */
export function netNew(
  hunk: Hunk,
  rule: TimingRuleId,
  matches: (text: string) => boolean
): Finding[] {
  const removed = hunk.removed.filter((t) => !isComment(t) && matches(t)).length;
  const added = hunk.added.filter((a) => !isComment(a.text) && matches(a.text));
  const excess = Math.max(0, added.length - removed);
  if (excess === 0) return [];
  return added.slice(added.length - excess).map((a) => ({
    rule,
    line: a.line,
    text: a.text.trim()
  }));
}

const FAKE_TIMER =
  /\bvi\.advanceTimersByTime(?:Async)?\b|\bvi\.runAllTimers\b|\bclock\.tick\b|\.clock\./;

const FIXED_WAIT = [
  /\bwaitForTimeout\(/,
  /\bnew Promise\(.*\bsetTimeout\(/,
  /\bsleep\(/,
  /\bdelay\(/,
  /\bwait\(\s*\d/
];

export function isFixedWait(text: string): boolean {
  if (FAKE_TIMER.test(text)) return false;
  return FIXED_WAIT.some((re) => re.test(text));
}

const SKIP = [
  /\b(?:test|it|describe)\.skip\(\s*(?:['"`]|\))/,
  /\btest\.fixme\(\s*(?:['"`]|\))/,
  /\btest\.describe\.(?:skip|fixme)\(/,
  /\b(?:xit|xtest|xdescribe)\(/
];

export function isSkip(text: string): boolean {
  return SKIP.some((re) => re.test(text));
}

export function evaluateHunk(hunk: Hunk, rules: readonly TimingRuleId[]): Finding[] {
  const found: { finding: Finding; order: number }[] = [];
  rules.forEach((rule, order) => {
    let findings: Finding[] = [];
    if (rule === 'fixed-wait') findings = netNew(hunk, rule, isFixedWait);
    else if (rule === 'timeout-raise') findings = timeoutRaise(hunk);
    else if (rule === 'retries-raise') findings = retriesRaise(hunk);
    else if (rule === 'skip') findings = netNew(hunk, rule, isSkip);
    for (const finding of findings) found.push({ finding, order });
  });
  found.sort((a, b) => a.finding.line - b.finding.line || a.order - b.order);
  return found.map((f) => f.finding);
}
