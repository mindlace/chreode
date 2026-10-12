import { describe, expect, it } from 'vitest';
import { decidePolicedOutcome, policeStderr } from './stderr.js';

const ESC = String.fromCharCode(27);
const allowlist = [{ pattern: /^\[WebServer\] /, reason: 'preview server echo' }];

describe('policeStderr', () => {
  it('ignores blank lines and allowlisted lines, returns the rest', () => {
    expect(policeStderr('\n  \n[WebServer] ready\nError: boom\r\n', allowlist)).toEqual({
      offendingLines: ['Error: boom']
    });
  });

  it('strips ANSI color before matching and in what it reports', () => {
    expect(
      policeStderr(`${ESC}[33m[WebServer] warn${ESC}[0m\n${ESC}[31mbad${ESC}[0m`, allowlist)
    ).toEqual({ offendingLines: ['bad'] });
  });
});

describe('decidePolicedOutcome', () => {
  it('a non-zero exit is a real failure carrying the whole buffer', () => {
    expect(decidePolicedOutcome({ code: 2, stderr: 'trace' }, allowlist)).toEqual({
      kind: 'fail-exit',
      rawStderr: 'trace'
    });
  });

  it('a signal death (null code) is a real failure', () => {
    expect(decidePolicedOutcome({ code: null }, allowlist).kind).toBe('fail-exit');
  });

  it('a clean exit with unexpected stderr fails on just the offending lines', () => {
    expect(decidePolicedOutcome({ code: 0, stderr: '[WebServer] x\noops' }, allowlist)).toEqual({
      kind: 'fail-stderr',
      offendingLines: ['oops']
    });
  });

  it('a clean exit with only allowlisted stderr passes', () => {
    expect(decidePolicedOutcome({ code: 0, stderr: '[WebServer] x\n' }, allowlist)).toEqual({
      kind: 'pass'
    });
  });
});
