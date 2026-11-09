import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';

export const FAKE = resolve(import.meta.dirname, 'fake-claude.mjs');

/** autoCompact is off by default so tests can assert the exact call sequence; dedicated tests turn it on. */
export function setup(env: Record<string, string> = {}, autoApprove = false, autoCompact = false) {
  const root = mkdtempSync(join(tmpdir(), 'cda-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  Object.assign(process.env, {
    CD_AGENTS_HOME: home,
    CD_AGENTS_CLAUDE_BIN: FAKE,
    FAKE_CLAUDE_LOG: join(root, 'calls.jsonl'),
    FAKE_ASK: '', FAKE_VERDICTS: '', FAKE_TEST_RESULT: '', FAKE_FAIL_STAGE: '',
    ...env,
  });
  return import('node:fs').then((fs) => {
    fs.mkdirSync(cwd, { recursive: true });
    const { config } = loadConfig(cwd);
    config.workflow.autoCompact = autoCompact;
    const engine = new Engine({ cwd, config, autoApprove });
    const calls = () => existsSync(process.env.FAKE_CLAUDE_LOG!)
      ? readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { root, cwd, home, engine, calls };
  });
}

export async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Wait for the next gate (optionally of a given stage) and return it. */
export const nextGate = (e: Engine, stage?: string) =>
  until(() => e.gate && (!stage || e.gate.stage === stage) ? e.gate : undefined);
