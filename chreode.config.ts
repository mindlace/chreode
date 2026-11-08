import { timingStep, type ChreodeConfig } from './src/index.js';

// chreode gates itself, from this checkout's own build (`npm run signoff` builds first).
const config: ChreodeConfig = {
  rules: [
    // Prettier-ignored; nothing checks these.
    { match: ['docs/superpowers/**', 'LICENSE', '.nvmrc'], triggers: [] },
    { match: ['**/*.md'], triggers: ['format'] },
    { match: ['src/**', 'test/**'], triggers: ['lint', 'typecheck', 'test'] },
    { match: ['.github/workflows/**'], triggers: ['format', 'workflows'] }
    // Everything else (package*.json, tsconfig*, eslint/vitest/prettier config, this file)
    // matches no rule and runs every step, except a package.json / package-lock.json whose
    // only change is the version: that fires versionBumpTriggers instead.
  ],
  versionBumpTriggers: ['format'],
  steps: [
    { label: 'format', run: 'npx prettier --check .', when: ['format'], supersededBy: ['lint'] },
    { label: 'lint', run: 'npm run lint', when: ['lint'] },
    { label: 'typecheck', run: 'npm run typecheck', when: ['typecheck'] },
    { label: 'test', run: 'npm test', when: ['test'], policeStderr: true },
    // chreode is not installed in its own node_modules; `npm run signoff` builds dist/ first.
    {
      ...timingStep({ when: ['test'] }),
      run: ({ head }) => `node dist/cli.js timing-check --head ${head}`
    },
    { label: 'lint:workflows', run: 'actionlint', when: ['workflows'] }
  ],
  timing: {
    allow: [
      {
        path: 'src/timing/**/*.spec.ts',
        rule: 'fixed-wait',
        reason: 'rule fixtures: banned text as data'
      },
      {
        path: 'src/timing/**/*.spec.ts',
        rule: 'timeout-raise',
        reason: 'rule fixtures: banned text as data'
      },
      {
        path: 'src/timing/**/*.spec.ts',
        rule: 'retries-raise',
        reason: 'rule fixtures: banned text as data'
      },
      {
        path: 'src/timing/**/*.spec.ts',
        rule: 'skip',
        reason: 'rule fixtures: banned text as data'
      }
    ]
  },
  afterMerge: 'npx -y npm@11.21.0 ci'
};

export default config;
