/** A path matcher: a picomatch glob (dotfiles match) or a RegExp tested against the
 *  repo-relative POSIX path. */
export type Matcher = string | RegExp;

/** What a step's `run` function and `if` predicate see. */
export interface StepContext {
  base: string;
  head: string;
  paths: readonly string[];
  triggers: readonly string[];
  isWorktree: boolean;
}

/** First matching rule wins. `triggers: []` means "matched, nothing to run". */
export interface RuleConfig {
  match: Matcher | Matcher[];
  triggers: string[];
}

export interface StepConfig {
  /** Unique, no whitespace. Used by --skip, the note and the status description. */
  label: string;
  run: string | ((ctx: StepContext) => string);
  /** Planned when any listed trigger fired. */
  when: string[];
  if?: (ctx: StepContext) => boolean;
  /** Dropped when any listed step label is also going to run. */
  supersededBy?: string[];
  /** Capture stderr; a clean exit with non-allowlisted stderr fails the step. */
  policeStderr?: boolean;
  /** Hard wall-clock ceiling; the step's process group is SIGKILLed past it. */
  timeoutMs?: number;
}

export interface AllowlistEntry {
  /** A stderr line (ANSI-stripped) matching this pattern is benign. */
  pattern: RegExp;
  /** Why this noise is unavoidable. Required: allowlisting is a reviewed decision. */
  reason: string;
}

export interface ProtectionConfig {
  /** Shallow-merged over the default branch-protection payload. */
  branch?: Record<string, unknown>;
  /** Shallow-merged over the default repository merge settings. */
  repo?: Record<string, unknown>;
}

/** Presence turns flake tracking on: retried-then-passed tests become GitHub issues. */
export interface FlakesConfig {
  /** Occurrences (the issue itself counts as one) at which an unsnoozed flake fails signoff. */
  threshold?: number;
  /** An issue carrying this label never escalates. */
  snoozeLabel?: string;
  /** Linked from every filed issue. */
  playbookUrl?: string;
}

export interface BurnInRunner {
  /** For output. */
  name: string;
  match: Matcher | Matcher[];
  ignore?: Matcher | Matcher[];
  /** A string runs once; an array runs each in sequence (for runners with no repeat flag). */
  command: (files: string[], repeats: number) => string | string[];
}

export interface BurnInConfig {
  repeats?: number;
  /** Changed test files beyond this many are listed as skipped, never silently dropped. */
  maxFiles?: number;
  runners: BurnInRunner[];
}

export interface ResolvedFlakes {
  threshold: number;
  snoozeLabel: string;
  playbookUrl: string;
}

export interface ResolvedBurnIn {
  repeats: number;
  maxFiles: number;
  runners: BurnInRunner[];
}

export interface ChreodeConfig {
  baseBranch?: string;
  statusContext?: string;
  rules?: RuleConfig[];
  steps: StepConfig[];
  /** Runs only when the merge of origin/<baseBranch> actually changed the branch. */
  afterMerge?: string;
  stderrAllowlist?: AllowlistEntry[];
  protection?: ProtectionConfig;
  flakes?: FlakesConfig;
  burnIn?: BurnInConfig;
}

export interface ResolvedStep extends StepConfig {
  supersededBy: string[];
  policeStderr: boolean;
  timeoutMs: number;
}

export interface ResolvedConfig {
  baseBranch: string;
  statusContext: string;
  rules: RuleConfig[];
  steps: ResolvedStep[];
  afterMerge: string | null;
  stderrAllowlist: AllowlistEntry[];
  protection: ProtectionConfig;
  flakes: ResolvedFlakes | null;
  burnIn: ResolvedBurnIn | null;
}

export const DEFAULT_BASE_BRANCH = 'main';
export const DEFAULT_STATUS_CONTEXT = 'chreode/signoff';
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_FLAKE_THRESHOLD = 3;
export const DEFAULT_SNOOZE_LABEL = 'flake-snoozed';
export const DEFAULT_PLAYBOOK_URL = 'https://github.com/mindlace/chreode/blob/main/docs/flakes.md';
export const DEFAULT_BURN_IN_REPEATS = 5;
export const DEFAULT_BURN_IN_MAX_FILES = 12;

export function resolveFlakes(config: FlakesConfig): ResolvedFlakes {
  return {
    threshold: config.threshold ?? DEFAULT_FLAKE_THRESHOLD,
    snoozeLabel: config.snoozeLabel ?? DEFAULT_SNOOZE_LABEL,
    playbookUrl: config.playbookUrl ?? DEFAULT_PLAYBOOK_URL
  };
}

/** Identity helper so `chreode.config.ts` gets types. */
export function defineConfig(config: ChreodeConfig): ChreodeConfig {
  return config;
}
