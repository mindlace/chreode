import type { AllowlistEntry } from '../config/types.js';

// ANSI SGR color codes must not defeat allowlist matching. The escape character is built at
// runtime so no control character appears in source (keeps no-control-regex quiet).
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR, '');
}

/** Classify captured stderr line by line: blank and allowlisted lines are benign,
 *  everything else is returned ANSI-stripped. */
export function policeStderr(
  buffer: string,
  allowlist: readonly AllowlistEntry[]
): { offendingLines: string[] } {
  const offendingLines = buffer
    .split(/\r?\n/)
    .map(stripAnsi)
    .filter((line) => line.trim() !== '')
    .filter(
      (line) =>
        !allowlist.some((entry) => {
          entry.pattern.lastIndex = 0;
          return entry.pattern.test(line);
        })
    );
  return { offendingLines };
}

export type PolicedOutcome =
  | { kind: 'pass' }
  | { kind: 'fail-exit'; rawStderr: string }
  | { kind: 'fail-stderr'; offendingLines: string[] };

/** A non-zero/null exit is a real failure (surface everything). A clean exit with
 *  non-allowlisted stderr is a policy failure (surface just the offending lines). */
export function decidePolicedOutcome(
  result: { code: number | null; stderr?: string },
  allowlist: readonly AllowlistEntry[]
): PolicedOutcome {
  const buffer = result.stderr ?? '';
  if (result.code !== 0) return { kind: 'fail-exit', rawStderr: buffer };
  const { offendingLines } = policeStderr(buffer, allowlist);
  if (offendingLines.length > 0) return { kind: 'fail-stderr', offendingLines };
  return { kind: 'pass' };
}
