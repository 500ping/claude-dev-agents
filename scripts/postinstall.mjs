#!/usr/bin/env node
// Runs as `postinstall`: create ~/.cd-agents with a minimal config. Never overwrites existing files.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

try {
  const dir = process.env.CD_AGENTS_HOME || join(homedir(), '.cd-agents');
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  const file = join(dir, 'config.json');
  if (!existsSync(file)) {
    const cfg = { roles: { techlead: { model: 'opus' }, dev: { model: 'sonnet' } } };
    writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
} catch {
  // Never fail an install because of the config directory.
}
