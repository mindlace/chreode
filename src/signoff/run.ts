import { resolve } from 'node:path';
import type { ResolvedConfig } from '../config/types.js';
import { ghLedgerDeps } from '../flakes/gh.js';
import type { FlakeLedgerDeps } from '../flakes/ledger.js';
import { FLAKE_LOG_FILE } from '../flakes/log.js';
import { escalationFailure, runFlakePhase } from '../flakes/phase.js';
import {
  committedPaths,
  isWorktree,
  resolveBase,
  resolveRef,
  type BaseInfo
} from '../git/change-set.js';
import { mergeBaseBranch } from '../git/merge.js';
import { repoInfo, type RepoInfo } from '../github/status.js';
import { signoffLock, type MachineLock } from '../lock/machine-lock.js';
import { defaultExec, defaultRun, type Exec, type Run } from '../run/exec.js';
import { StepFailure, runStep, runSteps, type StepOutcome } from '../run/step.js';
import { PlanError, describeSkip, planSignoff, type Plan, type PlannedStep } from './plan.js';
import { PreconditionError, checkPreconditions, type Preconditions } from './preconditions.js';
import { defaultTailEffects, runTail, type TailEffects } from './tail.js';

export interface SignoffOptions {
  full: boolean;
  dryRun: boolean;
  noMerge: boolean;
  noPush: boolean;
  allowStderr: boolean;
  base: string | null;
  skip: string[];
}

export interface SignoffDeps {
  exec: Exec;
  run: Run;
  lock: MachineLock;
  runStep: (step: PlannedStep) => Promise<StepOutcome>;
  tail: TailEffects;
  /** Files, bumps and lists flake issues. */
  ledger: FlakeLedgerDeps;
  /** Absolute path of the flake log; steps see it as CHREODE_FLAKE_LOG. */
  flakeLog: string;
  log: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}

