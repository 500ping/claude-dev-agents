import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Changes {
  isGit: boolean;
  /** Unified diff of tracked changes plus the content of new (untracked) text files. */
  text: string;
  files: string[];
  truncated: boolean;
}

const MAX_TOTAL = 150_000;
const MAX_NEW_FILE = 30_000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.error || r.status !== 0 ? null : r.stdout;
}

/**
 * What the Senior Dev changed, for the Tech Lead's review. Read-only git only.
 * `exclude` are project-relative paths (e.g. `.cd-agents`, the docs folder) left out of the result.
 */
export function collectChanges(cwd: string, exclude: string[] = []): Changes {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') {
    return { isGit: false, text: '', files: [], truncated: false };
  }
  const spec = ['--', '.', ...exclude.map((e) => `:(exclude)${e}`)];
  const base = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']) ? 'HEAD' : EMPTY_TREE;
  const diff = git(cwd, ['diff', '--no-color', base, ...spec]) ?? '';
  const changed = (git(cwd, ['diff', '--name-only', base, ...spec]) ?? '').split('\n').filter(Boolean);
  const untracked = (git(cwd, ['ls-files', '--others', '--exclude-standard', ...spec]) ?? '').split('\n').filter(Boolean);

  const parts = [diff];
  for (const f of untracked) {
    let body: string;
    try {
      const p = join(cwd, f);
      const size = statSync(p).size;
      const buf = readFileSync(p);
      if (buf.includes(0)) body = '(binary file)';
      else if (size > MAX_NEW_FILE) body = buf.subarray(0, MAX_NEW_FILE).toString('utf8') + `\n… (${size - MAX_NEW_FILE} more bytes)`;
      else body = buf.toString('utf8');
    } catch { body = '(unreadable)'; }
    parts.push(`\n=== new file: ${f} ===\n${body}\n`);
  }
  let text = parts.join('');
  let truncated = false;
  if (text.length > MAX_TOTAL) {
    truncated = true;
    text = text.slice(0, MAX_TOTAL) + `\n… (truncated; use \`git diff -- <file>\` for the rest)`;
  }
  return { isGit: true, text, files: [...changed, ...untracked], truncated };
}
