import { describe, expect, it } from 'vitest';
import type { Key } from 'ink';
import { applyKey, emptyInput, type InputState } from '../src/ui/input.js';
import { collapseArtifacts, entryLines, transcriptLines, visibleSlice, wrap } from '../src/ui/lines.js';
import { taskSummary } from '../src/ui/ActionBar.js';
import { runCommand } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';

const K = (o: Partial<Key> = {}): Key => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false, ...o,
});
const type = (s: InputState, text: string) => applyKey(s, text, K()).state;

describe('input editor', () => {
  it('types, moves, deletes and submits', () => {
    let s = type(emptyInput, 'helo');
    s = applyKey(s, '', K({ leftArrow: true })).state;
    s = type(s, 'l');
    expect(s).toEqual({ text: 'hello', cursor: 4 });
    s = applyKey(s, '', K({ backspace: true })).state;
    expect(s.text).toBe('helo');
    const r = applyKey({ text: 'go', cursor: 2 }, '', K({ return: true }));
    expect(r.submit).toBe('go');
    expect(r.state).toEqual(emptyInput);
  });
  it('newline via trailing backslash and alt+enter; paste keeps newlines', () => {
    expect(applyKey({ text: 'a\\', cursor: 2 }, '', K({ return: true }))).toMatchObject({ state: { text: 'a\n', cursor: 2 } });
    expect(applyKey({ text: 'ab', cursor: 1 }, '', K({ return: true, meta: true })).state.text).toBe('a\nb');
    expect(type(emptyInput, 'l1\r\nl2\rl3').text).toBe('l1\nl2\nl3');
  });
  it('ctrl shortcuts', () => {
    expect(applyKey({ text: 'foo bar', cursor: 7 }, 'w', K({ ctrl: true })).state.text).toBe('foo ');
    expect(applyKey({ text: 'foo bar', cursor: 3 }, 'u', K({ ctrl: true })).state.text).toBe(' bar');
    expect(applyKey({ text: 'foo bar', cursor: 3 }, 'k', K({ ctrl: true })).state.text).toBe('foo');
    expect(applyKey({ text: 'foo', cursor: 3 }, 'a', K({ ctrl: true })).state.cursor).toBe(0);
    expect(applyKey({ text: 'foo', cursor: 0 }, 'e', K({ ctrl: true })).state.cursor).toBe(3);
  });
  it('ignores control sequences and navigation keys as text', () => {
    const s = { text: 'x', cursor: 1 };
    expect(applyKey(s, '[', K({ escape: true })).state).toEqual(s);
    expect(applyKey(s, '\t', K({ tab: true })).state).toEqual(s);
    expect(applyKey(s, 'z', K({ ctrl: true })).state).toEqual(s);
  });
});

