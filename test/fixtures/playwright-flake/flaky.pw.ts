import { existsSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.describe('smoke', () => {
  test('fails once, then passes', () => {
    const marker = process.env.FLAKE_MARKER ?? '';
    const first = !existsSync(marker);
    if (first) writeFileSync(marker, '1');
    expect(first, 'first attempt fails on purpose').toBe(false);
  });
});
