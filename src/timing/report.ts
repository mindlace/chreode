import type { TimingResult } from './check.js';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function formatTimingReport(result: TimingResult, playbookUrl: string): string[] {
  const out: string[] = [];
  const { violations } = result;
  if (violations.length > 0) {
    const files = new Set(violations.map((v) => v.path)).size;
    out.push(
      `[chreode] timing: ${plural(violations.length, 'violation', 'violations')} in ${plural(files, 'file', 'files')}`
    );
    const locs = violations.map((v) => `${v.path}:${v.line}`);
    const locWidth = Math.max(...locs.map((l) => l.length));
    const ruleWidth = Math.max(...violations.map((v) => v.rule.length));
    violations.forEach((v, i) => {
      const was = v.was === undefined ? '' : `  (was ${v.was})`;
      out.push(`  ${locs[i].padEnd(locWidth)}  ${v.rule.padEnd(ruleWidth)}  ${v.text}${was}`);
    });
    out.push(
      `  Fix: ${playbookUrl}#the-playbook — add a readiness signal or drive the deferred work.`
    );
    out.push('  Exempt only with a reviewed timing.allow entry in chreode.config.ts.');
  } else if (result.checked.length === 0) {
    out.push('[chreode] timing: no test files changed; nothing to check');
  } else {
    out.push(
      `[chreode] timing: no timing crutches added in ${result.checked.length} checked file(s)`
    );
  }
  if (result.exempted.length > 0) {
    out.push('[chreode] timing: exempted by timing.allow:');
    for (const { entry, violations: vs } of result.exempted) {
      const files = [...new Set(vs.map((v) => v.path))].join(', ');
      out.push(`  ${entry.rule}  ${vs.length} line(s) in ${files}: ${entry.reason}`);
    }
  }
  return out;
}
