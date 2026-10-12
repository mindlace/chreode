import { describe, expect, it } from 'vitest';
import { defineConfig } from './index.js';

describe('defineConfig', () => {
  it('returns the config it was given, so a config file can default-export it', () => {
    const config = { steps: [{ label: 'lint', run: 'npm run lint', when: ['lint'] }] };
    expect(defineConfig(config)).toBe(config);
  });
});
