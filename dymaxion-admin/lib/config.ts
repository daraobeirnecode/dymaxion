// Reads Dymaxion YAML config files from CONFIG_DIR (default /workspace/config).
// Read-only — the dashboard never writes config.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export const CONFIG_DIR = process.env.CONFIG_DIR ?? '/workspace/config';

export interface ConfigFileResult {
  name: string;
  path: string;
  raw: string | null;
  parsed: unknown | null;
  error: string | null;
}

export async function readConfigFile(fileName: string): Promise<ConfigFileResult> {
  const filePath = path.join(CONFIG_DIR, fileName);
  try {
    const raw = await readFile(filePath, 'utf8');
    let parsed: unknown = null;
    let error: string | null = null;
    try {
      parsed = YAML.parse(raw);
    } catch (e) {
      error = `YAML parse error: ${e instanceof Error ? e.message : String(e)}`;
    }
    return { name: fileName, path: filePath, raw, parsed, error };
  } catch {
    return {
      name: fileName,
      path: filePath,
      raw: null,
      parsed: null,
      error: 'config not mounted',
    };
  }
}
