import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_BURN_IN_MAX_FILES,
  DEFAULT_BURN_IN_REPEATS,
  DEFAULT_STATUS_CONTEXT,
  DEFAULT_TIMEOUT_MS,
  resolveFlakes,
  type AllowlistEntry,
  type BurnInRunner,
  type FlakesConfig,
  type ProtectionConfig,
  type ResolvedBurnIn,
  type ResolvedConfig,
  type ResolvedFlakes,
  type ResolvedStep,
  type RuleConfig,
  type StepConfig
} from './types.js';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid chreode config:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const TOP_KEYS = new Set([
  'baseBranch',
  'statusContext',
  'rules',
  'steps',
  'afterMerge',
  'stderrAllowlist',
  'protection',
  'flakes',
  'burnIn'
]);
const RULE_KEYS = new Set(['match', 'triggers']);
const STEP_KEYS = new Set([
  'label',
  'run',
  'when',
  'if',
  'supersededBy',
  'policeStderr',
  'timeoutMs'
]);
const ALLOW_KEYS = new Set(['pattern', 'reason']);
const PROTECTION_KEYS = new Set(['branch', 'repo']);
const FLAKES_KEYS = new Set(['threshold', 'snoozeLabel', 'playbookUrl']);
const BURN_IN_KEYS = new Set(['repeats', 'maxFiles', 'runners']);
const RUNNER_KEYS = new Set(['name', 'match', 'ignore', 'command']);
const MATCHER_PROBLEM = 'must be a glob string, a RegExp, or a non-empty array of them';

/** Cross-realm safe: a config evaluated by jiti may not share this realm's RegExp. */
export function isRegExp(v: unknown): v is RegExp {
  return Object.prototype.toString.call(v) === '[object RegExp]';
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isRegExp(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isNonEmptyString);
}

function isMatcher(v: unknown): boolean {
  return isNonEmptyString(v) || isRegExp(v);
}

function isMatcherList(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 && v.every(isMatcher) : isMatcher(v);
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
  problems: string[]
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) problems.push(`${where}: unknown key "${key}"`);
  }
}

function validateRules(raw: unknown, problems: string[]): RuleConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push('config.rules: must be an array');
    return [];
  }
  raw.forEach((rule: unknown, i) => {
    const where = `rules[${i}]`;
    if (!isRecord(rule)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    unknownKeys(rule, RULE_KEYS, where, problems);
    if (!isMatcherList(rule.match)) problems.push(`${where}.match: ${MATCHER_PROBLEM}`);
    if (!Array.isArray(rule.triggers) || !rule.triggers.every(isNonEmptyString)) {
      problems.push(
        `${where}.triggers: must be an array of trigger names ([] means "matched, run nothing")`
      );
    }
  });
  return raw as RuleConfig[];
}

function validateSteps(raw: unknown, problems: string[]): ResolvedStep[] {
  if (!Array.isArray(raw)) {
    problems.push('config.steps: must be an array');
    return [];
  }
  const labels = new Set<string>();
  const out: ResolvedStep[] = [];
  raw.forEach((step: unknown, i) => {
    const where = `steps[${i}]`;
    if (!isRecord(step)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    unknownKeys(step, STEP_KEYS, where, problems);
    const label = step.label;
    if (typeof label !== 'string' || !/^\S+$/.test(label)) {
      problems.push(`${where}.label: must be non-empty with no whitespace`);
    } else if (labels.has(label)) {
      problems.push(`${where}.label: duplicate label "${label}"`);
    } else {
      labels.add(label);
    }
    if (!isNonEmptyString(step.run) && typeof step.run !== 'function') {
      problems.push(`${where}.run: must be a non-empty string or a function`);
    }
    if (!isStringArray(step.when) || step.when.length === 0) {
      problems.push(`${where}.when: must be a non-empty array of trigger names`);
    }
    if (step.if !== undefined && typeof step.if !== 'function') {
      problems.push(`${where}.if: must be a function`);
    }
    if (step.supersededBy !== undefined && !isStringArray(step.supersededBy)) {
      problems.push(`${where}.supersededBy: must be an array of step labels`);
    }
    if (step.policeStderr !== undefined && typeof step.policeStderr !== 'boolean') {
      problems.push(`${where}.policeStderr: must be a boolean`);
    }
    const t = step.timeoutMs;
    if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t) || t <= 0)) {
      problems.push(`${where}.timeoutMs: must be a positive number`);
    }
    out.push({
      ...(step as unknown as StepConfig),
      supersededBy: isStringArray(step.supersededBy) ? step.supersededBy : [],
      policeStderr: step.policeStderr === true,
      timeoutMs: typeof t === 'number' && t > 0 ? t : DEFAULT_TIMEOUT_MS
    });
  });
  for (const step of out) {
    for (const target of step.supersededBy) {
      if (target === step.label) {
        problems.push(`step "${step.label}": supersededBy names itself`);
      } else if (!labels.has(target)) {
        problems.push(`step "${step.label}": supersededBy names unknown step "${target}"`);
      }
    }
  }
  return out;
}

