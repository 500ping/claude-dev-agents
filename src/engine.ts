import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectChanges } from './changes.js';
import { claudeBin, runClaude, type RunResult } from './claude.js';
import { setConfigValue, validateValue, type Config, type Scope } from './config.js';
import { interactiveArgs, loadPrompt, toolPolicy, type TurnMode } from './roles.js';
import {
  NUDGE, NUDGE_RESULT, STAGES, buildStagePrompt, extractArtifact, extractFolder, isBlocked, noteKey, parseTasks, parseTestResult,
  parseVerdict, versionedName, wrapSideChat, wrapUserReply, type PromptCtx,
} from './stages.js';
import {
  RunStore, listRuns, loadRunState, newRunId, pickDocsDir, topicSlug, type RunState,
} from './state.js';
import { ROLES, ROLE_LABEL, type Entry, type EntryKind, type Role, type StageId, type Status } from './types.js';

export interface GateOption { key: string; label: string; needsText?: boolean }
export interface Gate {
  title: string;
  stage: StageId | null;
  /** Absolute path of the artifact under review. */
  artifact?: string;
  warning?: string;
  /** Forced gates are never skipped by auto-approve. */
  force: boolean;
  options: GateOption[];
}
export interface GateDecision { key: string; text?: string }

export interface RunSummary {
  id: string;
  requirement: string;
  /** Stage the run stopped at, or `done`. */
  stage: string;
  aborted: boolean;
  updatedAt: string;
  costUsd: number;
  docsDir?: string;
}

export interface EngineOptions {
  cwd: string;
  config: Config;
  autoApprove: boolean;
}

class AbortRun extends Error {}

interface Deferred<T> { resolve: (v: T) => void; reject: (e: Error) => void }

interface RoleRuntime {
  sessionId: string;
  started: boolean;
  abort?: AbortController;
  pending: number;
  chain: Promise<unknown>;
  stageQueue: string[];
}

const NORMAL_OPTIONS: GateOption[] = [
  { key: 'a', label: 'Approve & continue' },
  { key: 'r', label: 'Reject with feedback', needsText: true },
  { key: 'e', label: 'Edit artifact' },
  { key: 'v', label: 'View full' },
  { key: 'q', label: 'Abort' },
];

export class Engine extends EventEmitter {
  config: Config;
  autoApprove: boolean;
  readonly cwd: string;

  panes: Record<Role, Entry[]> = { techlead: [], dev: [] };
  status: Record<Role, Status> = { techlead: 'idle', dev: 'idle' };
  stage: StageId | 'idle' | 'done' | 'aborted' = 'idle';
  /** Role whose stage turn is currently executing (undefined at gates / idle). */
  stageRole?: Role;
  gate?: Gate;
  tasks: RunState['tasks'] = [];
  activeTask?: string;
  costUsd = 0;
  run?: { store: RunStore; state: RunState };

  private nextId = 1;
  private openText: Record<Role, Entry | null> = { techlead: null, dev: null };
  private rt: Record<Role, RoleRuntime>;
  private waiter?: { role: Role } & Deferred<string>;
  private gateWaiter?: Deferred<GateDecision>;
  private workflowPromise: Promise<void> = Promise.resolve();
  private workflowActive = false;
  private aborted = false;

  constructor(opts: EngineOptions) {
    super();
    this.cwd = opts.cwd;
    this.config = structuredClone(opts.config);
    this.autoApprove = opts.autoApprove;
    this.rt = {
      techlead: this.newRuntime(),
      dev: this.newRuntime(),
    };
  }

  private newRuntime(): RoleRuntime {
    return { sessionId: randomUUID(), started: false, pending: 0, chain: Promise.resolve(), stageQueue: [] };
  }

  // ───────────────────────────── public API ─────────────────────────────

  /** Resolves when the current workflow has finished, aborted or is idle. */
  whenSettled(): Promise<void> { return this.workflowPromise; }
  get running(): boolean { return this.workflowActive; }

