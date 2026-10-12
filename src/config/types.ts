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

export interface ChreodeConfig {
  baseBranch?: string;
  statusContext?: string;
  rules?: RuleConfig[];
  steps: StepConfig[];
  /** Runs only when the merge of origin/<baseBranch> actually changed the branch. */
  afterMerge?: string;
  stderrAllowlist?: AllowlistEntry[];
  protection?: ProtectionConfig;
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
}

export const DEFAULT_BASE_BRANCH = 'main';
export const DEFAULT_STATUS_CONTEXT = 'chreode/signoff';
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Identity helper so `chreode.config.ts` gets types. */
export function defineConfig(config: ChreodeConfig): ChreodeConfig {
  return config;
}
