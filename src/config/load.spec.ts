import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepContext } from './types.js';
import { loadConfig } from './load.js';
import { ConfigError } from './validate.js';

function configFile(source: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'chreode-cfg-')), 'chreode.config.ts');
  writeFileSync(file, source);
  return file;
}

describe('loadConfig', () => {
  it('loads a TypeScript config with RegExp matchers and function steps', async () => {
    const file = configFile(
      `export default {
  rules: [{ match: /\\.md$/, triggers: ['format'] }],
  steps: [{ label: 'format', run: (ctx: { base: string }) => 'prettier ' + ctx.base, when: ['format'] }]
};
`
    );
    const config = await loadConfig(file);
    expect((config.rules[0]!.match as RegExp).test('README.md')).toBe(true);
    const run = config.steps[0]!.run as (ctx: StepContext) => string;
    expect(run({ base: 'abc', head: 'def', paths: [], triggers: [], isWorktree: false })).toBe(
      'prettier abc'
    );
    expect(config.baseBranch).toBe('main');
  });

  it('reports a missing file as a ConfigError', async () => {
    await expect(loadConfig('/nonexistent/chreode.config.ts')).rejects.toBeInstanceOf(ConfigError);
  });

  it('reports an invalid config as a ConfigError', async () => {
    const file = configFile(`export default { steps: [{ label: 'a', run: 'x', when: [] }] };\n`);
    await expect(loadConfig(file)).rejects.toThrow('steps[0].when');
  });
});