  /** Entry point for everything the user types into a pane (non-slash). */
  submit(role: Role, text: string): void {
    const t = text.trim();
    if (!t) return;
    this.push(role, 'user', t);

    if (!this.run && role === 'techlead') return this.startRun(t);
    if (this.waiter && this.waiter.role === role) {
      const w = this.waiter;
      this.waiter = undefined;
      return w.resolve(t);
    }
    if (this.stageRole === role) {
      // The role is busy on its stage: deliver as part of that stage after its current turn.
      this.rt[role].stageQueue.push(t);
      this.note(role, 'queued — will be delivered when the current turn finishes');
      return;
    }
    if (this.stage === 'done' && role === 'techlead') {
      this.note(role, 'Run complete. Type /new to start another requirement.');
    }
    void this.sideChat(role, t);
  }

  interrupt(role: Role): void {
    const rt = this.rt[role];
    if (rt.abort) rt.abort.abort();
  }

  /** Answer the open gate. `v` and `e` don't close it. */
  decide(key: string, text?: string): void {
    const g = this.gate;
    if (!g) return;
    if (!g.options.some((o) => o.key === key)) return;
    if (key === 'v') return this.viewArtifact();
    if (key === 'e') {
      if (g.artifact) this.emit('edit', g.artifact);
      return;
    }
    if (g.options.find((o) => o.key === key)?.needsText && !text?.trim()) return;
    const w = this.gateWaiter;
    this.gate = undefined;
    this.gateWaiter = undefined;
    this.emit('gate-closed');
    this.emit('change');
    w?.resolve({ key, text });
  }

