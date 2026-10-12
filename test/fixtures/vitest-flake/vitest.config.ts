import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import VitestFlakeReporter from '../../../src/reporters/vitest.js';

// Driven by test/integration/reporters.spec.ts.
export default defineConfig({
  test: {
    name: 'smoke',
    root: dirname(fileURLToPath(import.meta.url)),
    include: ['*.fixture.ts'],
    retry: 1,
    reporters: ['default', new VitestFlakeReporter()]
  }
});