describe('line rendering', () => {
  it('wraps words and hard-breaks long tokens', () => {
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrap('a\n\nb', 10)).toEqual(['a', '', 'b']);
    for (const l of wrap('word '.repeat(50) + 'x'.repeat(100), 20)) expect(l.length).toBeLessThanOrEqual(20);
  });
  it('collapses complete and in-progress artifacts', () => {
    expect(collapseArtifacts('hi\n<artifact name="d.md">\na\nb\n</artifact>\nbye')).toBe('hi\n📄 d.md (2 lines)\nbye');
    expect(collapseArtifacts('x <artifact name="d.md">\npartial')).toBe('x 📄 d.md (writing…)');
  });
  it('renders each entry kind and respects width', () => {
    const w = 30;
    const entries = [
      { id: 1, kind: 'user' as const, text: 'x'.repeat(80) },
      { id: 2, kind: 'text' as const, text: '# Title\n' + 'y'.repeat(80) },
      { id: 3, kind: 'tool' as const, text: '▸ Edit  ' + 'z'.repeat(80), detail: '{"a":1}' },
      { id: 4, kind: 'marker' as const, text: '── Stage ①' },
      { id: 5, kind: 'error' as const, text: 'bad' },
    ];
    const lines = transcriptLines(entries, w, true);
    expect(lines.every((l) => l.text.length <= w)).toBe(true);
    expect(lines.find((l) => l.text.includes('Title'))!.bold).toBe(true);
    expect(entryLines(entries[4]!, w, false)[0]!.color).toBe('red');
    expect(entryLines(entries[2]!, w, false)).toHaveLength(1);
    expect(entryLines(entries[2]!, w, true).length).toBeGreaterThan(1);
  });
  it('visibleSlice anchors to the bottom and clamps scroll', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ text: String(i) }));
    expect(visibleSlice(lines, 3, 0).slice.map((l) => l.text)).toEqual(['7', '8', '9']);
    expect(visibleSlice(lines, 3, 2).slice.map((l) => l.text)).toEqual(['5', '6', '7']);
    expect(visibleSlice(lines, 3, 99)).toMatchObject({ offset: 7 });
    expect(visibleSlice(lines.slice(0, 2), 5, 3).slice).toHaveLength(2);
  });
  it('task summary shows state and truncates', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `T${i + 1}`, title: '', done: i < 2 }));
    expect(taskSummary(tasks.slice(0, 3), 'T3', 60)).toBe('Tasks: T1 ✔ T2 ✔ T3 ●');
    expect(taskSummary(tasks, 'T3', 30)).toMatch(/\+\d+ more$/);
    expect(taskSummary([], undefined, 30)).toBe('');
  });
});

describe('slash commands', () => {
  const mk = () => {
    process.env.CD_AGENTS_HOME = '/nonexistent-home';
    const cwd = process.cwd();
    const engine = new Engine({ cwd, config: loadConfig(cwd).config, autoApprove: false });
    const ctx = { focused: 'dev' as const, focus: () => {}, exit: () => { exited = true; } };
    let exited = false;
    const say = () => engine.panes.dev.map((e) => e.text).join('\n');
    return { engine, ctx, say, exited: () => exited };
  };
  it('/model changes the role model for this session', () => {
    const { engine, ctx } = mk();
    runCommand(engine, '/model techlead haiku', ctx);
    expect(engine.config.roles.techlead.model).toBe('haiku');
    runCommand(engine, '/model tl', ctx);
    runCommand(engine, '/model nobody x', ctx);
    expect(engine.config.roles.dev.model).toBe('sonnet');
  });
  it('/effort and /model --effort change the role effort', () => {
    const { engine, ctx } = mk();
    runCommand(engine, '/effort dev high', ctx);
    expect(engine.config.roles.dev.effort).toBe('high');
    runCommand(engine, '/effort dev bogus', ctx);
    expect(engine.config.roles.dev.effort).toBe('high');
    runCommand(engine, '/model techlead opus --effort max', ctx);
    expect(engine.config.roles.techlead.effort).toBe('max');
    expect(engine.config.roles.techlead.model).toBe('opus');
    runCommand(engine, '/effort dev default', ctx);
    expect(engine.config.roles.dev.effort).toBeNull();
    runCommand(engine, '/model dev haiku --effort nope', ctx);
    expect(engine.config.roles.dev.model).toBe('sonnet');
  });
  it('/auto, /help, /status, unknown, /exit', () => {
    const { engine, ctx, say, exited } = mk();
    runCommand(engine, '/auto on', ctx);
    expect(engine.autoApprove).toBe(true);
    runCommand(engine, '/help', ctx);
    runCommand(engine, '/status', ctx);
    runCommand(engine, '/bogus', ctx);
    expect(say()).toContain('/reject <feedback>');
    expect(say()).toContain('approve: auto');
    expect(say()).toContain('Unknown command /bogus');
    runCommand(engine, '/approve', ctx);
    expect(say()).toContain('No approval is pending');
    runCommand(engine, '/exit', ctx);
    expect(exited()).toBe(true);
  });
  it('/new keeps conversations by default, /new fresh resets, anything else is a usage error', () => {
    const { engine, ctx, say } = mk();
    let seen: unknown;
    engine.newRun = ((o?: unknown) => { seen = o; return true; }) as typeof engine.newRun;
    runCommand(engine, '/new', ctx);
    expect(seen).toEqual({ fresh: false });
    runCommand(engine, '/new fresh', ctx);
    expect(seen).toEqual({ fresh: true });
    runCommand(engine, '/new --fresh', ctx);
    expect(seen).toEqual({ fresh: true });
    seen = undefined;
    runCommand(engine, '/new nonsense', ctx);
    expect(seen).toBeUndefined();
    expect(say()).toContain('Usage: /new [fresh]');
  });
  it('/wontfix validates its argument', () => {
    const { engine, ctx, say } = mk();
    runCommand(engine, '/wontfix a,b', ctx);
    expect(say()).toContain('Usage: /wontfix');
  });
});

