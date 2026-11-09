import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRunState } from '../src/state.js';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { nextGate, setup, until } from './helpers.js';

const approveAll = async (e: Engine, stages: string[]) => {
  for (const s of stages) { await nextGate(e, s); e.decide('a'); await until(() => !e.gate); }
};

describe('workflow (manual approval)', () => {
  it('runs clarify → design → implement → test → review with gates, models and artifacts', async () => {
    const { engine: e, calls, cwd } = await setup();
    e.setModel('techlead', 'opus');
    e.setModel('dev', 'sonnet');
    e.submit('techlead', 'Add OTP login');

    // Nothing advances without approval.
    const g1 = await nextGate(e, 'clarify');
    expect(g1.options.map((o) => o.key)).toEqual(['a', 'r', 'e', 'v', 'q']);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls().map((c) => c.stage)).toEqual(['clarify']);

    await approveAll(e, ['clarify', 'design', 'implement', 'test', 'review']);
    await e.whenSettled();
    expect(e.stage).toBe('done');

    const c = calls();
    expect(c.map((x) => x.stage)).toEqual(['clarify', 'design', 'implement', 'test', 'review']);
    expect(c.map((x) => x.model)).toEqual(['opus', 'opus', 'sonnet', 'sonnet', 'opus']);
    // Same role keeps its session via --resume; first turn creates it.
    expect(c[0].resume).toBe(false);
    expect(c[1].resume).toBe(true);
    expect(c[2].resume).toBe(false);
    expect(c[3].resume).toBe(true);
    expect(c[4].sessionId).toBe(c[0].sessionId);
    // Role system prompts are passed.
    expect(c[0].system).toContain('Tech Lead');
    expect(c[2].system).toContain('Senior Dev');

    const run = e.run!;
    for (const f of ['requirements.md', 'design.md', 'review.md', 'state.json', 'techlead.jsonl', 'dev.jsonl', 'events.jsonl']) {
      expect(existsSync(run.store.path(f)), f).toBe(true);
    }
    // The Senior Dev writes no report files; its final messages are kept in run state.
    for (const f of ['implementation.md', 'test-report.md', 'fixes.md']) expect(existsSync(run.store.path(f)), f).toBe(false);
    expect(run.state.notes.implement).toContain('Implemented T1 and T2');
    expect(run.state.notes.test).toMatch(/^RESULT: PASS/);
    expect(readdirSync(run.store.dir).filter((f) => f.endsWith('.md'))).toEqual([]);
    expect(existsSync(join(cwd, 'impl.txt'))).toBe(true);
    expect(e.tasks.map((t) => t.done)).toEqual([true, true]);
    expect(e.costUsd).toBeCloseTo(0.05);
  });

  it('enforces tool policy: tech lead read-only, nobody writes git', async () => {
    const { engine: e, calls } = await setup();
    e.submit('techlead', 'x');
    await approveAll(e, ['clarify', 'design', 'implement']);
    const [tl, , dev] = calls();
    expect(tl.disallowed).toContain('Edit');
    expect(tl.disallowed).toContain('Write');
    expect(tl.allowed).not.toMatch(/(^|,)(Edit|Write|Bash)(,|$)/);
    expect(tl.permissionMode).toBe('dontAsk');
    expect(dev.allowed).toContain('Edit');
    expect(dev.disallowed).toContain('Bash(git commit:*)');
    expect(dev.disallowed).toContain('Bash(git push:*)');
    e.abort(); await e.whenSettled();
  });

  it('reject re-runs the same stage with the feedback and previous artifact', async () => {
    const { engine: e, calls } = await setup();
    e.submit('techlead', 'x');
    await nextGate(e, 'clarify'); e.decide('a'); await until(() => !e.gate);
    await nextGate(e, 'design');
    e.decide('r', '   '); // empty feedback is ignored
    expect(e.gate).toBeDefined();
    e.decide('r', 'use postgres');
    await until(() => calls().filter((c) => c.stage === 'design').length === 2);
    const second = calls().filter((c) => c.stage === 'design')[1];
    expect(second.prompt).toContain('use postgres');
    expect(second.prompt).toContain('### T1');
    expect(second.resume).toBe(true);
    await nextGate(e, 'design');
    e.abort(); await e.whenSettled();
  });

  it('clarify is conversational: questions first, gate only after requirements.md', async () => {
    const { engine: e, calls } = await setup({ FAKE_ASK: '1' });
    e.submit('techlead', 'x');
    await until(() => e.status.techlead === 'waiting');
    expect(e.gate).toBeUndefined();
    e.submit('techlead', 'authenticator app');
    await nextGate(e, 'clarify');
    expect(calls().filter((c) => c.stage === 'clarify')).toHaveLength(2);
    expect(calls()[1].prompt).toContain('authenticator app');
    e.abort(); await e.whenSettled();
  });

  it('review CHANGES_REQUESTED → fix (dev) → review again, versioned artifacts', async () => {
    const { engine: e, calls } = await setup({ FAKE_VERDICTS: 'CHANGES_REQUESTED,APPROVED' });
    e.submit('techlead', 'x');
    await approveAll(e, ['clarify', 'design', 'implement', 'test', 'review', 'fix', 'review']);
    await e.whenSettled();
    expect(calls().map((c) => c.stage).slice(4)).toEqual(['review', 'fix', 'review']);
    expect(calls()[5].model).toBe('sonnet');
    for (const f of ['review.md', 'review-2.md']) expect(existsSync(e.run!.store.path(f)), f).toBe(true);
    expect(existsSync(e.run!.store.path('fixes.md'))).toBe(false);
    expect(e.run!.state.notes['fix-1']).toContain('Fixed finding 1');
    expect(e.stage).toBe('done');
    // fix prompt carries the review, review #2 carries the fixes
    expect(calls()[5].prompt).toContain('fix it');
    expect(calls()[6].prompt).toContain('Fixed finding 1');
  });

  it('review limit escalates to the user even when gates would auto-approve', async () => {
    const { engine: e } = await setup({ FAKE_VERDICTS: 'CHANGES_REQUESTED' }, true);
    e.config.workflow.maxReviewIterations = 1;
    e.submit('techlead', 'x');
    const g = await nextGate(e, 'review');
    expect(g.title).toMatch(/limit/i);
    expect(g.options.map((o) => o.key)).toEqual(['a', 'k', 'q']);
    e.decide('a');
    await e.whenSettled();
    expect(e.stage).toBe('done');
  });

  it('wontFix list is passed to the fix stage', async () => {
    const { engine: e, calls } = await setup({ FAKE_VERDICTS: 'CHANGES_REQUESTED,APPROVED' });
    e.submit('techlead', 'x');
    await approveAll(e, ['clarify', 'design', 'implement', 'test']);
    await nextGate(e, 'review');
    e.setWontFix([2, 3]);
    e.decide('a');
    await until(() => calls().some((c) => c.stage === 'fix'));
    expect(calls().find((c) => c.stage === 'fix')!.prompt).toContain("WON'T FIX");
    e.abort(); await e.whenSettled();
  });
});

