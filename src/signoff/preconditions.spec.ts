import { describe, expect, it } from 'vitest';
import { fakeExec, type Response } from '../../test/support/fake-exec.js';
import { PreconditionError, checkPreconditions } from './preconditions.js';

function exec(over: Record<string, Response> = {}) {
  return fakeExec({
    'git status --porcelain': '',
    'git symbolic-ref -q --short HEAD': 'feature\n',
    'git rev-list HEAD..@{u}': new Error('no upstream'),
    'gh auth status': '',
    'git config user.email': 'me@example.com\n',
    ...over
  }).exec;
}

describe('checkPreconditions', () => {
  it('returns the branch and the signer when everything holds', () => {
    expect(checkPreconditions('main', exec())).toEqual({
      branch: 'feature',
      signer: 'me@example.com'
    });
  });

  it.each([
    ['a dirty tree', { 'git status --porcelain': ' M src/a.ts\n' }, 'dirty'],
    ['a detached HEAD', { 'git symbolic-ref -q --short HEAD': new Error('detached') }, 'detached'],
    ['the base branch itself', { 'git symbolic-ref -q --short HEAD': 'main\n' }, 'on main'],
    ['a branch behind its upstream', { 'git rev-list HEAD..@{u}': 'abc\n' }, 'behind'],
    ['an unauthenticated gh', { 'gh auth status': new Error('not logged in') }, 'gh auth login'],
    ['no git user.email', { 'git config user.email': new Error('unset') }, 'user.email']
  ] as const)('refuses %s', (_name, over, message) => {
    expect(() => checkPreconditions('main', exec(over))).toThrow(PreconditionError);
    expect(() => checkPreconditions('main', exec(over))).toThrow(message);
  });

  it('with flakes on, requires .chreode/ to be gitignored', () => {
    const ignored = exec({ 'git check-ignore -q .chreode/flakes.jsonl': '' });
    expect(checkPreconditions('main', ignored, { flakes: true }).branch).toBe('feature');
    const tracked = exec({ 'git check-ignore -q .chreode/flakes.jsonl': new Error('exit 1') });
    expect(() => checkPreconditions('main', tracked, { flakes: true })).toThrow(
      'add the line `.chreode/` to .gitignore'
    );
  });
});
