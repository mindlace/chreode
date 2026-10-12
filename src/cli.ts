#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { CONFIG_FILE, loadConfig } from './config/load.js';
import type { ResolvedConfig } from './config/types.js';
import { parseRepo } from './github/status.js';
import { runProtect } from './github/protect.js';
import { defaultExec } from './run/exec.js';
import { runSignoff, type SignoffOptions } from './signoff/run.js';

export interface SignoffFlags {
  full?: boolean;
  dryRun?: boolean;
  merge?: boolean;
  push?: boolean;
  allowStderr?: boolean;
  base?: string;
  skip?: string[];
  config?: string;
}

export interface ProtectFlags {
  dryRun?: boolean;
  repo?: string;
  config?: string;
}

/** Each flag also has an env form, for harnesses that forbid flags after `--`. */
export function resolveSignoffOptions(flags: SignoffFlags, env: NodeJS.ProcessEnv): SignoffOptions {
  const on = (key: string) => env[key] === '1';
  return {
    full: flags.full === true || on('CHREODE_FULL'),
    dryRun: flags.dryRun === true,
    noMerge: flags.merge === false || on('CHREODE_NO_MERGE'),
    noPush: flags.push === false || on('CHREODE_NO_PUSH'),
    allowStderr: flags.allowStderr === true || on('CHREODE_ALLOW_STDERR'),
    base: flags.base ?? null,
    skip: flags.skip ?? []
  };
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function buildProgram(
  actions: {
    signoff: (flags: SignoffFlags) => Promise<number>;
    protect: (flags: ProtectFlags) => Promise<number>;
  },
  setExit: (code: number) => void
): Command {
  const program = new Command('chreode')
    .description('A deterministic, selective, unavoidable local-CI gate')
    .version(readVersion());

  program
    .command('signoff')
    .description('merge the base branch, run the steps the changes need, push, post the status')
    .option('--full', 'ignore the incremental base and run every step (env CHREODE_FULL=1)')
    .option(
      '--dry-run',
      'merge origin/<baseBranch> and run afterMerge as usual, then print the plan and stop ' +
        'without running steps (add --no-merge for a side-effect-free look)'
    )
    .option('--no-merge', 'do not merge origin/<baseBranch> first (env CHREODE_NO_MERGE=1)')
    .option(
      '--no-push',
      'do not push; the commit must already be on origin (env CHREODE_NO_PUSH=1)'
    )
    .option('--allow-stderr', 'downgrade policed stderr to a warning (env CHREODE_ALLOW_STDERR=1)')
    .option('--base <ref>', 'diff from this ref instead of the last signoff')
    .option('--skip <label>', 'skip a planned step; repeatable; named in the status', collect, [])
    .option('--config <path>', `config file (default: <repo root>/${CONFIG_FILE})`)
    .action(async (flags: SignoffFlags) => setExit(await actions.signoff(flags)));

  program
    .command('protect')
    .description('require the signoff status on the base branch (idempotent)')
    .option('--dry-run', 'print the payloads without applying them')
    .option('--repo <owner/name>', 'target repository (default: gh repo view)')
    .option('--config <path>', `config file (default: <repo root>/${CONFIG_FILE})`)
    .action(async (flags: ProtectFlags) => setExit(await actions.protect(flags)));

  return program;
}

/** Steps and git commands run from the repo root, whatever directory chreode was started in.
 *  Returns a loader rather than a config: signoff reloads it after a merge. */
function repoConfigLoader(configFlag: string | undefined): () => Promise<ResolvedConfig> {
  const explicit = configFlag ? path.resolve(configFlag) : null;
  const root = defaultExec('git', ['rev-parse', '--show-toplevel']).trim();
  process.chdir(root);
  const file = explicit ?? path.join(root, CONFIG_FILE);
  return () => loadConfig(file);
}

export async function main(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let code = 0;
  const program = buildProgram(
    {
      signoff: async (flags) =>
        runSignoff(repoConfigLoader(flags.config), resolveSignoffOptions(flags, env)),
      protect: async (flags) =>
        runProtect(await repoConfigLoader(flags.config)(), {
          dryRun: flags.dryRun === true,
          repo: flags.repo ? parseRepo(flags.repo) : null
        })
    },
    (c) => {
      code = c;
    }
  );
  try {
    await program.parseAsync(argv);
  } catch (err) {
    console.error(`[chreode] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return code;
}

/** npm installs the bin as a symlink, so compare real paths, not the invoked path. */
export function isInvokedDirectly(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isInvokedDirectly(import.meta.url, process.argv[1])) {
  main().then(
    (c) => {
      process.exitCode = c;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    }
  );
}