  abort(): void {
    this.aborted = true;
    for (const r of ROLES) this.rt[r].abort?.abort();
    const err = new AbortRun();
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w.reject(err); }
    if (this.gateWaiter) {
      const w = this.gateWaiter;
      this.gate = undefined;
      this.gateWaiter = undefined;
      this.emit('gate-closed');
      w.reject(err);
    }
  }

  setAutoApprove(on: boolean): void {
    this.autoApprove = on;
    if (on && this.gate && !this.gate.force) this.decide('a');
    this.emit('change');
  }

  setModel(role: Role, model: string, save?: Scope): void {
    if (!model.trim()) throw new Error('Model must not be empty.');
    this.config.roles[role].model = model.trim();
    if (save) setConfigValue(save, this.cwd, `roles.${role}.model`, JSON.stringify(model.trim()));
    this.emit('change');
  }

  /** `null` goes back to Claude's default effort. */
  setEffort(role: Role, effort: string | null, save?: Scope): void {
    validateValue(`roles.${role}.effort`, effort);
    this.config.roles[role].effort = effort;
    if (save) setConfigValue(save, this.cwd, `roles.${role}.effort`, JSON.stringify(effort));
    this.emit('change');
  }

  setWontFix(nums: number[]): void {
    if (!this.run) return;
    this.run.state.wontFix = nums;
    this.saveState();
  }

  clearPane(role: Role): void {
    this.closeText(role);
    this.panes[role] = [];
    this.emit('change');
  }

  note(role: Role, text: string): void { this.push(role, 'marker', text); }

  /**
   * Start a new requirement. The current run stays on disk.
   *
   * By default both roles keep their Claude conversations (already compacted when the last requirement
   * finished), so earlier work stays in context. `fresh` starts clean conversations instead.
   */
  newRun(opts: { fresh?: boolean } = {}): boolean {
    if (this.workflowActive) return false;
    const hadConversation = ROLES.some((r) => this.rt[r].started);
    this.panes = { techlead: [], dev: [] };
    this.openText = { techlead: null, dev: null };
    this.status = { techlead: 'idle', dev: 'idle' };
    this.run = undefined;
    this.stage = 'idle';
    this.tasks = [];
    this.costUsd = 0;
    this.aborted = false;
    if (opts.fresh) {
      this.rt = { techlead: this.newRuntime(), dev: this.newRuntime() };
    } else {
      // Same runtime objects: keeps session ids, and keeps any in-flight turn serialised on its session.
      for (const r of ROLES) this.rt[r].stageQueue = [];
    }
    if (hadConversation) {
      this.note('techlead', opts.fresh
        ? 'New chat with fresh conversations. Earlier requirements are listed to the Tech Lead, who can read their docs.'
        : "↻ New requirement — continuing both roles' conversations (compacted at the end of the last one). Use /new fresh for a clean slate.");
    }
    this.emit('change');
    return true;
  }

  /**
   * Earlier requirements in this project that have documents, newest first, for the Tech Lead's
   * clarify prompt — so related work can be found even when conversations were reset or compacted.
   */
  private previousWork(limit = 5): string[] {
    const day = (iso: string) => iso.slice(0, 10);
    return this.runSummaries()
      .filter((r) => r.id !== this.run?.state.id && r.docsDir && existsSync(join(this.cwd, r.docsDir, 'requirements.md')))
      .slice(0, limit)
      .map((r) => {
        const req = (r.requirement.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
        const state = r.stage === 'done' ? 'done' : `stopped at ${r.stage}`;
        return `${day(r.updatedAt)} "${req.length > 120 ? req.slice(0, 117) + '…' : req}" (${state}) — docs: ${r.docsDir}/`;
      });
  }

  runIds(): string[] { return listRuns(this.cwd); }

  /** Saved runs in this project, newest first. */
  runSummaries(): RunSummary[] {
    const out: RunSummary[] = [];
    for (const id of this.runIds()) {
      try {
        const s = loadRunState(this.cwd, id);
        if (s) out.push({ id, requirement: s.requirement, stage: s.stage, aborted: !!s.aborted, updatedAt: s.updatedAt, costUsd: s.costUsd ?? 0, docsDir: s.docsDir });
      } catch { /* unreadable run: skip */ }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Resume a saved run from its last completed gate. */
  resume(id?: string): boolean {
    if (this.workflowActive) return false;
    const ids = this.runIds();
    const runId = id ?? ids[ids.length - 1];
    if (!runId) { this.note('techlead', 'No saved runs to resume.'); return false; }
    const state = loadRunState(this.cwd, runId);
    if (!state) { this.note('techlead', `Run "${runId}" not found.`); return false; }

    this.newRun({ fresh: true });
    const store = new RunStore(this.cwd, runId, state.docsDir);
    state.aborted = false;
    state.notes ??= {};
    this.run = { store, state };
    for (const r of ROLES) {
      this.panes[r] = store.loadEntries(r);
      this.rt[r].sessionId = state.sessions[r].id;
      this.rt[r].started = state.sessions[r].started;
    }
    this.nextId = Math.max(0, ...ROLES.flatMap((r) => this.panes[r].map((e) => e.id))) + 1;
    this.tasks = state.tasks ?? [];
    this.costUsd = state.costUsd ?? 0;
    this.note('techlead', `Resumed run ${runId}.`);
    this.note('dev', `Resumed run ${runId}.`);
    if (state.stage === 'done') {
      this.stage = 'done';
      for (const r of ROLES) this.status[r] = 'done';
      this.emit('change');
      return true;
    }
    this.startWorkflow(state.stage, state.phase === 'gate');
    return true;
  }

  /**
   * Hand a role's own Claude session to an interactive `claude` (the caller runs it with the terminal).
   * While it is open no other turn runs on that role's session; call `release()` when claude exits.
   */
  openInteractive(role: Role): { spec: { bin: string; args: string[]; cwd: string }; release: () => void } | { error: string } {
    const rt = this.rt[role];
    const label = role === 'techlead' ? 'Tech Lead' : 'Senior Dev';
    if (!rt.started) return { error: `The ${label} has no conversation yet — nothing to resume.` };
    if (rt.pending > 0) return { error: `The ${label} is busy. Wait for it to finish, or press Esc to interrupt it, then try again.` };
    let args: string[];
    try { args = interactiveArgs(role, this.config, this.cwd, rt.sessionId); } catch (e) { return { error: (e as Error).message }; }
    // Hold this role's queue until the interactive session is closed.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    rt.pending++;
    rt.chain = rt.chain.then(() => held);
    let done = false;
    return {
      spec: { bin: claudeBin(), args, cwd: this.cwd },
      release: () => {
        if (done) return;
        done = true;
        rt.pending--;
        release();
        this.note(role, '↩ Back from Claude Code. What you said there isn\'t shown in this pane, but the role remembers it.');
      },
    };
  }

  /** Compact a role's Claude session (Claude Code's /compact). Queued behind any turn in progress. */
  compact(role: Role | 'all', instructions?: string): Promise<void> {
    const roles = role === 'all' ? ROLES : [role];
    const jobs: Promise<unknown>[] = [];
    for (const r of roles) {
      const label = r === 'techlead' ? 'Tech Lead' : 'Senior Dev';
      if (!this.rt[r].started) { this.note(r, `Nothing to compact yet: the ${label} has no conversation.`); continue; }
      this.note(r, this.rt[r].pending > 0 ? 'compacting… (queued behind the current turn)' : 'compacting context…');
      const prompt = `/compact${instructions?.trim() ? ' ' + instructions.trim() : ''}`;
      jobs.push(this.turn(r, prompt, 'compact'));
    }
    return Promise.all(jobs).then(() => undefined);
  }

  describe(): string {
    const s = this.run?.state;
    const lines = [
      `run:     ${s?.id ?? '(none yet)'}`,
      `stage:   ${this.stage}${this.tasks.length ? ` (${this.tasks.filter((t) => t.done).length}/${this.tasks.length} tasks)` : ''}`,
      `models:  Tech Lead = ${this.config.roles.techlead.model} · Senior Dev = ${this.config.roles.dev.model}`,
      `approve: ${this.autoApprove ? 'auto' : 'manual'}`,
      `cost:    $${this.costUsd.toFixed(4)}`,
    ];
    if (this.run) lines.push(`dir:     ${this.run.store.dir}`);
    return lines.join('\n');
  }

  artifactList(): string[] {
    return this.run ? this.run.store.artifacts().map((f) => this.run!.store.path(f)) : [];
  }

  // ───────────────────────────── entries ─────────────────────────────

  private push(role: Role, kind: EntryKind, text: string, detail?: string): Entry {
    this.closeText(role);
    const e: Entry = { id: this.nextId++, kind, text, ...(detail ? { detail } : {}) };
    this.panes[role].push(e);
    this.persist(role, e);
    this.emit('change');
    return e;
  }

  private appendText(role: Role, t: string): void {
    let e = this.openText[role];
    if (!e) {
      e = { id: this.nextId++, kind: 'text', text: '' };
      this.panes[role].push(e);
      this.openText[role] = e;
    }
    e.text += t;
    this.emit('change');
  }

  private closeText(role: Role): void {
    const e = this.openText[role];
    if (!e) return;
    this.openText[role] = null;
    if (e.text.trim()) this.persist(role, e);
    else this.panes[role] = this.panes[role].filter((x) => x !== e);
  }

  private persist(role: Role, e: Entry): void {
    this.run?.store.appendEntry(role, e);
  }

  private setStatus(role: Role, s: Status): void {
    if (this.status[role] === s) return;
    this.status[role] = s;
    this.emit('change');
  }

  private saveState(): void {
    if (!this.run) return;
    const s = this.run.state;
    for (const r of ROLES) s.sessions[r] = { id: this.rt[r].sessionId, started: this.rt[r].started };
    s.tasks = this.tasks;
    s.costUsd = this.costUsd;
    this.run.store.saveState(s);
  }

  // ───────────────────────────── run lifecycle ─────────────────────────────

  private startRun(requirement: string): void {
    const id = newRunId(requirement);
    const docsDir = pickDocsDir(this.cwd, this.config.docsDir, topicSlug(requirement));
    const store = new RunStore(this.cwd, id, docsDir);
    const state: RunState = {
      id, requirement, docsDir, stage: 'clarify', phase: 'running', aborted: false,
      sessions: {
        techlead: { id: this.rt.techlead.sessionId, started: this.rt.techlead.started },
        dev: { id: this.rt.dev.sessionId, started: this.rt.dev.started },
      },
      fixesDone: 0, wontFix: [], notes: {}, tasks: [], costUsd: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    for (const r of ROLES) this.closeText(r);
    this.run = { store, state };
    store.write('requirement.txt', requirement);
    for (const r of ROLES) for (const e of this.panes[r]) store.appendEntry(r, e);
    this.saveState();
    this.gitignoreHint();
    this.startWorkflow('clarify', false);
  }

  private gitignoreHint(): void {
    try {
      const gi = join(this.cwd, '.gitignore');
      if (existsSync(join(this.cwd, '.git')) && !(existsSync(gi) && readFileSync(gi, 'utf8').includes('.cd-agents'))) {
        this.note('techlead', 'Tip: add ".cd-agents/runs/" to your .gitignore.');
      }
    } catch { /* hint only */ }
  }

  private startWorkflow(from: StageId, atGate: boolean): void {
    this.aborted = false;
    this.workflowActive = true;
    this.workflowPromise = this.workflow(from, atGate).finally(() => {
      this.workflowActive = false;
      this.stageRole = undefined;
      this.emit('change');
      this.emit('settled');
    });
  }

  private get state(): RunState { return this.run!.state; }
  private get store(): RunStore { return this.run!.store; }

  /** File the role delivers for this stage, or null for Senior Dev stages (their message is the report). */
  private artifactFile(stage: StageId): string | null {
    const base = STAGES[stage].artifact;
    if (!base) return null;
    return stage === 'review' ? versionedName(base, this.state.fixesDone + 1) : base;
  }

  /**
   * The Tech Lead names the docs folder when it delivers the requirements. Until the first document is written the
   * folder is only a placeholder (derived from the requirement); once documents exist the name is final.
   */
  private nameDocsFolder(folder: string | null): void {
    if (!this.state.docsDir || this.store.hasDocs()) return;
    const root = this.config.docsDir.replace(/\/+$/, '');
    const rel = pickDocsDir(this.cwd, root, folder ?? topicSlug(this.state.requirement));
    if (rel === this.state.docsDir) return;
    this.state.docsDir = rel;
    this.store.setDocsDir(rel);
    this.saveState();
  }

  private stageNote(stage: StageId): string {
    return this.state.notes[noteKey(stage, this.state.fixesDone + 1)] ?? '';
  }

  /** Tech Lead documents, keyed by logical name. */
  private loadArtifacts(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of ['requirements.md', 'design.md']) {
      const v = this.store.read(n);
      if (v !== undefined) out[n] = v;
    }
    const review = this.store.read(versionedName('review.md', this.state.fixesDone + 1));
    if (review !== undefined) out['review.md'] = review;
    return out;
  }

  /** The review of round N is of the changes made so far; skip our own bookkeeping folders. */
  private reviewChanges() {
    return collectChanges(this.cwd, ['.cd-agents', ...(this.state.docsDir ? [this.state.docsDir] : [])]);
  }

  private promptCtx(extra: Partial<PromptCtx> = {}): PromptCtx {
    return {
      requirement: this.state.requirement,
      artifacts: this.loadArtifacts(),
      notes: this.state.notes,
      previousWork: this.previousWork(),
      autoApprove: this.autoApprove,
      testCommand: this.config.testCommand,
      maxFixIterations: this.config.workflow.maxFixIterations,
      wontFix: this.state.wontFix,
      round: this.state.fixesDone + 1,
      ...extra,
    };
  }

  // ───────────────────────────── workflow ─────────────────────────────

  private async workflow(from: StageId, atGate: boolean): Promise<void> {
    let stage: StageId | 'done' = from;
    let skip = atGate;
    try {
      while (stage !== 'done') {
        this.enterStage(stage);
        let artText = '';
        let feedback: string | undefined;
        for (;;) {
          const file = this.artifactFile(stage);
          let art: string;
          if (skip) {
            art = file ? (this.store.read(file) ?? '') : this.stageNote(stage);
            skip = false;
          } else {
            art = await this.executeStage(stage, file, feedback);
          }
          const warn = this.stageWarning(stage, art);
          const d = await this.openGate({
            title: `Stage ${STAGES[stage].n} ${STAGES[stage].title} complete`,
            stage,
            artifact: file ? this.store.path(file) : undefined,
            warning: warn,
            force: !!warn,
            // Senior Dev stages have no document to edit or view; their message is in the pane.
            options: file ? NORMAL_OPTIONS : NORMAL_OPTIONS.filter((o) => o.key !== 'e' && o.key !== 'v'),
            persist: true,
          });
          if (d.key === 'a') { artText = file ? (this.store.read(file) ?? art) : art; break; }
          if (d.key === 'r') { feedback = d.text; continue; }
          throw new AbortRun();
        }
        stage = await this.afterStage(stage, artText);
      }
      await this.finish();
    } catch (e) {
      if (e instanceof AbortRun) {
        this.state.aborted = true;
        this.stage = 'aborted';
        this.saveState();
        for (const r of ROLES) { this.setStatus(r, 'idle'); this.note(r, 'Run aborted. It is saved; use /resume to continue.'); }
      } else {
        const msg = (e as Error).message;
        for (const r of ROLES) this.push(r, 'error', `Internal error: ${msg}`);
        this.saveState();
      }
    } finally {
      this.stageRole = undefined;
    }
  }

  private enterStage(stage: StageId): void {
    this.stage = stage;
    this.state.stage = stage;
    this.state.phase = 'running';
    this.store.appendEvent({ type: 'stage', stage });
    this.saveState();
    const def = STAGES[stage];
    this.note(def.role, `── Stage ${def.n} ${def.title} ──`);
    this.emit('attention', { type: 'stage', role: def.role });
    this.emit('change');
  }

  private stageWarning(stage: StageId, art: string): string | undefined {
    if (stage === 'test') {
      const r = parseTestResult(art);
      if (r === 'FAIL') return `Tests are still failing after up to ${this.config.workflow.maxFixIterations} fix attempts.`;
      if (r === null) return 'The Senior Dev did not report a test result (no "RESULT:" line).';
    }
    return undefined;
  }

  private async executeStage(stage: StageId, file: string | null, feedback?: string): Promise<string> {
    const def = STAGES[stage];
    const role = def.role;
    const rt = this.rt[role];
    if (stage === 'review') { this.state.wontFix = []; }
    if (stage === 'implement' && feedback === undefined) {
      this.tasks = parseTasks(this.store.read('design.md') ?? '');
      this.activeTask = undefined;
    }

    const extra = stage === 'review' ? { changes: this.reviewChanges() } : {};
    let prompt = feedback !== undefined
      ? buildStagePrompt(stage, this.promptCtx({ ...extra, feedback, previous: file ? this.store.read(file) : this.stageNote(stage) }))
      : buildStagePrompt(stage, this.promptCtx(extra));
    let nudges = 0;
    let acc = ''; // Senior Dev stages: everything said across this stage's turns
    this.stageRole = role;

    for (;;) {
      const res = await this.turn(role, prompt, 'stage');
      if (this.aborted) throw new AbortRun();

      if (res.isError) {
        const d = await this.openGate({
          title: `${ROLE_LABEL[role]} failed`, stage, warning: res.error, force: true,
          options: [{ key: 'r', label: 'Retry' }, { key: 'q', label: 'Abort' }], persist: false,
        });
        if (d.key === 'q') throw new AbortRun();
        this.stageRole = role;
        continue;
      }

      const queued = rt.stageQueue.splice(0);
      if (queued.length) { prompt = wrapUserReply(stage, queued.join('\n\n')); continue; }

      if (!res.interrupted && !def.artifact && !isBlocked(res.text)) {
        // Senior Dev stage: the final message is the report. Kept in run state, no file is written.
        acc += res.text + '\n';
        if (stage === 'test' && parseTestResult(acc) === null && nudges < 2) {
          nudges++;
          prompt = wrapUserReply(stage, NUDGE_RESULT);
          continue;
        }
        const note = acc.trim().slice(-6000);
        this.state.notes[noteKey(stage, this.state.fixesDone + 1)] = note;
        this.store.appendEvent({ type: 'stage-done', stage });
        if (stage === 'implement') {
          this.tasks = this.tasks.map((t) => ({ ...t, done: true }));
          this.activeTask = undefined;
        }
        this.saveState();
        this.stageRole = undefined;
        return note;
      }

      if (!res.interrupted && def.artifact && file) {
        const art = extractArtifact(res.text, def.artifact);
        if (art) {
          if (stage === 'clarify') this.nameDocsFolder(extractFolder(res.text, def.artifact));
          this.store.write(file, art);
          this.store.appendEvent({ type: 'artifact', stage, file });
          this.note(role, `✔ ${file} saved`);
          if (stage === 'design') this.tasks = parseTasks(art);
          this.stageRole = undefined;
          return art;
        }
        if (this.autoApprove && !isBlocked(res.text) && nudges < 2) {
          nudges++;
          prompt = wrapUserReply(stage, NUDGE);
          continue;
        }
      }

      // No artifact (questions / blocked / interrupted): hand the floor to the user.
      const blocked = isBlocked(res.text);
      this.setStatus(role, blocked ? 'blocked' : 'waiting');
      this.emit('attention', { type: 'role', role });
      const reply = await new Promise<string>((resolve, reject) => { this.waiter = { role, resolve, reject }; });
      prompt = wrapUserReply(stage, reply);
    }
  }

  private async afterStage(stage: StageId, art: string): Promise<StageId | 'done'> {
    switch (stage) {
      case 'clarify': return 'design';
      case 'design': return 'implement';
      case 'implement': return 'test';
      case 'test': return 'review';
      case 'fix':
        this.state.fixesDone += 1;
        this.saveState();
        return 'review';
      case 'review': {
        const verdict = parseVerdict(art);
        if (verdict === 'APPROVED') return 'done';
        if (verdict === null) {
          const d = await this.openGate({
            title: 'Review has no verdict', stage, force: true,
            warning: 'review.md does not start with "VERDICT: APPROVED" or "VERDICT: CHANGES_REQUESTED".',
            options: [
              { key: 'a', label: 'Treat as approved' },
              { key: 'k', label: 'Go to Fix' },
              { key: 'q', label: 'Abort' },
            ], persist: false,
          });
          if (d.key === 'q') throw new AbortRun();
          return d.key === 'a' ? 'done' : 'fix';
        }
        if (this.state.fixesDone >= this.config.workflow.maxReviewIterations) {
          const d = await this.openGate({
            title: 'Review limit reached', stage, force: true,
            warning: `Still CHANGES_REQUESTED after ${this.state.fixesDone} review→fix round(s).`,
            options: [
              { key: 'a', label: 'Accept as-is' },
              { key: 'k', label: 'Keep going (one more fix)' },
              { key: 'q', label: 'Abort' },
            ], persist: false,
          });
          if (d.key === 'q') throw new AbortRun();
          return d.key === 'a' ? 'done' : 'fix';
        }
        return 'fix';
      }
    }
  }

  private async finish(): Promise<void> {
    this.stage = 'done';
    this.state.stage = 'done';
    this.state.phase = 'running';
    this.saveState();
    for (const r of ROLES) this.note(r, `✔ Run complete. Artifacts: ${this.store.dir}`);
    if (this.store.docs) this.note('techlead', `Tech Lead documents are in ${this.state.docsDir}/`);
    this.note('dev', 'Changes are left uncommitted in your working tree — review and commit them yourself.');

    // Start the next requirement with light contexts: compact both roles' conversations.
    if (this.config.workflow.autoCompact) {
      const keep: Record<Role, string> = {
        techlead: 'the requirement, the key design decisions and the review findings. Drop exploration detail; the documents are saved in the docs folder.',
        dev: 'what was implemented, how it was tested, and any open concerns. Drop command output and file contents.',
      };
      await Promise.all(ROLES.filter((r) => this.rt[r].started).map((r) => this.compact(r, `Keep ${keep[r]}`)));
    }
    for (const r of ROLES) this.setStatus(r, 'done');
    this.emit('change');
  }

  // ───────────────────────────── gates ─────────────────────────────

  private openGate(spec: Gate & { persist?: boolean }): Promise<GateDecision> {
    const { persist, ...gate } = spec;
    if (this.autoApprove && !gate.force) {
      this.note(gate.stage ? STAGES[gate.stage].role : 'techlead', `✔ auto-approved: ${gate.title}`);
      this.store.appendEvent({ type: 'gate', stage: gate.stage, decision: 'auto-approved' });
      return Promise.resolve({ key: 'a' });
    }
    if (persist) { this.state.phase = 'gate'; this.saveState(); }
    this.gate = gate;
    const owner = gate.stage ? STAGES[gate.stage].role : undefined;
    if (owner) this.setStatus(owner, 'waiting');
    this.emit('change');
    this.emit('attention', { type: 'gate' });
    return new Promise<GateDecision>((resolve, reject) => {
      this.gateWaiter = {
        resolve: (d) => {
          this.store.appendEvent({ type: 'gate', stage: gate.stage, decision: d.key, text: d.text });
          if (owner) this.setStatus(owner, 'idle');
          if (persist) { this.state.phase = 'running'; this.saveState(); }
          resolve(d);
        },
        reject,
      };
    });
  }

  private viewArtifact(): void {
    const g = this.gate;
    if (!g?.artifact || !g.stage) return;
    const text = existsSync(g.artifact) ? readFileSync(g.artifact, 'utf8') : '(file missing)';
    this.push(STAGES[g.stage].role, 'text', text);
  }

  // ───────────────────────────── turns ─────────────────────────────

  private sideChat(role: Role, text: string): Promise<RunResult> {
    return this.turn(role, wrapSideChat(text), 'side');
  }

  /** Serialised per role so two `claude` processes never share a session at once. */
  private turn(role: Role, prompt: string, mode: TurnMode): Promise<RunResult> {
    const rt = this.rt[role];
    rt.pending++;
    const p = rt.chain.then(() => this.doTurn(role, prompt, mode));
    rt.chain = p.catch(() => undefined);
    return p.finally(() => { rt.pending--; });
  }

  private async doTurn(role: Role, prompt: string, mode: TurnMode): Promise<RunResult> {
    const rt = this.rt[role];
    const fail = (error: string): RunResult => {
      this.push(role, 'error', error);
      this.setStatus(role, 'idle');
      return { text: '', costUsd: 0, isError: true, error, interrupted: false };
    };
    let system: string;
    try { system = loadPrompt(role, this.cwd, this.config); } catch (e) { return fail((e as Error).message); }

    const policy = toolPolicy(role, this.config, mode);
    rt.abort = new AbortController();
    this.setStatus(role, 'thinking');
    let turnText = '';

    const res = await runClaude({
      cwd: this.cwd,
      prompt,
      model: this.config.roles[role].model,
      effort: this.config.roles[role].effort,
      systemPrompt: system,
      allowedTools: policy.allowed,
      disallowedTools: policy.disallowed,
      permissionMode: policy.permissionMode,
      sessionId: rt.sessionId,
      resume: rt.started,
      signal: rt.abort.signal,
      onEvent: (ev) => {
        switch (ev.type) {
          case 'session':
            rt.started = true;
            break;
          case 'text':
            this.setStatus(role, 'thinking');
            this.appendText(role, ev.text);
            turnText += ev.text;
            if (role === 'dev' && mode === 'stage') this.trackTasks(turnText);
            break;
          case 'tool':
            this.setStatus(role, 'working');
            this.push(role, 'tool', `▸ ${ev.name}${ev.summary ? '  ' + ev.summary : ''}`, ev.detail);
            break;
          case 'tool_error':
            this.push(role, 'tool', `  ✗ ${ev.text}`);
            break;
          case 'compact': {
            const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
            const how = ev.trigger === 'manual' ? 'Context compacted' : 'Context auto-compacted by Claude';
            this.note(role, `✔ ${how}${ev.pre ? `: ${k(ev.pre)} → ${k(ev.post)} tokens` : ''}`);
            break;
          }
        }
      },
    });

    this.closeText(role);
    rt.abort = undefined;
    this.costUsd += res.costUsd;
    if (res.interrupted) this.note(role, 'interrupted');
    if (res.isError) this.push(role, 'error', res.error ?? 'Claude failed');
    if (this.run) { this.saveState(); }
    this.setStatus(role, 'idle');
    return res;
  }

  private trackTasks(text: string): void {
    let changed = false;
    for (const m of text.matchAll(/TASK_DONE:\s*(T\d+)/g)) {
      const t = this.tasks.find((x) => x.id === m[1]);
      if (t && !t.done) { t.done = true; changed = true; }
    }
    const starts = [...text.matchAll(/TASK_START:\s*(T\d+)/g)];
    const cur = starts.length ? starts[starts.length - 1]![1] : undefined;
    const active = this.tasks.find((t) => t.id === cur && !t.done)?.id;
    if (active !== this.activeTask) { this.activeTask = active; changed = true; }
    if (changed) this.emit('change');
  }
}
