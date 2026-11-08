import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff.js';

const lines = (...l: string[]): string => l.join('\n') + '\n';

describe('parseDiff', () => {
  it('numbers added lines from the hunk header', () => {
    const out = lines(
      'diff --git a/e2e/a.spec.ts b/e2e/a.spec.ts',
      'index 111..222 100644',
      '--- a/e2e/a.spec.ts',
      '+++ b/e2e/a.spec.ts',
      '@@ -10,2 +10,3 @@ ctx',
      '-r1',
      '-r2',
      '+a1',
      '+a2',
      '+a3',
      '@@ -40 +41 @@',
      '-x',
      '+y'
    );
    expect(parseDiff(out)).toEqual([
      {
        path: 'e2e/a.spec.ts',
        hunks: [
          {
            removed: ['r1', 'r2'],
            added: [
              { line: 10, text: 'a1' },
              { line: 11, text: 'a2' },
              { line: 12, text: 'a3' }
            ]
          },
          { removed: ['x'], added: [{ line: 41, text: 'y' }] }
        ]
      }
    ]);
  });

  it('reads a new file', () => {
    const out = lines(
      'diff --git a/e2e/n.spec.ts b/e2e/n.spec.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/e2e/n.spec.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two'
    );
    expect(parseDiff(out)).toEqual([
      {
        path: 'e2e/n.spec.ts',
        hunks: [
          {
            removed: [],
            added: [
              { line: 1, text: 'one' },
              { line: 2, text: 'two' }
            ]
          }
        ]
      }
    ]);
  });

  it('consumes hunks by their declared counts', () => {
    const out = lines(
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -3,2 +3,2 @@',
      '---- legacy comment',
      '--  ++i;',
      '++++j;',
      '+-- note',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-p',
      '+q'
    );
    const result = parseDiff(out);
    expect(result.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(result[0].hunks[0].removed).toEqual(['--- legacy comment', '-  ++i;']);
    expect(result[0].hunks[0].added.map((a) => a.text)).toEqual(['+++j;', '-- note']);
    expect(result[1].hunks[0].added).toEqual([{ line: 1, text: 'q' }]);
  });

  it('strips the tab git appends to a path with a space', () => {
    const out = lines(
      'diff --git a/e2e/my flow.spec.ts b/e2e/my flow.spec.ts',
      '--- a/e2e/my flow.spec.ts\t',
      '+++ b/e2e/my flow.spec.ts\t',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    );
    expect(parseDiff(out)[0].path).toBe('e2e/my flow.spec.ts');
  });

  it('unquotes a quoted path', () => {
    const out = lines(
      'diff --git "a/e2e/say \\"hi\\".spec.ts" "b/e2e/say \\"hi\\".spec.ts"',
      '+++ "b/e2e/say \\"hi\\".spec.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git "a/e2e/caf\\303\\251.spec.ts" "b/e2e/caf\\303\\251.spec.ts"',
      '+++ "b/e2e/caf\\303\\251.spec.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    );
    expect(parseDiff(out).map((f) => f.path)).toEqual(['e2e/say "hi".spec.ts', 'e2e/café.spec.ts']);
  });

  it('ignores the no-newline marker and CRLF', () => {
    const out = lines(
      'diff --git a/a.ts b/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '\\ No newline at end of file',
      '+await x();\r',
      '\\ No newline at end of file',
      '+next'
    );
    expect(parseDiff(out)[0].hunks[0]).toEqual({
      removed: ['old'],
      added: [
        { line: 1, text: 'await x();' },
        { line: 2, text: 'next' }
      ]
    });
  });

  it('omits files without hunks', () => {
    const out = lines(
      'diff --git a/e2e/shot.png b/e2e/shot.png',
      'new file mode 100644',
      'Binary files /dev/null and b/e2e/shot.png differ'
    );
    expect(parseDiff(out)).toEqual([]);
  });

  it('parses empty output', () => {
    expect(parseDiff('')).toEqual([]);
  });

  describe('fails loudly on output it was not pinned to produce', () => {
    const head = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts'];

    it('throws on a context line inside a merged hunk', () => {
      const out = lines(...head, '@@ -1,3 +1,4 @@', '-x', ' keep', '-y', '+a', '+b', '+c');
      expect(() => parseDiff(out)).toThrow(/a\.ts.*unexpected line " keep"/);
    });

    it('throws on an added line while removed lines are still expected', () => {
      const out = lines(...head, '@@ -1,2 +1 @@', '-x', '+a', '-y');
      expect(() => parseDiff(out)).toThrow(/unexpected line "\+a"/);
    });

    it('throws on a short hunk followed by another file', () => {
      const out = lines(...head, '@@ -0,0 +1,3 @@', '+a', '+b', 'diff --git a/b.ts b/b.ts');
      expect(() => parseDiff(out)).toThrow(/a\.ts.*1 added line\(s\) missing/);
    });

    it('throws on a short hunk at the end of the output', () => {
      const out = lines(...head, '@@ -2,2 +1 @@', '-x');
      expect(() => parseDiff(out)).toThrow(/a\.ts.*1 removed and 1 added line\(s\) missing/);
    });

    it('throws on a diff line after the counts are used up', () => {
      const out = lines(...head, '@@ -0,0 +1 @@', '+a', '+b');
      expect(() => parseDiff(out)).toThrow(/unexpected line "\+b"/);
    });
  });
});