import { MAX_LISTED, runLabel, stageLabel } from '../src/ui/StartupMenu.js';
import type { RunSummary } from '../src/engine.js';

describe('startup menu labels', () => {
  const run = (o: Partial<RunSummary> = {}): RunSummary => ({
    id: 'r1', requirement: 'Add OTP login for admins', stage: 'implement', aborted: false,
    updatedAt: '2026-11-09T10:47:00.000Z', costUsd: 0, ...o,
  });
  it('describes where a run stopped', () => {
    expect(stageLabel(run({ stage: 'done' }))).toBe('✔ done');
    expect(stageLabel(run())).toBe('● ③ IMPLEMENT');
    expect(stageLabel(run({ aborted: true, stage: 'design' }))).toBe('⏸ stopped at ② DESIGN');
    expect(stageLabel(run({ stage: 'weird' }))).toBe('● weird');
  });
  it('fits the requirement into the width, first line only', () => {
    expect(runLabel(run(), 100)).toContain('Add OTP login for admins');
    const long = runLabel(run({ requirement: 'x'.repeat(200) + '\nsecond line' }), 60);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toContain('second line');
    expect(runLabel(run({ updatedAt: 'garbage' }), 80)).toContain('—');
    expect(MAX_LISTED).toBe(9);
  });
});

import { COMMIT_DELAY_MS, classifyGateKey } from '../src/ui/gatekeys.js';

describe('gate key classification', () => {
  const opts = [{ key: 'a', label: 'Approve' }, { key: 'r', label: 'Reject', needsText: true }, { key: 'q', label: 'Abort' }];
  it('recognises gate keys, case-insensitively', () => {
    expect(classifyGateKey('a', K(), opts)).toEqual({ kind: 'option', opt: opts[0] });
    expect(classifyGateKey('R', K(), opts)).toEqual({ kind: 'option', opt: opts[1] });
  });
  it('treats other printable text and pastes as typing (so it goes to the pane)', () => {
    expect(classifyGateKey('c', K(), opts)).toEqual({ kind: 'typing' });
    expect(classifyGateKey('e', K(), opts)).toEqual({ kind: 'typing' }); // `e` isn't offered at a dev gate
    expect(classifyGateKey('approve it', K(), opts)).toEqual({ kind: 'typing' }); // multi-char paste is never a gate key
    expect(classifyGateKey('/', K(), opts)).toEqual({ kind: 'typing' });
  });
  it('ignores navigation and control keys', () => {
    for (const k of [{ return: true }, { tab: true }, { escape: true }, { ctrl: true }, { meta: true }, { backspace: true }, { upArrow: true }, { pageUp: true }]) {
      expect(classifyGateKey('a', K(k), opts)).toEqual({ kind: 'ignore' });
    }
    expect(classifyGateKey('', K(), opts)).toEqual({ kind: 'ignore' });
  });
  it('commit delay is short but longer than normal typing cadence', () => {
    expect(COMMIT_DELAY_MS).toBeGreaterThanOrEqual(250);
    expect(COMMIT_DELAY_MS).toBeLessThanOrEqual(500);
  });
});
