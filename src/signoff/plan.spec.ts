import { describe, expect, it } from 'vitest';
import type { ResolvedConfig, ResolvedStep, RuleConfig, StepContext } from '../config/types.js';
import { PlanError, fireTriggers, matchRule, planSignoff, type PlanInput } from './plan.js';

type StepSpec = Partial<ResolvedStep> & { label: string; when: string[] };

function config(rules: RuleConfig[], steps: StepSpec[]): ResolvedConfig {
  return {
    baseBranch: 'main',
    statusContext: 'chreode/signoff',
    afterMerge: null,
    stderrAllowlist: [],
    protection: {},
    flakes: null,
    burnIn: null,
    rules,
    steps: steps.map((s) => ({
      run: `run ${s.label}`,
      supersededBy: [],
      policeStderr: false,
      timeoutMs: 1000,
      ...s
    }))
  };
}

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  paths: [],
  full: false,
  skip: [],
  base: 'b',
  head: 'h',
  isWorktree: false,
  ...over
});

const RULES: RuleConfig[] = [
  { match: ['docs/**', '**/*.md'], triggers: ['format'] },
  { match: 'src/**', triggers: ['lint', 'unit'] },
  { match: '.github/workflows/**', triggers: ['workflows'] },
  { match: 'generated/**', triggers: [] }
];
const STEPS: StepSpec[] = [
  { label: 'format', when: ['format'], supersededBy: ['lint'] },
  { label: 'lint', when: ['lint'] },
  { label: 'unit', when: ['unit'] },
  { label: 'workflows', when: ['workflows'] }
];
const labels = (cfg: ResolvedConfig, inp: PlanInput) =>
  planSignoff(cfg, inp).steps.map((s) => s.label);

describe('matchRule', () => {
  it('first match wins', () => {
    expect(matchRule('src/README.md', RULES)).toBe(RULES[0]);
  });

  it('globs match dotfile paths', () => {
    expect(matchRule('.github/workflows/ci.yml', RULES)).toBe(RULES[2]);
  });

  it('a global RegExp matches every path, not every other one', () => {
    const rules: RuleConfig[] = [{ match: /\.md$/g, triggers: ['format'] }];
    expect(['a.md', 'b.md', 'c.md'].map((p) => matchRule(p, rules))).toEqual([
      rules[0],
      rules[0],
      rules[0]
    ]);
  });
});

describe('fireTriggers', () => {
  it('an unknown path fires every trigger any step listens for and is reported', () => {
    const cfg = config(RULES, STEPS);
    expect(fireTriggers(['Makefile', 'docs/a.md'], cfg.rules, cfg.steps)).toEqual({
      triggers: ['format', 'lint', 'unit', 'workflows'],
      unmatched: ['Makefile']
    });
  });

  it('a rule with `triggers: []` matches and fires nothing', () => {
    const cfg = config(RULES, STEPS);
    expect(fireTriggers(['generated/x.json'], cfg.rules, cfg.steps)).toEqual({
      triggers: [],
      unmatched: []
    });
  });
});

describe('planSignoff', () => {
  const cfg = config(RULES, STEPS);

  it('plans steps whose triggers fired, in config order', () => {
    expect(labels(cfg, input({ paths: ['.github/workflows/ci.yml', 'src/a.ts'] }))).toEqual([
      'lint',
      'unit',
      'workflows'
    ]);
  });

  it('a docs-only change runs only the docs step', () => {
    expect(labels(cfg, input({ paths: ['docs/guide.md'] }))).toEqual(['format']);
  });

  it('supersededBy drops a step when the superseding step will run', () => {
    const plan = planSignoff(cfg, input({ paths: ['docs/a.md', 'src/a.ts'] }));
    expect(plan.steps.map((s) => s.label)).toEqual(['lint', 'unit']);
    expect(plan.skipped).toContainEqual({
      label: 'format',
      reason: { kind: 'superseded', by: 'lint' }
    });
  });

  it('--skip of the superseding step lets the superseded one run, and is reported', () => {
    const plan = planSignoff(cfg, input({ paths: ['docs/a.md', 'src/a.ts'], skip: ['lint'] }));
    expect(plan.steps.map((s) => s.label)).toEqual(['format', 'unit']);
    expect(plan.skippedByFlag).toEqual(['lint']);
  });

  it('--skip of a step that was not triggered is not reported as skipped', () => {
    const plan = planSignoff(cfg, input({ paths: ['docs/a.md'], skip: ['unit'] }));
    expect(plan.skippedByFlag).toEqual([]);
  });

  it('--skip naming an unknown step is an error', () => {
    expect(() => planSignoff(cfg, input({ skip: ['lnt'] }))).toThrow(PlanError);
  });

  it('`if` sees the context and can drop a step', () => {
    const seen: StepContext[] = [];
    const gated = config(RULES, [
      {
        label: 'prime',
        when: ['unit'],
        if: (ctx) => {
          seen.push(ctx);
          return ctx.isWorktree;
        }
      },
      { label: 'unit', when: ['unit'] }
    ]);
    const inp = input({ paths: ['src/a.ts'] });
    expect(labels(gated, inp)).toEqual(['unit']);
    expect(labels(gated, { ...inp, isWorktree: true })).toEqual(['prime', 'unit']);
    expect(seen[0]).toEqual({
      base: 'b',
      head: 'h',
      paths: ['src/a.ts'],
      triggers: ['lint', 'unit'],
      isWorktree: false
    });
  });

  it('a function `run` is resolved with the context', () => {
    const fn = config(RULES, [
      { label: 'burn', when: ['unit'], run: (ctx) => `burn --base ${ctx.base} --head ${ctx.head}` }
    ]);
    expect(planSignoff(fn, input({ paths: ['src/a.ts'] })).steps[0]!.command).toBe(
      'burn --base b --head h'
    );
  });

  it('--full fires every trigger regardless of paths', () => {
    expect(labels(cfg, input({ full: true }))).toEqual(['lint', 'unit', 'workflows']);
  });

  it('no changed paths plans nothing', () => {
    expect(labels(cfg, input())).toEqual([]);
  });
});
