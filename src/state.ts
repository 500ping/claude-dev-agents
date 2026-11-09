import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectDir } from './config.js';
import type { Entry, Role, StageId } from './types.js';
import type { Task } from './stages.js';

export interface RunState {
  id: string;
  requirement: string;
  /** Project-relative folder holding the Tech Lead's documents (absent in runs from before this existed). */
  docsDir?: string;
  /** Stage to run next / currently in progress. */
  stage: StageId | 'done';
  /** 'gate' → the stage artifact exists and is waiting for approval. */
  phase: 'running' | 'gate';
  aborted: boolean;
  sessions: Record<Role, { id: string; started: boolean }>;
  /** Number of review→fix rounds completed. */
  fixesDone: number;
  wontFix: number[];
  /** Senior Dev's final message per stage (`implement`, `test`, `fix-1`, …). Kept here, not as files. */
  notes: Record<string, string>;
  tasks: Task[];
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export const runsDir = (cwd: string) => join(projectDir(cwd), 'runs');

export function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return slug || 'run';
}

export function newRunId(requirement: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${slugify(requirement)}`;
}

/** Documents written by the Tech Lead; they live in the project's docs folder, not the run folder. */
export const isTechLeadDoc = (name: string): boolean => /^(requirements|design|review(-\d+)?)\.md$/.test(name);

/** `docs/<slug>`, or `docs/<slug>-2`, … if that folder already exists. */
export function pickDocsDir(cwd: string, base: string, requirement: string): string {
  const root = base.replace(/\/+$/, '');
  const slug = slugify(requirement);
  let rel = `${root}/${slug}`;
  for (let n = 2; existsSync(join(cwd, rel)); n++) rel = `${root}/${slug}-${n}`;
  return rel;
}

export class RunStore {
  readonly dir: string;
  readonly docs?: string;
  constructor(cwd: string, readonly id: string, docsDir?: string) {
    this.dir = join(runsDir(cwd), id);
    mkdirSync(this.dir, { recursive: true });
    if (docsDir) this.docs = join(cwd, docsDir);
  }
  path(name: string): string {
    return this.docs && isTechLeadDoc(name) ? join(this.docs, name) : join(this.dir, name);
  }
  write(name: string, content: string): string {
    const p = this.path(name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content.endsWith('\n') ? content : content + '\n');
    return p;
  }
  read(name: string): string | undefined {
    const p = this.path(name);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  }
  saveState(s: RunState): void {
    s.updatedAt = new Date().toISOString();
    writeFileSync(this.path('state.json'), JSON.stringify(s, null, 2) + '\n');
  }
  appendEntry(role: Role, e: Entry): void {
    appendFileSync(this.path(`${role}.jsonl`), JSON.stringify(e) + '\n');
  }
  appendEvent(ev: Record<string, unknown>): void {
    appendFileSync(this.path('events.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...ev }) + '\n');
  }
  loadEntries(role: Role): Entry[] {
    const raw = this.read(`${role}.jsonl`);
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Entry]; } catch { return []; } });
  }
  /** Artifact file names across the run folder and the docs folder. */
  artifacts(): string[] {
    const inRun = readdirSync(this.dir).filter((f) => (f.endsWith('.md') && !isTechLeadDoc(f)) || f === 'requirement.txt');
    const inDocs = this.docs && existsSync(this.docs) ? readdirSync(this.docs).filter(isTechLeadDoc) : [];
    return [...inDocs, ...inRun].sort();
  }
}

export function loadRunState(cwd: string, id: string): RunState | undefined {
  const f = join(runsDir(cwd), id, 'state.json');
  if (!existsSync(f)) return undefined;
  return JSON.parse(readFileSync(f, 'utf8')) as RunState;
}

export function listRuns(cwd: string): string[] {
  const d = runsDir(cwd);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => existsSync(join(d, n, 'state.json'))).sort();
}
