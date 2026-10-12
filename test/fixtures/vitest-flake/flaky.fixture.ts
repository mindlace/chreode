import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('fails once, then passes', () => {
    const marker = process.env.FLAKE_MARKER ?? '';
    const first = !existsSync(marker);
    if (first) writeFileSync(marker, '1');
    expect(first, 'first attempt fails on purpose').toBe(false);
  });
});
