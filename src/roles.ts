import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_READ_TOOLS, projectDir, userDir, type Config } from './config.js';
import type { Role } from './types.js';

/** `compact` runs Claude's /compact on a role's session; it needs no tools. */
export type TurnMode = 'stage' | 'side' | 'compact';

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/** Git operations that change anything. Denied for every role: the user commits manually. */
const GIT_WRITE = [
  'commit', 'add', 'push', 'branch', 'checkout', 'switch', 'stash', 'reset',
  'merge', 'rebase', 'tag', 'cherry-pick', 'clean', 'restore', 'pull', 'fetch',
].map((c) => `Bash(git ${c}:*)`);

/**
 * Arguments to resume a role's own session in an interactive `claude`. The user drives it, so no allow-list
 * or permission mode is imposed, but the role's hard limits stay (Tech Lead can't edit; nobody writes git).
 */
export function interactiveArgs(role: Role, config: Config, cwd: string, sessionId: string): string[] {
  const disallowed = toolPolicy(role, config, 'stage').disallowed;
  return [
    '--resume', sessionId,
    '--model', config.roles[role].model,
    '--append-system-prompt', loadPrompt(role, cwd, config),
    ...(disallowed.length ? ['--disallowedTools', disallowed.join(',')] : []),
  ];
}

export interface ToolPolicy {
  allowed: string[];
  disallowed: string[];
  permissionMode: string;
}

export function toolPolicy(role: Role, config: Config, mode: TurnMode): ToolPolicy {
  if (mode !== 'stage') {
    // Side chat (and compaction) is read-only for BOTH roles, whatever the config says.
    return {
      allowed: ['Read', 'Grep', 'Glob', ...GIT_READ_TOOLS],
      disallowed: [...WRITE_TOOLS, ...GIT_WRITE],
      permissionMode: 'dontAsk',
    };
  }
  const rc = config.roles[role];
  if (role === 'techlead') {
    // Tech Lead can never modify the project, even if the config tries to allow it.
    const allowed = rc.allowedTools.filter((t) => !['Edit', 'Write', 'NotebookEdit', 'Bash'].includes(t));
    return { allowed, disallowed: [...WRITE_TOOLS, ...GIT_WRITE], permissionMode: rc.permissionMode };
  }
  return { allowed: rc.allowedTools, disallowed: GIT_WRITE, permissionMode: rc.permissionMode };
}

function expand(p: string, cwd: string): string {
  return resolve(cwd, p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
}

export function builtinPromptDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../prompts', '../../prompts']) {
    const d = resolve(here, rel);
    if (existsSync(d)) return d;
  }
  return resolve(here, '../prompts');
}

/** Resolution order: config file → project override → user override → built-in. */
export function promptPath(role: Role, cwd: string, config: Config): string {
  const candidates = [
    config.roles[role].systemPromptFile ? expand(config.roles[role].systemPromptFile!, cwd) : null,
    join(projectDir(cwd), 'prompts', `${role}.md`),
    join(userDir(), 'prompts', `${role}.md`),
    join(builtinPromptDir(), `${role}.md`),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`No system prompt found for role "${role}" (looked in: ${candidates.join(', ')})`);
  return found;
}

export function loadPrompt(role: Role, cwd: string, config: Config): string {
  return readFileSync(promptPath(role, cwd, config), 'utf8');
}
