import { describe, expect, it } from 'vitest';
import { fakeExec, type Response } from '../../test/support/fake-exec.js';
import { isVersionOnlyChange, versionOnlyPaths } from './version-only.js';

const missing = new Error("fatal: path 'x' does not exist in 'b'");
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

const PKG = {
  name: 'widget',
  version: '1.0.0',
  scripts: { test: 'vitest' },
  dependencies: { picomatch: '^4.0.0' }
};
const LOCK = {
  name: 'widget',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'widget', version: '1.0.0', dependencies: { picomatch: '^4.0.0' } },
    'node_modules/picomatch': { version: '4.0.2' }
  }
};

function sides(path: string, before: Response, after: Response) {
  return fakeExec({ [`git show b:${path}`]: before, [`git show h:${path}`]: after });
}

function bumpLock(lock: typeof LOCK, version: string) {
  return {
    ...lock,
    version,
    packages: { ...lock.packages, '': { ...lock.packages[''], version } }
  };
}

describe('isVersionOnlyChange', () => {
  it('a package.json whose only change is the version', () => {
    const { exec } = sides('package.json', json(PKG), json({ ...PKG, version: '1.1.0' }));
    expect(isVersionOnlyChange('b', 'h', 'package.json', exec)).toBe(true);
  });

  it('ignores key order and formatting', () => {
    const { version: _v, ...rest } = PKG;
    const { exec } = sides(
      'package.json',
      json(PKG),
      JSON.stringify({ version: '1.1.0', ...rest })
    );
    expect(isVersionOnlyChange('b', 'h', 'package.json', exec)).toBe(true);
  });

  it('a package.json with any other change is not', () => {
    const { exec } = sides(
      'package.json',
      json(PKG),
      json({ ...PKG, version: '1.1.0', scripts: { test: 'vitest run' } })
    );
    expect(isVersionOnlyChange('b', 'h', 'package.json', exec)).toBe(false);
  });

  it('a package.json whose version did not change is not (a formatting-only diff)', () => {
    const { exec } = sides('package.json', json(PKG), JSON.stringify(PKG));
    expect(isVersionOnlyChange('b', 'h', 'package.json', exec)).toBe(false);
  });

  it('a lockfile whose only changes are both version fields', () => {
    const { exec } = sides('package-lock.json', json(LOCK), json(bumpLock(LOCK, '1.1.0')));
    expect(isVersionOnlyChange('b', 'h', 'package-lock.json', exec)).toBe(true);
  });

  it('a lockfile with a dependency change is not', () => {
    const after = bumpLock(LOCK, '1.1.0');
    after.packages = { ...after.packages, 'node_modules/picomatch': { version: '4.0.3' } };
    const { exec } = sides('package-lock.json', json(LOCK), json(after));
    expect(isVersionOnlyChange('b', 'h', 'package-lock.json', exec)).toBe(false);
  });

  it('nested package.json files count', () => {
    const { exec } = sides(
      'packages/foo/package.json',
      json(PKG),
      json({ ...PKG, version: '2.0.0' })
    );
    expect(isVersionOnlyChange('b', 'h', 'packages/foo/package.json', exec)).toBe(true);
  });

  it('an added or deleted file is not', () => {
    const added = sides('package.json', missing, json(PKG));
    expect(isVersionOnlyChange('b', 'h', 'package.json', added.exec)).toBe(false);
    const deleted = sides('package.json', json(PKG), missing);
    expect(isVersionOnlyChange('b', 'h', 'package.json', deleted.exec)).toBe(false);
  });

  it('unparseable JSON on either side is not', () => {
    const { exec } = sides('package.json', json(PKG), '{ "version": "1.1.0",');
    expect(isVersionOnlyChange('b', 'h', 'package.json', exec)).toBe(false);
  });

  it('a non-object JSON document is not', () => {
    const { exec } = sides('package.json', '"1.0.0"', '"1.1.0"');
    expect(isVersionOnlyChange('b', 'h', 'package.json', exec)).toBe(false);
  });

  it('other files are never version-only, without asking git', () => {
    const { exec, calls } = fakeExec({});
    expect(isVersionOnlyChange('b', 'h', 'package.json.bak', exec)).toBe(false);
    expect(isVersionOnlyChange('b', 'h', 'src/package.ts', exec)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('versionOnlyPaths', () => {
  it('keeps only the version-only paths, in order', () => {
    const { exec } = fakeExec({
      'git show b:package.json': json(PKG),
      'git show h:package.json': json({ ...PKG, version: '1.1.0' }),
      'git show b:package-lock.json': json(LOCK),
      'git show h:package-lock.json': json({ ...bumpLock(LOCK, '1.1.0'), lockfileVersion: 2 })
    });
    expect(
      versionOnlyPaths('b', 'h', ['src/x.ts', 'package.json', 'package-lock.json'], exec)
    ).toEqual(['package.json']);
  });
});
