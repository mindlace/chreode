import { describe, expect, it } from 'vitest';
import { fakeExec } from '../../test/support/fake-exec.js';
import { parseRepo, prUrl, repoInfo, statusArgs, statusDescription } from './status.js';

describe('statusDescription', () => {
  it('names the signer', () => {
    expect(statusDescription('me@example.com', {})).toBe('signed off by me@example.com');
  });

  it('is honest about --skip', () => {
    expect(statusDescription('me@example.com', { skipped: ['test:e2e', 'lint'] })).toBe(
      'signed off by me@example.com (skipped: test:e2e, lint)'
    );
  });

  it('discloses allowed stderr and an explicit --base', () => {
    expect(
      statusDescription('me@example.com', {
        skipped: ['e2e'],
        allowedStderr: ['unit'],
        base: 'HEAD~2'
      })
    ).toBe('signed off by me@example.com (skipped: e2e; allowed stderr: unit; base=HEAD~2)');
  });

  it('never exceeds GitHub’s 140-character cap', () => {
    const desc = statusDescription('me@example.com', {
      skipped: Array.from({ length: 30 }, (_, i) => `step-${i}`),
      base: 'main'
    });
    expect(desc).toHaveLength(140);
    expect(desc.endsWith('...')).toBe(true);
  });
});

describe('statusArgs', () => {
  it('posts a success status with the context and description as literal fields', () => {
    expect(statusArgs({ owner: 'o', name: 'n' }, 'abc', 'chreode/signoff', "it's @fine")).toEqual([
      'api',
      '-X',
      'POST',
      'repos/o/n/statuses/abc',
      '-f',
      'state=success',
      '-f',
      'context=chreode/signoff',
      '-f',
      "description=it's @fine"
    ]);
  });
});

describe('repo helpers', () => {
  it('reads the repo from gh', () => {
    const { exec } = fakeExec({
      'gh repo view --json owner,name': '{"owner":{"login":"acme"},"name":"widget"}'
    });
    expect(repoInfo(exec)).toEqual({ owner: 'acme', name: 'widget' });
  });

  it('parses owner/name and rejects anything else', () => {
    expect(parseRepo('acme/widget')).toEqual({ owner: 'acme', name: 'widget' });
    expect(() => parseRepo('widget')).toThrow('owner/name');
  });

  it('prUrl is null when the branch has no PR', () => {
    const { exec } = fakeExec({ 'gh pr view --json url': new Error('no pull requests found') });
    expect(prUrl(exec)).toBeNull();
  });
});
