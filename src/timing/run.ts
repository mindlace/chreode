import { DEFAULT_PLAYBOOK_URL, type ResolvedConfig } from '../config/types.js';
import { defaultExec, type Exec } from '../run/exec.js';
import { checkTiming } from './check.js';
import { parseDiff } from './diff.js';
import { formatTimingReport } from './report.js';

export interface TimingDeps {
  exec: Exec;
  log: (m: string) => void;
}

/** Pinned so the user's diff.* and color config cannot change what is parsed. Renames read
 *  as an add plus a delete; only added or modified files are listed. */
export function timingDiffArgs(baseBranch: string, head: string): string[] {
  return [
    '-c',
    'core.quotePath=false',
    'diff',
    '--unified=0',
    '--no-renames',
    '--diff-filter=AM',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    `origin/${baseBranch}...${head}`
  ];
}

/** Check the lines the branch added since it left origin/<baseBranch>. Returns 1 iff any
 *  timing crutch was added. Git errors propagate. */
export function runTimingCheck(
  config: Pick<ResolvedConfig, 'baseBranch' | 'timing' | 'flakes'>,
  head: string,
  overrides: Partial<TimingDeps> = {}
): number {
  const deps: TimingDeps = { exec: defaultExec, log: console.log, ...overrides };
  const diff = deps.exec('git', timingDiffArgs(config.baseBranch, head));
  const result = checkTiming(parseDiff(diff), config.timing);
  const url = config.flakes?.playbookUrl ?? DEFAULT_PLAYBOOK_URL;
  for (const line of formatTimingReport(result, url)) deps.log(line);
  return result.violations.length > 0 ? 1 : 0;
}
