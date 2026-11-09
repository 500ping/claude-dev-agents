import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArgs, runClaude, summarizeTool, type AgentEvent } from '../src/claude.js';
import { extractArtifact, parseTasks, parseTestResult, parseVerdict, versionedName } from '../src/stages.js';
import { FAKE } from './helpers.js';

describe('buildArgs', () => {
  const base = { model: 'opus', systemPrompt: 'SYS', allowedTools: ['Read', 'Bash(git diff:*)'], disallowedTools: ['Edit'], permissionMode: 'dontAsk', sessionId: 'abc' };
  it('first turn uses --session-id, later turns --resume', () => {
    const first = buildArgs({ ...base, resume: false });
    expect(first).toContain('--session-id');
    expect(first).not.toContain('--resume');
    expect(buildArgs({ ...base, resume: true })).toContain('--resume');
  });
  it('passes model, prompt, tools and mode as single args', () => {
    const a = buildArgs({ ...base, resume: false });
    expect(a[a.indexOf('--model') + 1]).toBe('opus');
    expect(a[a.indexOf('--append-system-prompt') + 1]).toBe('SYS');
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('Read,Bash(git diff:*)');
    expect(a[a.indexOf('--disallowedTools') + 1]).toBe('Edit');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(a).toContain('--output-format');
  });
});

describe('runClaude (fake binary)', () => {
  const run = async (stage: string, extra: Record<string, string> = {}) => {
    Object.assign(process.env, { CD_AGENTS_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: '', FAKE_FAIL_STAGE: '', ...extra });
    const events: AgentEvent[] = [];
    const res = await runClaude({
      cwd: mkdtempSync(join(tmpdir(), 'cda-run-')), prompt: `<stage>${stage}</stage>`, model: 'haiku', systemPrompt: 's',
      allowedTools: [], disallowedTools: [], permissionMode: 'dontAsk', sessionId: 'sid', resume: false,
      onEvent: (e) => events.push(e),
    });
    return { res, events };
  };
  it('streams text deltas once (no duplicate from the final assistant message) and tool calls', async () => {
    const { res, events } = await run('implement');
    expect(events[0]).toEqual({ type: 'session', id: 'sid' });
    expect(events.find((e) => e.type === 'tool')).toMatchObject({ name: 'Write', summary: 'impl.txt' });
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
    expect(res.text.match(/TASK_DONE: T1/g)).toHaveLength(1);
    expect(res.text).toContain('Implemented T1 and T2');
    expect(extractArtifact(res.text, 'implementation.md')).toBeNull(); // dev stages produce no artifact
    expect(res.costUsd).toBeCloseTo(0.01);
    expect(res.isError).toBe(false);
  });
  it('reports a non-zero exit as an error with stderr', async () => {
    const { res } = await run('design', { FAKE_FAIL_STAGE: 'design' });
    expect(res.isError).toBe(true);
    expect(res.error).toContain('boom');
  });
  it('turns a compact_boundary system event into a compact event', async () => {
    Object.assign(process.env, { CD_AGENTS_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: '', FAKE_FAIL_STAGE: '' });
    const ev: AgentEvent[] = [];
    await runClaude({
      cwd: mkdtempSync(join(tmpdir(), 'cda-run-')), prompt: '/compact keep x', model: 'haiku', systemPrompt: 's',
      allowedTools: [], disallowedTools: [], permissionMode: 'dontAsk', sessionId: 'sid', resume: true, onEvent: (e) => ev.push(e),
    });
    expect(ev.find((e) => e.type === 'compact')).toEqual({ type: 'compact', trigger: 'manual', pre: 20948, post: 5606 });
  });
  it('reports a missing binary', async () => {
    process.env.CD_AGENTS_CLAUDE_BIN = '/nonexistent/claude';
    const res = await runClaude({
      cwd: process.cwd(), prompt: 'x', model: 'm', systemPrompt: 's', allowedTools: [], disallowedTools: [],
      permissionMode: 'dontAsk', sessionId: 'x', resume: false, onEvent: () => {},
    });
    expect(res.isError).toBe(true);
    expect(res.error).toMatch(/Failed to start claude/);
  });
});

describe('stage parsers', () => {
  it('extractArtifact picks the last matching artifact and ignores other names', () => {
    const t = '<artifact name="a.md">one</artifact> x <artifact name="b.md">B</artifact><artifact name="a.md">\ntwo\n</artifact>';
    expect(extractArtifact(t, 'a.md')).toBe('two');
    expect(extractArtifact(t, 'b.md')).toBe('B');
    expect(extractArtifact(t, 'c.md')).toBeNull();
    expect(extractArtifact('<artifact name="a.md">unterminated', 'a.md')).toBeNull();
  });
  it('parses tasks, verdicts, results, versions', () => {
    expect(parseTasks('### T1 — Add column\n### T2: Endpoint\n## not a task\n### T10 - x').map((t) => [t.id, t.title]))
      .toEqual([['T1', 'Add column'], ['T2', 'Endpoint'], ['T10', 'x']]);
    expect(parseVerdict('VERDICT: CHANGES_REQUESTED\n…')).toBe('CHANGES_REQUESTED');
    expect(parseVerdict('verdict: approved')).toBe('APPROVED');
    expect(parseVerdict('looks good')).toBeNull();
    expect(parseTestResult('RESULT: FAIL')).toBe('FAIL');
    expect(parseTestResult('nothing')).toBeNull();
    expect(versionedName('review.md', 1)).toBe('review.md');
    expect(versionedName('review.md', 3)).toBe('review-3.md');
  });
  it('summarizeTool shortens long inputs', () => {
    expect(summarizeTool('Bash', { command: 'a'.repeat(300) }).length).toBe(118);
    expect(summarizeTool('Read', { file_path: '/x/y.ts' })).toBe('/x/y.ts');
    expect(summarizeTool('X', undefined)).toBe('');
  });
});
