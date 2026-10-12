import picomatch from 'picomatch';
import type {
  Matcher,
  ResolvedConfig,
  ResolvedStep,
  RuleConfig,
  StepContext
} from '../config/types.js';

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export interface PlanInput {
  paths: readonly string[];
  full: boolean;
  skip: readonly string[];
  base: string;
  head: string;
  isWorktree: boolean;
}

export interface PlannedStep {
  label: string;
  command: string;
  policeStderr: boolean;
  timeoutMs: number;
}

export type SkipReason =
  | { kind: 'not-triggered' }
  | { kind: 'if-false' }
  | { kind: 'skip-flag' }
  | { kind: 'superseded'; by: string };

export interface Plan {
  triggers: string[];
  /** Changed paths no rule matched; each one fired every trigger. */
  unmatched: string[];
  steps: PlannedStep[];
  skipped: { label: string; reason: SkipReason }[];
  /** Steps that would have run but for --skip: these go in the status description. */
  skippedByFlag: string[];
}

function tester(m: Matcher): (path: string) => boolean {
  if (typeof m === 'string') return picomatch(m, { dot: true });
  return (path) => {
    // A /g or /y RegExp carries lastIndex between calls; reset so every path is tested fresh.
    m.lastIndex = 0;
    return m.test(path);
  };
}

export function matchesAny(path: string, matchers: Matcher | Matcher[]): boolean {
  return (Array.isArray(matchers) ? matchers : [matchers]).some((m) => tester(m)(path));
}

export function matchRule(path: string, rules: readonly RuleConfig[]): RuleConfig | null {
  for (const rule of rules) {
    if (matchesAny(path, rule.match)) return rule;
  }
  return null;
}

export function allTriggers(steps: readonly ResolvedStep[]): string[] {
  return [...new Set(steps.flatMap((s) => s.when))].sort();
}

/** Rules can only make a run smaller by matching: an unmatched path fires everything. */
export function fireTriggers(
  paths: readonly string[],
  rules: readonly RuleConfig[],
  steps: readonly ResolvedStep[]
): { triggers: string[]; unmatched: string[] } {
  const fired = new Set<string>();
  const unmatched: string[] = [];
  for (const path of paths) {
    const rule = matchRule(path, rules);
    const triggers = rule === null ? allTriggers(steps) : rule.triggers;
    if (rule === null) unmatched.push(path);
    for (const t of triggers) fired.add(t);
  }
  return { triggers: [...fired].sort(), unmatched };
}

export function planSignoff(config: ResolvedConfig, input: PlanInput): Plan {
  const known = config.steps.map((s) => s.label);
  const unknownSkips = input.skip.filter((l) => !known.includes(l));
  if (unknownSkips.length > 0) {
    throw new PlanError(
      `--skip names unknown step(s): ${unknownSkips.join(', ')} (known: ${known.join(', ')})`
    );
  }
  const { triggers, unmatched } = input.full
    ? { triggers: allTriggers(config.steps), unmatched: [] }
    : fireTriggers(input.paths, config.rules, config.steps);
  const ctx: StepContext = {
    base: input.base,
    head: input.head,
    paths: input.paths,
    triggers,
    isWorktree: input.isWorktree
  };
  const fired = new Set(triggers);
  const skipSet = new Set(input.skip);
  const skipped: Plan['skipped'] = [];
  const skippedByFlag: string[] = [];
  const survivors: ResolvedStep[] = [];
  for (const step of config.steps) {
    if (!step.when.some((t) => fired.has(t))) {
      skipped.push({ label: step.label, reason: { kind: 'not-triggered' } });
    } else if (step.if && !step.if(ctx)) {
      skipped.push({ label: step.label, reason: { kind: 'if-false' } });
    } else if (skipSet.has(step.label)) {
      skipped.push({ label: step.label, reason: { kind: 'skip-flag' } });
      skippedByFlag.push(step.label);
    } else {
      survivors.push(step);
    }
  }
  const surviving = new Set(survivors.map((s) => s.label));
  const steps: PlannedStep[] = [];
  for (const step of survivors) {
    const by = step.supersededBy.find((l) => surviving.has(l));
    if (by !== undefined) {
      skipped.push({ label: step.label, reason: { kind: 'superseded', by } });
      continue;
    }
    const command = typeof step.run === 'function' ? step.run(ctx) : step.run;
    if (typeof command !== 'string' || command.trim() === '') {
      throw new PlanError(`step "${step.label}": run() must return a non-empty command`);
    }
    steps.push({
      label: step.label,
      command,
      policeStderr: step.policeStderr,
      timeoutMs: step.timeoutMs
    });
  }
  return { triggers, unmatched, steps, skipped, skippedByFlag };
}

export function describeSkip(reason: SkipReason): string {
  switch (reason.kind) {
    case 'not-triggered':
      return 'no relevant changes';
    case 'if-false':
      return '`if` returned false';
    case 'skip-flag':
      return '--skip';
    case 'superseded':
      return `superseded by ${reason.by}`;
  }
}