function validateAllowlist(raw: unknown, problems: string[]): AllowlistEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push('config.stderrAllowlist: must be an array');
    return [];
  }
  raw.forEach((entry: unknown, i) => {
    const where = `stderrAllowlist[${i}]`;
    if (!isRecord(entry)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    unknownKeys(entry, ALLOW_KEYS, where, problems);
    if (!isRegExp(entry.pattern)) problems.push(`${where}.pattern: must be a RegExp`);
    if (!isNonEmptyString(entry.reason))
      problems.push(`${where}.reason: must be a non-empty string`);
  });
  return raw as AllowlistEntry[];
}

function validateProtection(raw: unknown, problems: string[]): ProtectionConfig {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    problems.push('config.protection: must be an object');
    return {};
  }
  unknownKeys(raw, PROTECTION_KEYS, 'protection', problems);
  for (const key of ['branch', 'repo'] as const) {
    if (raw[key] !== undefined && !isRecord(raw[key])) {
      problems.push(`protection.${key}: must be an object`);
    }
  }
  return raw as ProtectionConfig;
}

function validateFlakes(raw: unknown, problems: string[]): ResolvedFlakes | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    problems.push(
      'config.flakes: must be an object ({} turns flake tracking on with the defaults)'
    );
    return null;
  }
  unknownKeys(raw, FLAKES_KEYS, 'flakes', problems);
  if (raw.threshold !== undefined && !isPositiveInteger(raw.threshold)) {
    problems.push('flakes.threshold: must be a positive integer');
  }
  for (const key of ['snoozeLabel', 'playbookUrl'] as const) {
    if (raw[key] !== undefined && !isNonEmptyString(raw[key])) {
      problems.push(`flakes.${key}: must be a non-empty string`);
    }
  }
  return resolveFlakes(raw as FlakesConfig);
}

function validateBurnIn(raw: unknown, problems: string[]): ResolvedBurnIn | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    problems.push('config.burnIn: must be an object');
    return null;
  }
  unknownKeys(raw, BURN_IN_KEYS, 'burnIn', problems);
  for (const key of ['repeats', 'maxFiles'] as const) {
    if (raw[key] !== undefined && !isPositiveInteger(raw[key])) {
      problems.push(`burnIn.${key}: must be a positive integer`);
    }
  }
  const runners = raw.runners;
  if (!Array.isArray(runners) || runners.length === 0) {
    problems.push('burnIn.runners: must be a non-empty array');
  } else {
    runners.forEach((runner: unknown, i) => {
      const where = `burnIn.runners[${i}]`;
      if (!isRecord(runner)) {
        problems.push(`${where}: must be an object`);
        return;
      }
      unknownKeys(runner, RUNNER_KEYS, where, problems);
      if (!isNonEmptyString(runner.name))
        problems.push(`${where}.name: must be a non-empty string`);
      if (!isMatcherList(runner.match)) problems.push(`${where}.match: ${MATCHER_PROBLEM}`);
      if (runner.ignore !== undefined && !isMatcherList(runner.ignore)) {
        problems.push(`${where}.ignore: ${MATCHER_PROBLEM}`);
      }
      if (typeof runner.command !== 'function') {
        problems.push(`${where}.command: must be a function (files, repeats) => string | string[]`);
      }
    });
  }
  return {
    repeats: (raw.repeats as number | undefined) ?? DEFAULT_BURN_IN_REPEATS,
    maxFiles: (raw.maxFiles as number | undefined) ?? DEFAULT_BURN_IN_MAX_FILES,
    runners: Array.isArray(runners) ? (runners as BurnInRunner[]) : []
  };
}

export function validateConfig(raw: unknown): ResolvedConfig {
  if (!isRecord(raw)) {
    throw new ConfigError([
      'config must be an object (does chreode.config.ts `export default defineConfig({ ... })`?)'
    ]);
  }
  const problems: string[] = [];
  unknownKeys(raw, TOP_KEYS, 'config', problems);
  for (const key of ['baseBranch', 'statusContext', 'afterMerge'] as const) {
    if (raw[key] !== undefined && !isNonEmptyString(raw[key])) {
      problems.push(`config.${key}: must be a non-empty string`);
    }
  }
  const rules = validateRules(raw.rules, problems);
  const steps = validateSteps(raw.steps, problems);
  const stderrAllowlist = validateAllowlist(raw.stderrAllowlist, problems);
  const protection = validateProtection(raw.protection, problems);
  const flakes = validateFlakes(raw.flakes, problems);
  const burnIn = validateBurnIn(raw.burnIn, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    baseBranch: (raw.baseBranch as string | undefined) ?? DEFAULT_BASE_BRANCH,
    statusContext: (raw.statusContext as string | undefined) ?? DEFAULT_STATUS_CONTEXT,
    rules,
    steps,
    afterMerge: (raw.afterMerge as string | undefined) ?? null,
    stderrAllowlist,
    protection,
    flakes,
    burnIn
  };
}