describe('--auto-approve', () => {
  it('completes without any prompt and tells the tech lead not to ask', async () => {
    const { engine: e, calls } = await setup({}, true);
    e.submit('techlead', 'x');
    await e.whenSettled();
    expect(e.stage).toBe('done');
    expect(e.gate).toBeUndefined();
    expect(calls()[0].prompt).toContain('auto-approve: ON');
    expect(calls()[0].prompt).toContain('do NOT ask questions');
    expect(e.panes.techlead.some((x) => x.text.includes('auto-approved'))).toBe(true);
  });

  it('still stops when tests keep failing', async () => {
    const { engine: e } = await setup({ FAKE_TEST_RESULT: 'FAIL' }, true);
    e.submit('techlead', 'x');
    const g = await nextGate(e, 'test');
    expect(g.warning).toMatch(/failing/);
    e.decide('q');
    await e.whenSettled();
    expect(e.stage).toBe('aborted');
  });

  it('turning auto on while a gate is open approves it', async () => {
    const { engine: e } = await setup();
    e.submit('techlead', 'x');
    await nextGate(e, 'clarify');
    e.setAutoApprove(true);
    await e.whenSettled();
    expect(e.stage).toBe('done');
  });
});

describe('side chat and queued messages', () => {
  it('non-owner role answers read-only without affecting the workflow', async () => {
    const { engine: e, calls, cwd } = await setup();
    e.submit('techlead', 'x');
    await nextGate(e, 'clarify');
    e.submit('dev', 'how hard is T3?');
    await until(() => e.panes.dev.some((x) => x.text.includes('side answer from sonnet')));
    const side = calls().find((c) => c.stage === 'side')!;
    expect(side.allowed).not.toMatch(/Edit|Write/);
    expect(side.allowed).not.toMatch(/(^|,)Bash(,|$)/);
    expect(side.disallowed).toContain('Edit');
    expect(side.permissionMode).toBe('dontAsk');
    expect(e.gate?.stage).toBe('clarify');
    expect(e.stage).toBe('clarify');
    expect(existsSync(join(cwd, 'impl.txt'))).toBe(false);
    e.abort(); await e.whenSettled();
  });

  it('message to the owner while it works is queued and delivered after the turn', async () => {
    const { engine: e, calls } = await setup();
    e.submit('techlead', 'x');
    await until(() => e.status.techlead !== 'idle');
    e.submit('techlead', 'also support backup codes');
    await until(() => calls().filter((c) => c.stage === 'clarify').length === 2);
    expect(calls()[1].prompt).toContain('also support backup codes');
    e.abort(); await e.whenSettled();
  });

  it('side chat before any run does not start a workflow', async () => {
    const { engine: e } = await setup();
    e.submit('dev', 'hello');
    await until(() => e.panes.dev.some((x) => x.text.includes('side answer')));
    expect(e.run).toBeUndefined();
    expect(e.running).toBe(false);
  });
});

