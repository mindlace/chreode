import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Driven by test/integration/reporters.spec.ts. No browser: the test uses no page fixture.
export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  retries: 1,
  workers: 1,
  // Outside the repo, so a run never dirties the tree.
  outputDir: process.env.PW_OUTPUT_DIR,
  reporter: [
    ['line'],
    [fileURLToPath(new URL('../../../src/reporters/playwright.ts', import.meta.url))]
  ]
});
