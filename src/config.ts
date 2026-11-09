import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Role } from './types.js';

export interface RoleConfig {
  model: string;
  systemPromptFile: string | null;
  allowedTools: string[];
  permissionMode: string;
}

export interface Config {
  roles: Record<Role, RoleConfig>;
  workflow: {
    autoApprove: boolean;
    maxFixIterations: number;
    maxReviewIterations: number;
    /** Compact both roles' conversations when a requirement finishes. */
    autoCompact: boolean;
  };
  testCommand: string | null;
  /** Project-relative folder for the Tech Lead's documents (requirements, design, review). */
  docsDir: string;
  ui: { layout: 'auto' | 'split' | 'tabs'; splitMinColumns: number; autoFocus: boolean };
}

export const GIT_READ_TOOLS = [
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
];

export const DEFAULT_CONFIG: Config = {
  roles: {
    techlead: {
      model: 'opus',
      systemPromptFile: null,
      allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', ...GIT_READ_TOOLS],
      permissionMode: 'dontAsk',
    },
    dev: {
      model: 'sonnet',
      systemPromptFile: null,
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      permissionMode: 'acceptEdits',
    },
  },
  workflow: { autoApprove: false, maxFixIterations: 3, maxReviewIterations: 2, autoCompact: true },
  testCommand: null,
  docsDir: 'docs',
  ui: { layout: 'auto', splitMinColumns: 120, autoFocus: true },
};

export type Scope = 'user' | 'project';
export type Source = 'default' | 'user' | 'project' | 'flag';

export function userDir(): string {
  return process.env.CD_AGENTS_HOME || join(homedir(), '.cd-agents');
}
export function projectDir(cwd: string): string {
  return join(cwd, '.cd-agents');
}
export function configFile(scope: Scope, cwd: string): string {
  return join(scope === 'user' ? userDir() : projectDir(cwd), 'config.json');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge((base as Obj)[k], v) : v;
  return out as T;
}

function readJson(file: string): Obj {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return isObj(v) ? v : {};
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

/** Leaf paths ("roles.dev.model", "roles.dev.allowedTools" — arrays are leaves). */
export function leafPaths(o: unknown, prefix = ''): string[] {
  if (!isObj(o)) return [prefix];
  return Object.entries(o).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

export function getPath(o: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), o);
}

function setPathMut(o: Obj, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur = o;
  for (const p of parts.slice(0, -1)) {
    if (!isObj(cur[p])) cur[p] = {};
    cur = cur[p] as Obj;
  }
  cur[parts[parts.length - 1]!] = value;
}

export interface Loaded {
  config: Config;
  sources: Record<string, Source>;
}

/** Precedence (highest first): flags > project > user > defaults. */
export function loadConfig(cwd: string, flags: Obj = {}): Loaded {
  const user = readJson(configFile('user', cwd));
  const project = readJson(configFile('project', cwd));
  const config = [user, project, flags].reduce<Config>((acc, layer) => deepMerge(acc, layer), DEFAULT_CONFIG);
  const sources: Record<string, Source> = {};
  for (const p of leafPaths(DEFAULT_CONFIG)) {
    sources[p] = getPath(flags, p) !== undefined ? 'flag'
      : getPath(project, p) !== undefined ? 'project'
      : getPath(user, p) !== undefined ? 'user' : 'default';
  }
  return { config, sources };
}

export function parseValue(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

const ENUMS: Record<string, string[]> = { 'ui.layout': ['auto', 'split', 'tabs'] };

export function validateValue(key: string, value: unknown): void {
  if (!leafPaths(DEFAULT_CONFIG).includes(key)) {
    throw new Error(`Unknown config key "${key}". Run "cd-agents config show" to see valid keys.`);
  }
  const def = getPath(DEFAULT_CONFIG, key);
  if (def === null) {
    if (value !== null && typeof value !== 'string') throw new Error(`"${key}" must be a string or null.`);
  } else if (Array.isArray(def)) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new Error(`"${key}" must be a JSON array of strings.`);
    }
  } else if (typeof value !== typeof def) {
    throw new Error(`"${key}" must be a ${typeof def}.`);
  }
  if (key === 'docsDir' && (typeof value !== 'string' || !value.trim() || value.startsWith('/') || value.split(/[\\/]/).includes('..'))) {
    throw new Error('docsDir must be a non-empty path inside the project (relative, no "..").');
  }
  if (key.endsWith('.model') && (typeof value !== 'string' || !value.trim())) {
    throw new Error('Model must be a non-empty string.');
  }
  if (ENUMS[key] && !ENUMS[key].includes(value as string)) {
    throw new Error(`"${key}" must be one of: ${ENUMS[key].join(', ')}.`);
  }
  if (/Iterations$/.test(key) && !(Number.isInteger(value) && (value as number) >= 0)) {
    throw new Error(`"${key}" must be a non-negative integer.`);
  }
}

export function setConfigValue(scope: Scope, cwd: string, key: string, raw: string): void {
  const value = parseValue(raw);
  validateValue(key, value);
  const file = configFile(scope, cwd);
  const cur = readJson(file);
  setPathMut(cur, key, value);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
}

export function resetConfig(scope: Scope, cwd: string): void {
  rmSync(configFile(scope, cwd), { force: true });
}

/** The Tech Lead must stay read-only. Returns warnings for config that breaks that. */
export function techleadWarnings(config: Config): string[] {
  const bad = config.roles.techlead.allowedTools.filter(
    (t) => ['Edit', 'Write', 'NotebookEdit', 'Bash'].includes(t),
  );
  return bad.map(
    (t) => `roles.techlead.allowedTools contains "${t}", which can modify the project. The Tech Lead must stay read-only; "${t}" will be ignored.`,
  );
}