describe('errors, interrupt, abort, resume', () => {
  it('claude failure opens a retry gate', async () => {
    const { engine: e, calls } = await setup({ FAKE_FAIL_STAGE: 'design' });
    e.submit('techlead', 'x');
    await approveAll(e, ['clarify']);
    const g = await nextGate(e);
    expect(g.title).toMatch(/failed/);
    expect(g.warning).toContain('boom');
    e.decide('r');
    await nextGate(e, 'design');
    expect(calls().filter((c) => c.stage === 'design')).toHaveLength(2);
    e.abort(); await e.whenSettled();
  });

  it('abort saves the run; resume continues from the last gate and reuses sessions', async () => {
    const { engine: e, cwd, calls } = await setup();
    e.submit('techlead', 'Add OTP login');
    await approveAll(e, ['clarify']);
    await nextGate(e, 'design');
    const id = e.run!.state.id;
    const tlSession = calls()[0].sessionId;
    e.abort();
    await e.whenSettled();
    expect(e.stage).toBe('aborted');
    expect(loadRunState(cwd, id)!.stage).toBe('design');
    expect(loadRunState(cwd, id)!.phase).toBe('gate');

    const e2 = new Engine({ cwd, config: loadConfig(cwd).config, autoApprove: false });
    expect(e2.resume()).toBe(true);
    expect(e2.panes.techlead.some((x) => x.kind === 'user' && x.text === 'Add OTP login')).toBe(true);
    const g = await nextGate(e2, 'design');
    expect(g.artifact).toMatch(/design\.md$/);
    // reopened the gate without re-running the design stage
    expect(calls().filter((c) => c.stage === 'design')).toHaveLength(1);
    e2.decide('a');
    await nextGate(e2, 'implement');
    // implement is the dev's first turn; tech lead session is unchanged
    e2.decide('q'); await e2.whenSettled();
    const last = calls().at(-1)!;
    expect(last.stage).toBe('implement');
    expect(calls().filter((c) => c.sessionId === tlSession).length).toBe(2);
  });

  it('edits made to an artifact are what the next stage receives', async () => {
    const { engine: e, calls } = await setup();
    e.submit('techlead', 'x');
    await nextGate(e, 'clarify');
    writeFileSync(e.run!.store.path('requirements.md'), '# EDITED BY USER\n');
    e.decide('a');
    await until(() => calls().some((c) => c.stage === 'design'));
    expect(calls().find((c) => c.stage === 'design')!.prompt).toContain('EDITED BY USER');
    e.abort(); await e.whenSettled();
  });

  it('newRun is refused while a workflow is active', async () => {
    const { engine: e } = await setup();
    e.submit('techlead', 'x');
    await nextGate(e, 'clarify');
    expect(e.newRun()).toBe(false);
    e.abort(); await e.whenSettled();
    expect(e.newRun()).toBe(true);
    expect(e.panes.techlead.map((x) => x.kind)).toEqual(['marker']); // just the "continuing" note
    expect(e.panes.dev).toHaveLength(0);
  });
});