function defaultDeps(
  config: ResolvedConfig,
  opts: SignoffOptions,
  stepEnv: NodeJS.ProcessEnv = {}
): SignoffDeps {
  // Children can detect the gate (e.g. to quiet build-tool stderr) via CHREODE_SIGNOFF=1.
  const env = { ...process.env, CHREODE_SIGNOFF: '1', ...stepEnv };
  let repo: RepoInfo | null = null;
  const getRepo = () => (repo ??= repoInfo(defaultExec));
  return {
    exec: defaultExec,
    run: (command) => defaultRun(command, env),
    lock: signoffLock(),
    runStep: (step) =>
      runStep(step, { allowStderr: opts.allowStderr, allowlist: config.stderrAllowlist, env }),
    tail: defaultTailEffects(getRepo, config.statusContext),
    ledger: ghLedgerDeps(defaultExec),
    // The CLI has already chdir'd to the repo root.
    flakeLog: resolve(FLAKE_LOG_FILE),
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m)
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why the checkout no longer matches `head`, or null when it is clean and unmoved. */
function checkoutChange(head: string, exec: Exec): string | null {
  if (exec('git', ['status', '--porcelain']).trim() !== '') return 'the working tree is dirty';
  const now = exec('git', ['rev-parse', 'HEAD']).trim();
  return now !== head ? `HEAD moved to ${now}` : null;
}

export function printPlan(
  plan: Plan,
  where: { base: string; head: string; paths: readonly string[]; full: boolean },
  log: (m: string) => void
): void {
  log(`[chreode] base=${where.base} head=${where.head}${where.full ? ' (--full)' : ''}`);
  log(`[chreode] changed paths (${where.paths.length}):`);
  for (const p of where.paths) log(`  ${p}`);
  if (plan.unmatched.length > 0) {
    log(`[chreode] matched no rule, so every trigger fired: ${plan.unmatched.join(', ')}`);
  }
  log(`[chreode] triggers: ${plan.triggers.length > 0 ? plan.triggers.join(', ') : '(none)'}`);
  log(
    `[chreode] plan: ${plan.steps.length > 0 ? plan.steps.map((s) => s.label).join(', ') : '(no steps: a no-op signoff)'}`
  );
  for (const { label, reason } of plan.skipped) {
    log(`[chreode] skipping ${label} (${describeSkip(reason)})`);
  }
}

/**
 * `loadConfig` is called once up front and again after a merge that changed the branch, so
 * a merge that brings in a new chreode.config.ts is planned and run under that config.
 */
export async function runSignoff(
  loadConfig: () => Promise<ResolvedConfig>,
  opts: SignoffOptions,
  overrides: Partial<SignoffDeps> = {}
): Promise<number> {
  let config = await loadConfig();
  let d: SignoffDeps = { ...defaultDeps(config, opts), ...overrides };
  const baseBranch = config.baseBranch;

  // 1. Preconditions
  let pre: Preconditions;
  try {
    pre = checkPreconditions(baseBranch, d.exec, { flakes: config.flakes !== null });
  } catch (err) {
    if (err instanceof PreconditionError) {
      d.error(`[chreode] ${err.message}`);
      return 1;
    }
    throw err;
  }

  // 2. Merge
  const merge = mergeBaseBranch(baseBranch, { noMerge: opts.noMerge }, d.exec, d.warn);
  if (merge.kind === 'conflict') {
    d.error(
      `\n[chreode] merging origin/${baseBranch} hit a conflict. The merge is in progress.\n` +
        `Resolve it, run \`git commit --no-edit\`, then re-run signoff.\n` +
        `To bail out: \`git merge --abort\`.`
    );
    return 1;
  }
  if (merge.kind === 'failed') {
    d.error(`[chreode] merging origin/${baseBranch} failed: ${merge.message}`);
    return 1;
  }
  if (merge.kind === 'merged') {
    d.log(`[chreode] merged origin/${baseBranch} into ${pre.branch}`);
    if (config.afterMerge) {
      d.log(`[chreode] afterMerge: ${config.afterMerge}`);
      const before = d.exec('git', ['rev-parse', 'HEAD']).trim();
      try {
        d.run(config.afterMerge);
      } catch {
        d.error('[chreode] afterMerge failed');
        return 1;
      }
      const moved = checkoutChange(before, d.exec);
      if (moved) {
        d.error(
          `[chreode] afterMerge changed the checkout (${moved}); commit the change and re-run signoff.`
        );
        return 1;
      }
    }
    // The merge may have changed the config itself: plan under what is now checked out.
    try {
      config = await loadConfig();
    } catch (err) {
      d.error(
        `[chreode] the config merged in from origin/${baseBranch} failed to load: ${message(err)}\n` +
          `Fix it in a commit on this branch, then re-run signoff.`
      );
      return 1;
    }
    d = { ...defaultDeps(config, opts), ...overrides };
  }

  // 3. Resolve base
  const head = d.exec('git', ['rev-parse', 'HEAD']).trim();
  let base: BaseInfo['base'];
  let source: BaseInfo['source'] | 'flag';
  try {
    if (opts.base !== null) {
      base = resolveRef(opts.base, d.exec);
      source = 'flag';
    } else {
      ({ base, source } = resolveBase(baseBranch, d.exec));
    }
  } catch (err) {
    d.error(`[chreode] could not resolve the base: ${message(err)}`);
    return 1;
  }
  if (!opts.full && base === head) {
    d.log(
      source === 'note'
        ? `[chreode] already signed off at ${head}; nothing to do (--full re-runs everything)`
        : `[chreode] nothing to sign off: ${base} is HEAD`
    );
    return 0;
  }

  // 4. Plan
  const paths = committedPaths(base, head, d.exec);
  let plan: Plan;
  try {
    plan = planSignoff(config, {
      paths,
      full: opts.full,
      skip: opts.skip,
      base,
      head,
      isWorktree: isWorktree(d.exec)
    });
  } catch (err) {
    if (err instanceof PlanError) {
      d.error(`[chreode] ${err.message}`);
      return 1;
    }
    throw err;
  }
  printPlan(plan, { base, head, paths, full: opts.full }, d.log);
  if (opts.dryRun) {
    d.log('[chreode] --dry-run: stopping before the run');
    return 0;
  }

  // 5. Run. Steps learn the sha under test and where reporters record flakes.
  d = {
    ...defaultDeps(config, opts, { CHREODE_HEAD: head, CHREODE_FLAKE_LOG: d.flakeLog }),
    ...overrides
  };
  let allowedStderr: string[] = [];
  let stepsFailed = false;
  try {
    allowedStderr = await runSteps(plan.steps, d.lock, d.runStep);
  } catch (err) {
    if (!(err instanceof StepFailure)) d.error(`[chreode] ${message(err)}`);
    stepsFailed = true;
  }

  // 6. Flakes: after the steps, passed or failed, so a flake is charged to the run that saw
  //    it. Network, not machine load: the lock is already released.
  let escalated = false;
  if (config.flakes !== null) {
    const outcome = runFlakePhase({
      logPath: d.flakeLog,
      ctx: { branch: pre.branch, sha: head },
      config: config.flakes,
      ledger: d.ledger,
      log: d.log,
      warn: d.warn
    });
    const failure = escalationFailure(outcome, config.flakes);
    if (failure !== undefined) {
      d.error(failure);
      escalated = true;
    }
  }
  if (stepsFailed || escalated) return 1;

  // What was tested must be exactly HEAD.
  const changed = checkoutChange(head, d.exec);
  if (changed) {
    d.error(
      `[chreode] the steps changed the checkout (${changed}); ` +
        `commit the change and re-run signoff. Nothing was posted.`
    );
    return 1;
  }

  // 7. Tail
  try {
    runTail(
      {
        sha: head,
        signer: pre.signer,
        noPush: opts.noPush,
        ranLabels: plan.steps.map((s) => s.label),
        skippedByFlag: plan.skippedByFlag,
        allowedStderr,
        baseFlag: opts.base,
        context: config.statusContext
      },
      d.tail,
      d.log
    );
  } catch (err) {
    d.error(`[chreode] ${message(err)}`);
    return 1;
  }
  return 0;
}
