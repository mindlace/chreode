import { execFileSync, execSync } from 'node:child_process';

/** Run a program (no shell) and return its stdout. Throws on non-zero exit; the error
 *  message carries the program's stderr. */
export type Exec = (file: string, args: readonly string[]) => string;

export const defaultExec: Exec = (file, args) =>
  execFileSync(file, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024
  });

/** Run a shell command with inherited stdio (for long, chatty commands). */
export type Run = (command: string, env?: NodeJS.ProcessEnv) => void;

export const defaultRun: Run = (command, env) => {
  execSync(command, { stdio: 'inherit', env: env ?? process.env });
};

export function lines(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