it('persisted pane transcripts are valid jsonl', async () => {
  const { engine: e } = await setup({}, true);
  e.submit('techlead', 'x');
  await e.whenSettled();
  const lines = readFileSync(e.run!.store.path('techlead.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.length).toBeGreaterThan(3);
  expect(lines[0]).toMatchObject({ kind: 'user', text: 'x' });
});

describe('Tech Lead documents live in the project docs folder', () => {
  it('requirements, design and review go to docs/<slug>/; dev reports stay in the run folder', async () => {
    const { engine: e, cwd } = await setup({ FAKE_VERDICTS: 'CHANGES_REQUESTED,APPROVED' }, true);
    e.config.workflow.maxReviewIterations = 3;
    e.submit('techlead', 'Add OTP login');
    await e.whenSettled();
    const docs = join(cwd, 'docs', 'add-otp-login');
    for (const f of ['requirements.md', 'design.md', 'review.md', 'review-2.md']) {
      expect(existsSync(join(docs, f)), `docs/${f}`).toBe(true);
      expect(existsSync(e.run!.store.path(f)) && e.run!.store.path(f).includes('.cd-agents'), `${f} not in run dir`).toBe(false);
    }
    const runDir = e.run!.store.dir;
    for (const f of ['implementation.md', 'test-report.md', 'fixes.md']) {
      expect(existsSync(join(runDir, f)), `${f} not in run dir`).toBe(false);
      expect(existsSync(join(docs, f)), `${f} must not be in docs`).toBe(false);
    }
    expect(e.run!.state.docsDir).toBe('docs/add-otp-login');
    expect(e.artifactList().some((p) => p.endsWith('docs/add-otp-login/design.md'))).toBe(true);
  });

  it('the gate points at the docs file, and edits there reach the next stage', async () => {
    const { engine: e, cwd, calls } = await setup();
    e.submit('techlead', 'Add OTP login');
    const g = await nextGate(e, 'clarify');
    expect(g.artifact).toBe(join(cwd, 'docs', 'add-otp-login', 'requirements.md'));
    writeFileSync(g.artifact!, '# EDITED IN DOCS\n');
    e.decide('a');
    await until(() => calls().some((c) => c.stage === 'design'));
    expect(calls().find((c) => c.stage === 'design')!.prompt).toContain('EDITED IN DOCS');
    e.abort(); await e.whenSettled();
  });

  it('a second run with the same requirement does not overwrite the first', async () => {
    const { engine: e, cwd } = await setup({}, true);
    e.submit('techlead', 'Add OTP login');
    await e.whenSettled();
    writeFileSync(join(cwd, 'docs', 'add-otp-login', 'design.md'), 'FIRST RUN DESIGN');
    expect(e.newRun()).toBe(true);
    await new Promise((r) => setTimeout(r, 1100)); // distinct run-id timestamp
    e.submit('techlead', 'Add OTP login');
    await e.whenSettled();
    expect(readFileSync(join(cwd, 'docs', 'add-otp-login', 'design.md'), 'utf8')).toBe('FIRST RUN DESIGN');
    expect(existsSync(join(cwd, 'docs', 'add-otp-login-2', 'design.md'))).toBe(true);
  });

  it('honours the docsDir config and resumes with the stored folder', async () => {
    const { engine: e, cwd } = await setup();
    e.config.docsDir = 'documentation/specs';
    e.submit('techlead', 'Add OTP login');
    await nextGate(e, 'clarify');
    expect(existsSync(join(cwd, 'documentation', 'specs', 'add-otp-login', 'requirements.md'))).toBe(true);
    e.abort(); await e.whenSettled();
    const e2 = new Engine({ cwd, config: loadConfig(cwd).config, autoApprove: false }); // default docsDir now
    e2.resume();
    const g = await nextGate(e2, 'clarify');
    expect(g.artifact).toBe(join(cwd, 'documentation', 'specs', 'add-otp-login', 'requirements.md'));
    e2.abort(); await e2.whenSettled();
  });
});

it('announces the owner of every stage so the UI can follow the work', async () => {
  const { engine: e } = await setup({ FAKE_VERDICTS: 'APPROVED' }, true);
  const seen: string[] = [];
  e.on('attention', (a: { type: string; role?: string }) => { if (a.type === 'stage') seen.push(a.role!); });
  e.submit('techlead', 'x');
  await e.whenSettled();
  expect(seen).toEqual(['techlead', 'techlead', 'dev', 'dev', 'techlead']);
});

describe('Senior Dev stages have no report files', () => {
  it('dev gates offer approve / reject / abort only, with no document path', async () => {
    const { engine: e } = await setup();
    e.submit('techlead', 'x');
    await approveAll(e, ['clarify', 'design']);
    const g = await nextGate(e, 'implement');
    expect(g.artifact).toBeUndefined();
    expect(g.options.map((o) => o.key)).toEqual(['a', 'r', 'q']);
    e.decide('e'); e.decide('v'); // not offered → ignored
    expect(e.gate).toBe(g);
    e.abort(); await e.whenSettled();
  });

  it('rejecting a dev stage re-runs it with feedback (no artifact asked for)', async () => {
    const { engine: e, calls } = await setup();
    e.submit('techlead', 'x');
    await approveAll(e, ['clarify', 'design']);
    await nextGate(e, 'implement');
    e.decide('r', 'also handle expired codes');
    await until(() => calls().filter((c) => c.stage === 'implement').length === 2);
    const p = calls().filter((c) => c.stage === 'implement')[1].prompt;
    expect(p).toContain('also handle expired codes');
    expect(p).not.toContain('<artifact');
    await nextGate(e, 'implement');
    e.abort(); await e.whenSettled();
  });

  it('a missing RESULT line is requested again, then flagged if it never comes', async () => {
    const late = await setup({ FAKE_TEST_RESULT: 'LATE' });
    late.engine.submit('techlead', 'x');
    await approveAll(late.engine, ['clarify', 'design', 'implement']);
    const g = await nextGate(late.engine, 'test');
    expect(g.warning).toBeUndefined();
    expect(late.calls().filter((c) => c.stage === 'test')).toHaveLength(2);
    expect(late.engine.run!.state.notes.test).toMatch(/RESULT: PASS/);
    late.engine.abort(); await late.engine.whenSettled();

    const none = await setup({ FAKE_TEST_RESULT: 'NONE' }, true);
    none.engine.submit('techlead', 'x');
    const g2 = await nextGate(none.engine, 'test');
    expect(g2.warning).toMatch(/did not report a test result/);
    expect(none.calls().filter((c) => c.stage === 'test')).toHaveLength(3); // initial + 2 nudges
    none.engine.abort(); await none.engine.whenSettled();
  });

  it('resuming at a dev gate restores the saved message', async () => {
    const { engine: e, cwd } = await setup();
    e.submit('techlead', 'x');
    await approveAll(e, ['clarify', 'design']);
    await nextGate(e, 'implement');
    e.abort(); await e.whenSettled();
    const e2 = new Engine({ cwd, config: loadConfig(cwd).config, autoApprove: false });
    e2.resume();
    await nextGate(e2, 'implement');
    expect(e2.run!.state.notes.implement).toContain('Implemented T1');
    e2.abort(); await e2.whenSettled();
  });
});

describe('review receives only the changes', () => {
  it('in a git repo: the diff and new files, without our own docs/.cd-agents folders', async () => {
    const { engine: e, cwd, calls } = await setup({}, true);
    execFileSync('git', ['init', '-q'], { cwd });
    e.submit('techlead', 'Add OTP login');
    await e.whenSettled();
    const review = calls().find((c) => c.stage === 'review')!;
    expect(review.prompt).toContain('<changes source="git');
    expect(review.prompt).toContain('=== new file: impl.txt ===');
    expect(review.prompt).toContain('implemented');
    expect(review.prompt).not.toContain('docs/add-otp-login');
    expect(review.prompt).not.toContain('.cd-agents/runs');
    expect(review.prompt).toContain('Review ONLY these changes');
    expect(review.prompt).toContain('Implemented T1 and T2'); // Senior Dev's notes travel along
    // review never receives files that no longer exist
    expect(review.prompt).not.toContain('implementation.md');
  });

  it('outside git: says so and points at the dev notes', async () => {
    const { engine: e, calls } = await setup({}, true);
    e.submit('techlead', 'x');
    await e.whenSettled();
    const review = calls().find((c) => c.stage === 'review')!;
    expect(review.prompt).toContain('not a git repository');
    expect(review.prompt).toContain('Implemented T1 and T2');
  });
});

describe('compact', () => {
  it('compacts a role session with /compact on the same session and reports the savings', async () => {
    const { engine: e, calls } = await setup();
    e.submit('techlead', 'x');
    await nextGate(e, 'clarify');
    e.compact('techlead', 'keep the decisions');
    await until(() => calls().some((c) => c.stage === 'compact'));
    const c = calls().find((x) => x.stage === 'compact')!;
    expect(c.prompt).toBe('/compact keep the decisions');
    expect(c.resume).toBe(true);
    expect(c.sessionId).toBe(calls()[0].sessionId);
    expect(c.allowed).not.toMatch(/Edit|Write/);
    await until(() => e.panes.techlead.some((x) => x.text.includes('Context compacted: 20.9k → 5.6k tokens')));
    expect(e.gate?.stage).toBe('clarify'); // workflow untouched
    e.abort(); await e.whenSettled();
  });

  it('nothing to compact before a role has a conversation; "all" only touches started roles', async () => {
    const { engine: e, calls } = await setup();
    e.compact('dev');
    expect(e.panes.dev.at(-1)!.text).toMatch(/Nothing to compact/);
    e.submit('dev', 'hi');
    await until(() => e.panes.dev.some((x) => x.text.includes('side answer')));
    e.compact('all');
    await until(() => calls().some((x) => x.stage === 'compact'));
    expect(calls().filter((x) => x.stage === 'compact')).toHaveLength(1);
    expect(e.panes.techlead.at(-1)!.text).toMatch(/Nothing to compact/);
  });

  it('queues behind a running turn instead of overlapping it', async () => {
    const { engine: e, calls } = await setup({ FAKE_DELAY: '300' });
    e.submit('dev', 'first');
    await until(() => e.panes.dev.some((x) => x.text.includes('side answer')));
    e.submit('dev', 'second'); // busy for ~300ms
    e.compact('dev');
    expect(e.panes.dev.some((x) => x.text.includes('queued behind'))).toBe(true);
    await until(() => calls().some((x) => x.stage === 'compact'));
    expect(calls().map((x) => x.stage)).toEqual(['side', 'side', 'compact']);
  });
});

describe('resume as claude (interactive)', () => {
  it('refuses before the role has a conversation or while it is busy', async () => {
    const { engine: e } = await setup({ FAKE_DELAY: '300' });
    expect(e.openInteractive('techlead')).toMatchObject({ error: expect.stringMatching(/no conversation yet/) });
    e.submit('dev', 'hi');
    await until(() => e.panes.dev.some((x) => x.text.includes('side answer')));
    e.submit('dev', 'again');
    expect(e.openInteractive('dev')).toMatchObject({ error: expect.stringMatching(/busy/) });
  });

  it('resumes the role\'s own session with its model and limits, and holds the queue until released', async () => {
    const { engine: e, calls } = await setup();
    e.submit('techlead', 'x');
    await nextGate(e, 'clarify');
    const h = e.openInteractive('techlead');
    expect('error' in h).toBe(false);
    if ('error' in h) return;
    const a = h.spec.args;
    expect(a[a.indexOf('--resume') + 1]).toBe(calls()[0].sessionId);
    expect(a[a.indexOf('--model') + 1]).toBe('opus');
    expect(a[a.indexOf('--append-system-prompt') + 1]).toContain('Tech Lead');
    expect(a[a.indexOf('--disallowedTools') + 1]).toMatch(/Edit.*Write|Write.*Edit/);
    expect(a).not.toContain('-p');

    // While claude is open, a message to that role must not start a second process on the session.
    const before = calls().length;
    e.submit('techlead', 'question while away');
    await new Promise((r) => setTimeout(r, 200));
    expect(calls().length).toBe(before);
    h.release();
    await until(() => calls().length === before + 1);
    expect(e.panes.techlead.some((x) => x.text.includes('Back from Claude Code'))).toBe(true);
    h.release(); // idempotent
    e.abort(); await e.whenSettled();
  });

  it('the dev keeps its no-git-write limit in the interactive session', async () => {
    const { engine: e } = await setup();
    e.submit('dev', 'hi');
    await until(() => e.panes.dev.some((x) => x.text.includes('side answer')) && e.status.dev === 'idle');
    const h = e.openInteractive('dev');
    if ('error' in h) throw new Error(h.error);
    const a = h.spec.args;
    expect(a[a.indexOf('--disallowedTools') + 1]).toContain('Bash(git commit:*)');
    h.release();
  });
});

describe('auto-compact when a requirement finishes', () => {
  it('compacts both roles after the last stage, before the run counts as settled', async () => {
    const { engine: e, calls } = await setup({}, true, true);
    e.submit('techlead', 'Add OTP login');
    await e.whenSettled();
    expect(e.stage).toBe('done');
    const stages = calls().map((c) => c.stage);
    expect(stages.slice(0, 5)).toEqual(['clarify', 'design', 'implement', 'test', 'review']);
    expect(stages.slice(5).sort()).toEqual(['compact', 'compact']);
    const compacts = calls().filter((c) => c.stage === 'compact');
    expect(new Set(compacts.map((c) => c.sessionId)).size).toBe(2); // one per role session
    for (const c of compacts) { expect(c.resume).toBe(true); expect(c.prompt).toMatch(/^\/compact Keep /); }
    expect(compacts.find((c) => c.model === 'opus')!.prompt).toMatch(/design decisions/);
    expect(compacts.find((c) => c.model === 'sonnet')!.prompt).toMatch(/implemented/);
    for (const r of ['techlead', 'dev'] as const) {
      expect(e.panes[r].some((x) => x.text.includes('Context compacted'))).toBe(true);
      expect(e.status[r]).toBe('done');
    }
  });

  it('can be switched off', async () => {
    const { engine: e, calls } = await setup({}, true, false);
    e.submit('techlead', 'x');
    await e.whenSettled();
    expect(calls().some((c) => c.stage === 'compact')).toBe(false);
  });

  it('only compacts roles that actually had a conversation', async () => {
    const { engine: e, calls } = await setup({}, true, true);
    e.submit('techlead', 'x');
    await e.whenSettled();
    expect(calls().filter((c) => c.stage === 'compact')).toHaveLength(2);
    // a role whose session never started is skipped silently
    expect(e.panes.techlead.some((x) => /Nothing to compact/.test(x.text))).toBe(false);
  });

  it('a failing compaction does not fail the finished run', async () => {
    const { engine: e } = await setup({ FAKE_FAIL_STAGE: 'compact' }, true, true);
    e.submit('techlead', 'x');
    await e.whenSettled();
    expect(e.stage).toBe('done');
    // the fake fails compactions (once, racily across the two parallel roles); the run must still finish
    expect([...e.panes.techlead, ...e.panes.dev].some((x) => x.kind === 'error')).toBe(true);
    expect(e.run!.state.stage).toBe('done');
  });

  it('a resumed, already finished run is not compacted again', async () => {
    const { engine: e, cwd, calls } = await setup({}, true, true);
    e.submit('techlead', 'x');
    await e.whenSettled();
    const n = calls().length;
    const e2 = new Engine({ cwd, config: loadConfig(cwd).config, autoApprove: false });
    expect(e2.resume()).toBe(true);
    expect(e2.stage).toBe('done');
    await new Promise((r) => setTimeout(r, 150));
    expect(calls().length).toBe(n);
  });
});

describe('saved sessions for the startup menu', () => {
  it('lists runs newest first with their state', async () => {
    const { engine: e, cwd } = await setup({}, true);
    expect(e.runSummaries()).toEqual([]);
    e.submit('techlead', 'First feature');
    await e.whenSettled();
    e.newRun();
    await new Promise((r) => setTimeout(r, 1100));
    e.autoApprove = false;
    e.submit('techlead', 'Second feature');
    await nextGate(e, 'clarify');
    e.abort(); await e.whenSettled();

    const e2 = new Engine({ cwd, config: loadConfig(cwd).config, autoApprove: false });
    const list = e2.runSummaries();
    expect(list.map((r) => r.requirement)).toEqual(['Second feature', 'First feature']);
    expect(list[0]).toMatchObject({ stage: 'clarify', aborted: true });
    expect(list[1]).toMatchObject({ stage: 'done', aborted: false });
    // choosing one resumes that exact run
    expect(e2.resume(list[1]!.id)).toBe(true);
    expect(e2.run!.state.requirement).toBe('First feature');
    expect(e2.stage).toBe('done');
  });
});

describe('context across requirements (/new)', () => {
  const finishOne = async (e: Engine, text: string) => { e.submit('techlead', text); await e.whenSettled(); };

  it('/new keeps both roles\' conversations: same sessions, resumed', async () => {
    const { engine: e, calls } = await setup({}, true);
    await finishOne(e, 'Add OTP login');
    const tl = calls().find((c) => c.stage === 'clarify')!.sessionId;
    const dev = calls().find((c) => c.stage === 'implement')!.sessionId;
    expect(e.newRun()).toBe(true);
    expect(e.panes.techlead[0]!.text).toMatch(/continuing both roles' conversations/);
    await finishOne(e, 'Add backup codes');
    const clarify2 = calls().filter((c) => c.stage === 'clarify')[1]!;
    const implement2 = calls().filter((c) => c.stage === 'implement')[1]!;
    expect(clarify2.sessionId).toBe(tl);
    expect(clarify2.resume).toBe(true);
    expect(implement2.sessionId).toBe(dev);
    expect(implement2.resume).toBe(true);
    // the second run records the carried sessions, so resuming it later keeps them too
    expect(e.run!.state.sessions.techlead).toEqual({ id: tl, started: true });
    expect(e.run!.state.sessions.dev).toEqual({ id: dev, started: true });
  });

  it('/new fresh starts clean conversations', async () => {
    const { engine: e, calls } = await setup({}, true);
    await finishOne(e, 'Add OTP login');
    const tl = calls().find((c) => c.stage === 'clarify')!.sessionId;
    expect(e.newRun({ fresh: true })).toBe(true);
    expect(e.panes.techlead[0]!.text).toMatch(/fresh conversations/);
    await finishOne(e, 'Add backup codes');
    const clarify2 = calls().filter((c) => c.stage === 'clarify')[1]!;
    expect(clarify2.sessionId).not.toBe(tl);
    expect(clarify2.resume).toBe(false);
  });

  it('with auto-compact on, the finished requirement is compacted before the next one continues', async () => {
    const { engine: e, calls } = await setup({}, true, true);
    await finishOne(e, 'Add OTP login');
    e.newRun();
    await finishOne(e, 'Add backup codes');
    const order = calls().map((c) => c.stage);
    const firstCompact = order.indexOf('compact');
    expect(firstCompact).toBeGreaterThan(-1);
    expect(order.indexOf('clarify', 1)).toBeGreaterThan(firstCompact); // 2nd clarify comes after the compaction
  });

  it('the Tech Lead is told about earlier requirements and their docs (also after a fresh start)', async () => {
    const { engine: e, calls } = await setup({}, true);
    await finishOne(e, 'Add OTP login');
    e.newRun({ fresh: true });
    await finishOne(e, 'Add backup codes for OTP');
    const [first, second] = calls().filter((c) => c.stage === 'clarify');
    expect(first!.prompt).not.toContain('Earlier requirements');
    expect(second!.prompt).toContain('Earlier requirements in this project');
    expect(second!.prompt).toContain('"Add OTP login" (done)');
    expect(second!.prompt).toContain('docs: docs/add-otp-login/');
    expect(second!.prompt).not.toContain('docs/add-backup-codes-for-otp'); // never lists itself
  });

  it('skips earlier runs that produced no documents, newest first, at most 5', async () => {
    const { engine: e, calls } = await setup({ FAKE_ASK: '1' });
    // a run that only got as far as a clarifying question: no documents exist for it
    e.submit('techlead', 'Never documented');
    await until(() => e.status.techlead === 'waiting');
    e.abort(); await e.whenSettled();
    process.env.FAKE_ASK = '';
    e.autoApprove = true;
    e.newRun();
    for (const t of ['Feature one', 'Feature two', 'Feature three', 'Feature four', 'Feature five', 'Feature six']) {
      await finishOne(e, t);
      e.newRun();
    }
    await finishOne(e, 'Feature seven');
    const last = calls().filter((c) => c.stage === 'clarify').at(-1)!.prompt;
    const lines = last.split('\n').filter((l) => l.startsWith('- 20'));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('Feature six');
    expect(lines[4]).toContain('Feature two');
    expect(last).not.toContain('Feature one');
    expect(last).not.toContain('Never documented');
  }, 30000);
});
