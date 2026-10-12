import { existsSync } from 'node:fs';
import { createJiti } from 'jiti';
import type { ResolvedConfig } from './types.js';
import { ConfigError, validateConfig } from './validate.js';

export const CONFIG_FILE = 'chreode.config.ts';

/** Load and validate a config file. jiti transpiles TypeScript on the fly, so consumers
 *  need no build step and no tsx. */
export async function loadConfig(file: string): Promise<ResolvedConfig> {
  if (!existsSync(file)) throw new ConfigError([`no config file at ${file}`]);
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
  const mod: unknown = await jiti.import(file, { default: true });
  return validateConfig(mod);
}
