import { describe, expect, it } from 'vitest';
import { ConfigError, validateConfig } from './validate.js';

const lint = { label: 'lint', run: 'npm run lint', when: ['lint'] };

function problems(raw: unknown): string[] {
  try {
    validateConfig(raw);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('validateConfig', () => {
  it('fills defaults for a minimal config', () => {
    const config = validateConfig({ steps: [lint] });
    expect(config).toMatchObject({
      baseBranch: 'main',
      statusContext: 'chreode/signoff',
      rules: [],
      afterMerge: null,
      stderrAllowlist: [],
      protection: {},
      flakes: null,
      burnIn: null
    });
    expect(config.steps[0]).toMatchObject({
      label: 'lint',
      supersededBy: [],
      policeStderr: false,
      timeoutMs: 600_000
    });
  });

  it('rejects unknown keys at every level', () => {
    expect(
      problems({
        stepz: [],
        steps: [{ ...lint, timeout: 5 }],
        rules: [{ match: 'src/**', triggers: [], trigger: 'x' }]
      })
    ).toEqual(
      expect.arrayContaining([
        'config: unknown key "stepz"',
        'steps[0]: unknown key "timeout"',
        'rules[0]: unknown key "trigger"'
      ])
    );
  });

  it('rejects duplicate labels and labels with whitespace', () => {
    expect(problems({ steps: [lint, lint, { ...lint, label: 'my step' }] })).toEqual([
      'steps[1].label: duplicate label "lint"',
      'steps[2].label: must be non-empty with no whitespace'
    ]);
  });

  it('rejects supersededBy naming a missing step or itself', () => {
    expect(
      problems({
        steps: [
          { ...lint, supersededBy: ['nope'] },
          { label: 'fmt', run: 'x', when: ['f'], supersededBy: ['fmt'] }
        ]
      })
    ).toEqual([
      'step "lint": supersededBy names unknown step "nope"',
      'step "fmt": supersededBy names itself'
    ]);
  });

  it('allows a `when` trigger that no rule emits (the unknown-path fallback can fire it)', () => {
    expect(
      problems({
        rules: [{ match: 'src/**', triggers: ['lint'] }],
        steps: [{ ...lint, when: ['orphan'] }]
      })
    ).toEqual([]);
  });

  it('rejects a step that can never run and a malformed run/timeout', () => {
    expect(problems({ steps: [{ label: 'a', run: 3, when: [], timeoutMs: -1 }] })).toEqual([
      'steps[0].run: must be a non-empty string or a function',
      'steps[0].when: must be a non-empty array of trigger names',
      'steps[0].timeoutMs: must be a positive number'
    ]);
  });

  it('rejects malformed rule matchers', () => {
    expect(problems({ rules: [{ match: [], triggers: ['x'] }], steps: [lint] })).toEqual([
      'rules[0].match: must be a glob string, a RegExp, or a non-empty array of them'
    ]);
  });

  it('requires a reason on every stderr allowlist entry', () => {
    expect(
      problems({
        steps: [lint],
        stderrAllowlist: [{ pattern: /x/ }, { pattern: 'x', reason: 'r' }]
      })
    ).toEqual([
      'stderrAllowlist[0].reason: must be a non-empty string',
      'stderrAllowlist[1].pattern: must be a RegExp'
    ]);
  });

  it('rejects a non-object config with a hint', () => {
    expect(problems(undefined)[0]).toContain('export default defineConfig');
  });

  describe('flakes', () => {
    it('`flakes: {}` turns tracking on with the defaults', () => {
      expect(validateConfig({ steps: [lint], flakes: {} }).flakes).toEqual({
        threshold: 3,
        snoozeLabel: 'flake-snoozed',
        playbookUrl: 'https://github.com/mindlace/chreode/blob/main/docs/flakes.md'
      });
    });

    it('keeps overrides', () => {
      const flakes = { threshold: 5, snoozeLabel: 'later', playbookUrl: 'https://x.test/p' };
      expect(validateConfig({ steps: [lint], flakes }).flakes).toEqual(flakes);
    });

    it('rejects bad values and unknown keys', () => {
      expect(
        problems({
          steps: [lint],
          flakes: { threshold: 2.5, snoozeLabel: '', playbookUrl: 7, treshold: 3 }
        })
      ).toEqual([
        'flakes: unknown key "treshold"',
        'flakes.threshold: must be a positive integer',
        'flakes.snoozeLabel: must be a non-empty string',
        'flakes.playbookUrl: must be a non-empty string'
      ]);
      expect(problems({ steps: [lint], flakes: true })).toEqual([
        'config.flakes: must be an object ({} turns flake tracking on with the defaults)'
      ]);
    });
  });

  describe('burnIn', () => {
    const runner = { name: 'unit', match: 'src/**/*.spec.ts', command: () => 'vitest' };

    it('fills repeats and maxFiles', () => {
      const burnIn = validateConfig({ steps: [lint], burnIn: { runners: [runner] } }).burnIn;
      expect(burnIn).toEqual({ repeats: 5, maxFiles: 12, runners: [runner] });
    });

    it('requires a non-empty runners array', () => {
      expect(problems({ steps: [lint], burnIn: { runners: [] } })).toEqual([
        'burnIn.runners: must be a non-empty array'
      ]);
      expect(problems({ steps: [lint], burnIn: {} })).toEqual([
        'burnIn.runners: must be a non-empty array'
      ]);
    });

    it('rejects bad counts, bad runners and unknown keys', () => {
      expect(
        problems({
          steps: [lint],
          burnIn: {
            repeats: 0,
            maxFiles: -1,
            runner: [],
            runners: [{ name: '', match: [], ignore: 5, command: 'vitest', when: [] }, 'x']
          }
        })
      ).toEqual([
        'burnIn: unknown key "runner"',
        'burnIn.repeats: must be a positive integer',
        'burnIn.maxFiles: must be a positive integer',
        'burnIn.runners[0]: unknown key "when"',
        'burnIn.runners[0].name: must be a non-empty string',
        'burnIn.runners[0].match: must be a glob string, a RegExp, or a non-empty array of them',
        'burnIn.runners[0].ignore: must be a glob string, a RegExp, or a non-empty array of them',
        'burnIn.runners[0].command: must be a function (files, repeats) => string | string[]',
        'burnIn.runners[1]: must be an object'
      ]);
    });
  });
});
