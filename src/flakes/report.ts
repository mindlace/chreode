import { resolveFlakes, type ResolvedConfig } from '../config/types.js';
import { defaultExec, type Exec } from '../run/exec.js';
import { ghLedgerDeps } from './gh.js';
import type { FlakeLedgerDeps } from './ledger.js';
import { flakeLogPath } from './log.js';
import { escalationFailure, runFlakePhase } from './phase.js';

export interface FlakeReportDeps {
  exec: Exec;
  ledger: FlakeLedgerDeps;
  logPath: string;
  log: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}

/** `chreode flake-report`: the signoff flake phase on its own, for hosted CI or by hand.
 *  Without a `flakes` block it uses the defaults: running it is the opt-in. */
export function runFlakeReport(
  config: ResolvedConfig,
  overrides: Partial<FlakeReportDeps> = {}
): number {
  const d: FlakeReportDeps = {
    exec: defaultExec,
    ledger: ghLedgerDeps(),
    logPath: flakeLogPath(),
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
    ...overrides
  };
  const flakes = config.flakes ?? resolveFlakes({});
  const sha = d.exec('git', ['rev-parse', 'HEAD']).trim();
  let branch = 'HEAD';
  try {
    branch = d.exec('git', ['symbolic-ref', '-q', '--short', 'HEAD']).trim();
  } catch {
    // Detached, e.g. a CI checkout of a sha.
  }
  const outcome = runFlakePhase({
    logPath: d.logPath,
    ctx: { branch, sha },
    config: flakes,
    ledger: d.ledger,
    log: d.log,
    warn: d.warn
  });
  if (outcome.kind === 'none') {
    d.log('[chreode] flakes: no flakes recorded');
    return 0;
  }
  const failure = escalationFailure(outcome, flakes);
  if (failure !== undefined) {
    d.error(failure);
    return 1;
  }
  return 0;
}
