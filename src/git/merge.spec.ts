import { describe, expect, it } from 'vitest';
import { fakeExec } from '../../test/support/fake-exec.js';
import { mergeBaseBranch } from './merge.js';

const quiet = () => {};

describe('mergeBaseBranch', () => {
  it('--no-merge touches git not at all', () => {
    const { exec, calls } = fakeExec({});
    expect(mergeBaseBranch('main', { noMerge: true }, exec, quiet)).toEqual({ kind: 'skipped' });
    expect(calls).toEqual([]);
  });

  it('is up to date when origin/<base> has nothing new', () => {
    const { exec } = fakeExec({
      'git fetch origin main': '',
      'git rev-list HEAD..origin/main': ''
    });
    expect(mergeBaseBranch('main', { noMerge: false }, exec, quiet)).toEqual({
      kind: 'up-to-date'
    });
  });

  it('merges when behind', () => {
    const { exec, calls } = fakeExec({
      'git fetch origin main': '',
      'git rev-list HEAD..origin/main': 'abc\n',
      'git merge --no-edit origin/main': ''
    });
    expect(mergeBaseBranch('main', { noMerge: false }, exec, quiet)).toEqual({ kind: 'merged' });
    expect(calls).toContain('git merge --no-edit origin/main');
  });

  it('reports a conflict, leaving the merge in progress', () => {
    const { exec, calls } = fakeExec({
      'git fetch origin main': '',
      'git rev-list HEAD..origin/main': 'abc\n',
      'git merge --no-edit origin/main': new Error('CONFLICT'),
      'git rev-parse -q --verify MERGE_HEAD': 'abc\n'
    });
    expect(mergeBaseBranch('main', { noMerge: false }, exec, quiet)).toEqual({ kind: 'conflict' });
    expect(calls.some((c) => c.includes('--abort'))).toBe(false);
  });

  it('reports a merge that failed before starting, with its message', () => {
    const { exec } = fakeExec({
      'git fetch origin main': '',
      'git rev-list HEAD..origin/main': 'abc\n',
      'git merge --no-edit origin/main': new Error('untracked file would be overwritten'),
      'git rev-parse -q --verify MERGE_HEAD': new Error('no MERGE_HEAD')
    });
    expect(mergeBaseBranch('main', { noMerge: false }, exec, quiet)).toEqual({
      kind: 'failed',
      message: 'untracked file would be overwritten'
    });
  });

  it('warns and continues on the local view when the fetch fails', () => {
    const warnings: string[] = [];
    const { exec } = fakeExec({
      'git fetch origin main': new Error('offline'),
      'git rev-list HEAD..origin/main': ''
    });
    expect(mergeBaseBranch('main', { noMerge: false }, exec, (m) => warnings.push(m))).toEqual({
      kind: 'up-to-date'
    });
    expect(warnings[0]).toContain('offline');
  });
});
