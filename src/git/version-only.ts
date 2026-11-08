import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { defaultExec, type Exec } from '../run/exec.js';

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Each version-bearing file: the version fields it carries, read and blanked. */
const VERSIONED: Record<string, (doc: Json) => { versions: unknown[]; rest: Json }> = {
  'package.json': (doc) => {
    const { version, ...rest } = doc;
    return { versions: [version], rest };
  },
  'package-lock.json': (doc) => {
    const { version, ...rest } = doc;
    const packages = rest.packages;
    if (!isObject(packages) || !isObject(packages[''])) return { versions: [version], rest };
    const { version: rootVersion, ...root } = packages[''];
    return {
      versions: [version, rootVersion],
      rest: { ...rest, packages: { ...packages, '': root } }
    };
  }
};

function readJson(rev: string, path: string, exec: Exec): Json | null {
  try {
    const doc: unknown = JSON.parse(exec('git', ['show', `${rev}:${path}`]));
    return isObject(doc) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * True when `path` is a package.json or package-lock.json (at any depth) present on both
 * sides whose only difference between base and head is its version field(s) (for the
 * lockfile, the top-level `version` and `packages[""].version`). Anything else, including
 * an added or deleted file or unparseable JSON, is false: the caller falls back to treating
 * the path as an ordinary change.
 */
export function isVersionOnlyChange(
  base: string,
  head: string,
  path: string,
  exec: Exec = defaultExec
): boolean {
  const strip = VERSIONED[posix.basename(path)];
  if (strip === undefined) return false;
  const before = readJson(base, path, exec);
  const after = readJson(head, path, exec);
  if (before === null || after === null) return false;
  const a = strip(before);
  const b = strip(after);
  return isDeepStrictEqual(a.rest, b.rest) && !isDeepStrictEqual(a.versions, b.versions);
}

/** The subset of `paths` that are version-only changes between base and head. */
export function versionOnlyPaths(
  base: string,
  head: string,
  paths: readonly string[],
  exec: Exec = defaultExec
): string[] {
  return paths.filter((p) => isVersionOnlyChange(base, head, p, exec));
}
