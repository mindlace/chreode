import type { ChreodeConfig } from './src/index.js';

// chreode gates itself, from this checkout's own build (`npm run signoff` builds first).
const config: ChreodeConfig = {
  rules: [
    // Prettier-ignored; nothing checks these.
    { match: ['docs/superpowers/**', 'LICENSE', '.nvmrc'], triggers: [] },
    { match: ['**/*.md'], triggers: ['format'] },
    { match: ['src/**', 'test/**'], triggers: ['lint', 'typecheck', 'test'] },
    { match: ['.github/workflows/**'], triggers: ['format', 'workflows'] }
    // Everything else (package*.json, tsconfig*, eslint/vitest/prettier config, this file)
    // matches no rule and runs every step.
  ],
  steps: [
    { label: 'format', run: 'npx prettier --check .', when: ['format'], supersededBy: ['lint'] },
    { label: 'lint', run: 'npm run lint', when: ['lint'] },
    { label: 'typecheck', run: 'npm run typecheck', when: ['typecheck'] },
    { label: 'test', run: 'npm test', when: ['test'], policeStderr: true },
    { label: 'lint:workflows', run: 'actionlint', when: ['workflows'] }
  ],
  afterMerge: 'npx -y npm@11.21.0 ci'
};

export default config;
