import { spawnSync } from 'node:child_process';
import { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize, type Key } from 'ink';
import { runCommand } from '../commands.js';
import type { Engine, RunSummary } from '../engine.js';
import { STAGES } from '../stages.js';
import { ROLES, type Role } from '../types.js';
import { ActionBar, actionBarLines } from './ActionBar.js';
import { applyKey, emptyInput, type InputState } from './input.js';
import { COMMIT_DELAY_MS, classifyGateKey } from './gatekeys.js';
import { Pane } from './Pane.js';
import { MAX_LISTED, StartupMenu } from './StartupMenu.js';

type Focus = Role | 'gate';

const NO_KEY: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false,
};

export interface AppProps {
  engine: Engine;
  verbose: boolean;
  layout: 'auto' | 'split' | 'tabs';
  splitMinColumns: number;
  autoFocus: boolean;
  /** Saved runs to offer at startup; empty → go straight to a new chat. */
  startupRuns?: RunSummary[];
}

const HINTS = 'Tab switch pane · Ctrl+G approval · Esc interrupt · PgUp/PgDn scroll · /help';

/** Don't move focus if the user typed this recently or has text in the focused input. */
const TYPING_GRACE_MS = 1200;

export function App({ engine, verbose, layout, splitMinColumns, autoFocus, startupRuns = [] }: AppProps) {
  const { columns, rows } = useWindowSize();
  const { exit, suspendTerminal } = useApp();
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [focus, setFocus] = useState<Focus>('techlead');
  const lastPane = useRef<Role>('techlead');
  const [inputs, setInputs] = useState<Record<Role, InputState>>({ techlead: emptyInput, dev: emptyInput });
  const [scroll, setScroll] = useState<Record<Role, number>>({ techlead: 0, dev: 0 });
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState<InputState>(emptyInput);
  const [notice, setNotice] = useState<string | undefined>();
  const ctrlC = useRef<NodeJS.Timeout | undefined>(undefined);
  const [menu, setMenu] = useState<number | null>(startupRuns.length ? 0 : null);
  const seen = useRef<Record<Role, number>>({ techlead: 0, dev: 0 });
  const lastKeyAt = useRef(0);
  const followStage = useRef<NodeJS.Timeout | undefined>(undefined);
  const abortArmed = useRef<NodeJS.Timeout | undefined>(undefined);
  /** A gate key waiting out COMMIT_DELAY_MS; cancelled if more typing follows. */
  const pendingGate = useRef<{ char: string; timer: NodeJS.Timeout } | undefined>(undefined);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  const focusRef = useRef(focus);
  focusRef.current = focus;
  const setFocusBoth = (f: Focus) => {
    if (f !== 'gate') lastPane.current = f;
    setFocus(f);
  };

  // Re-render on engine changes (throttled), and react to attention requests.
  useEffect(() => {
    let timer: NodeJS.Timeout | undefined;
    const onChange = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; bump(); }, 40);
    };
    const onAttention = (a: { type: 'role'; role: Role } | { type: 'gate' } | { type: 'stage'; role: Role }) => {
      if (!autoFocus) return;
      const cur = focusRef.current;
      // Never yank focus while the user is typing: stray letters could hit gate keys.
      const unsent = cur !== 'gate' && inputsRef.current[cur].text.length > 0;
      const busy = unsent || Date.now() - lastKeyAt.current < TYPING_GRACE_MS;
      if (a.type === 'stage') {
        // Following the work after a deliberate approval only needs an empty input box.
        if (followStage.current && !unsent) setFocusBoth(a.role);
        clearTimeout(followStage.current);
        followStage.current = undefined;
        return;
      }
      // When a stage needs approval the UI switches to the approval bar by itself, unless you are
      // in the middle of typing. Stray keystrokes can't answer it by accident: see the gate-key
      // handling in useInput (typing is handed back to the pane; gate keys commit after a delay).
      if (a.type === 'gate') {
        if (cur === 'gate') return;
        if (busy) flash('Approval waiting — press Ctrl+G to answer');
        else setFocusBoth('gate');
        return;
      }
      if (busy && cur !== 'gate') {
        flash(`${a.role === 'techlead' ? 'Tech Lead' : 'Senior Dev'} is waiting for you — Tab to switch`);
        return;
      }
      setFocusBoth(a.role);
    };
    const onGateClosed = () => {
      if (pendingGate.current) { clearTimeout(pendingGate.current.timer); pendingGate.current = undefined; }
      setFeedbackMode(false);
      setFeedback(emptyInput);
      if (focusRef.current === 'gate') setFocus(lastPane.current);
      // The next stage's owner takes focus (if the user isn't typing).
      clearTimeout(followStage.current);
      followStage.current = setTimeout(() => { followStage.current = undefined; }, 3000);
    };
    const onEdit = (path: string) => {
      const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
      void suspendTerminal(() => {
        spawnSync(`${editor} ${JSON.stringify(path)}`, { stdio: 'inherit', shell: true });
      }).then(() => engine.note(lastPane.current, `edited ${path.split('/').pop()}`));
    };
    engine.on('change', onChange);
    engine.on('attention', onAttention);
    engine.on('gate-closed', onGateClosed);
    engine.on('edit', onEdit);
    return () => {
      engine.off('change', onChange);
      engine.off('attention', onAttention);
      engine.off('gate-closed', onGateClosed);
      engine.off('edit', onEdit);
      if (timer) clearTimeout(timer);
    };
  }, [engine, autoFocus, suspendTerminal]);

  const gate = engine.gate;
  // If the gate disappeared while focused (e.g. auto-approve toggled), leave it.
  const effFocus: Focus = focus === 'gate' && !gate ? lastPane.current : focus;
  const paneFocus: Role = effFocus === 'gate' ? lastPane.current : effFocus;
  const split = layout === 'split' || (layout === 'auto' && columns >= splitMinColumns);

  const ring = (): Focus[] => (gate ? [...ROLES, 'gate'] : [...ROLES]);
  const cycle = (dir: 1 | -1) => {
    const r = ring();
    const i = Math.max(0, r.indexOf(effFocus));
    setFocusBoth(r[(i + dir + r.length) % r.length]!);
  };

  const flash = (t: string) => {
    setNotice(t);
    setTimeout(() => setNotice((n) => (n === t ? undefined : n)), 2500);
  };

  /** Continue this role's chat in the real Claude Code, then return to the panes. */
  const openClaude = (role: Role) => {
    const h = engine.openInteractive(role);
    if ('error' in h) { engine.note(role, h.error); return; }
    engine.note(role, `Opening Claude Code (${engine.config.roles[role].model}) on this role's conversation — exit it (/exit) to come back here.`);
    void suspendTerminal(() => {
      const r = spawnSync(h.spec.bin, h.spec.args, { stdio: 'inherit', cwd: h.spec.cwd });
      if (r.error) engine.note(role, `Could not start claude: ${r.error.message}`);
    }).finally(() => h.release());
  };

  const submitPane = (role: Role, text: string) => {
    if (!text.trim()) return;
    setScroll((s) => ({ ...s, [role]: 0 }));
    if (text.trim().startsWith('/')) {
      runCommand(engine, text, { focused: role, focus: setFocusBoth, exit, openClaude });
    } else {
      engine.submit(role, text);
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (ctrlC.current) { clearTimeout(ctrlC.current); exit(); return; }
      flash('Press Ctrl+C again to exit (the run is saved).');
      ctrlC.current = setTimeout(() => { ctrlC.current = undefined; }, 2000);
      return;
    }
    if (menu !== null) {
      // Startup: new chat, or resume a saved session.
      const listed = startupRuns.slice(0, MAX_LISTED);
      const choose = (sel: number) => {
        setMenu(null);
        if (sel > 0) engine.resume(listed[sel - 1]!.id);
      };
      if (key.upArrow || input === 'k') setMenu((m) => Math.max(0, (m ?? 0) - 1));
      else if (key.downArrow || input === 'j') setMenu((m) => Math.min(listed.length, (m ?? 0) + 1));
      else if (key.return) choose(menu);
      else if (key.escape || input.toLowerCase() === 'n') choose(0);
      else if (/^[1-9]$/.test(input) && Number(input) <= listed.length) choose(Number(input));
      return;
    }
    if (key.ctrl && input === 'g') { if (gate) setFocusBoth('gate'); return; }
    if (key.tab) return cycle(key.shift ? -1 : 1);
    if (key.ctrl && (key.leftArrow || key.rightArrow)) return cycle(key.rightArrow ? 1 : -1);

    if (effFocus === 'gate' && gate) {
      if (feedbackMode) {
        if (key.escape) { setFeedbackMode(false); setFeedback(emptyInput); return; }
        const r = applyKey(feedback, input, key);
        if (r.submit !== undefined) {
          if (r.submit.trim()) engine.decide('r', r.submit.trim());
          return;
        }
        setFeedback(r.state);
        return;
      }
      if (key.escape) {
        if (pendingGate.current) { clearTimeout(pendingGate.current.timer); pendingGate.current = undefined; }
        return setFocusBoth(lastPane.current);
      }
      const k = classifyGateKey(input, key, gate.options);
      if (k.kind === 'ignore') return;

      // The user is typing a message, not answering: give the keys back to the pane they came from.
      const typeIntoPane = (before = '') => {
        const target = lastPane.current;
        setFocusBoth(target);
        lastKeyAt.current = Date.now();
        setInputs((s) => {
          const st = before ? applyKey(s[target], before, NO_KEY).state : s[target];
          return { ...s, [target]: applyKey(st, input, key).state };
        });
      };
      const pending = pendingGate.current;
      if (pending) {
        // A second key right after a gate key: it was the start of a word ("actually…"), not an answer.
        clearTimeout(pending.timer);
        pendingGate.current = undefined;
        return typeIntoPane(pending.char);
      }
      if (k.kind === 'typing') return typeIntoPane();

      const opt = k.opt;
      pendingGate.current = {
        char: input,
        timer: setTimeout(() => {
          pendingGate.current = undefined;
          if (!engine.gate?.options.some((o) => o.key === opt.key)) return;
          if (opt.needsText) setFeedbackMode(true);
          else if (opt.key === 'q') {
            // Aborting the run needs a second press.
            if (abortArmed.current) { clearTimeout(abortArmed.current); abortArmed.current = undefined; engine.decide('q'); }
            else {
              flash('Press q again to abort the run');
              abortArmed.current = setTimeout(() => { abortArmed.current = undefined; }, 3000);
            }
          } else engine.decide(opt.key);
        }, COMMIT_DELAY_MS),
      };
      return;
    }

    const role = paneFocus;
    if (key.escape) { engine.interrupt(role); return; }
    const h = Math.max(3, Math.floor((rows - 8) / 1));
    if (key.pageUp) return setScroll((s) => ({ ...s, [role]: s[role] + Math.max(1, h - 2) }));
    if (key.pageDown) return setScroll((s) => ({ ...s, [role]: Math.max(0, s[role] - Math.max(1, h - 2)) }));
    // Only real text typed into a pane counts as "typing" (not gate keys, Tab, Ctrl+…).
    if (input && !key.ctrl && !key.meta) lastKeyAt.current = Date.now();
    const r = applyKey(inputs[role], input, key);
    setInputs((s) => ({ ...s, [role]: r.state }));
    if (r.submit !== undefined) {
      lastKeyAt.current = 0; // sent: the box is empty, so the user is no longer mid-typing
      submitPane(role, r.submit);
    }
  });

  if (menu !== null) {
    return <StartupMenu runs={startupRuns} selected={menu} cwd={engine.cwd} width={columns} />;
  }

  // ── layout ──
  const state = engine.run?.state;
  const done = engine.tasks.filter((t) => t.done).length;
  const stageLabel = engine.stage === 'idle' || engine.stage === 'done' || engine.stage === 'aborted'
    ? engine.stage.toUpperCase()
    : `${STAGES[engine.stage].n} ${STAGES[engine.stage].title}${engine.tasks.length ? ` (${done}/${engine.tasks.length} tasks)` : ''}`;
  const header = `cd-agents${state ? ` · ${state.id}` : ''} ── ${stageLabel} ── mode: ${engine.autoApprove ? 'auto' : 'manual'}${engine.costUsd ? ` · $${engine.costUsd.toFixed(2)}` : ''}`;

  const barH = actionBarLines(gate, feedbackMode) + 1;
  const tabsH = split ? 0 : 1;
  const paneH = Math.max(8, rows - 1 - barH - tabsH - 1);
  const version = (r: Role) => engine.panes[r].length + (engine.panes[r].at(-1)?.text.length ?? 0);
  if (split) { seen.current.techlead = version('techlead'); seen.current.dev = version('dev'); }
  else seen.current[paneFocus] = version(paneFocus);
  const unread = (r: Role) => !split && r !== paneFocus && version(r) !== seen.current[r];

  const paneFor = (r: Role, width: number) => (
    <Pane
      key={r}
      role={r}
      model={engine.config.roles[r].model}
      effort={engine.config.roles[r].effort}
      status={engine.status[r]}
      entries={engine.panes[r]}
      input={inputs[r]}
      width={width}
      height={paneH}
      focused={effFocus === r}
      scroll={scroll[r]}
      verbose={verbose}
      placeholder={r === 'techlead' ? 'describe a requirement, or ask the tech lead…' : 'ask the dev…'}
    />
  );

  const half = Math.floor(columns / 2);
  return (
    <Box flexDirection="column" width={columns} height={rows - 1}>
      <Text bold color="cyan" wrap="truncate-end">{header}</Text>
      {!split ? (
        <Box height={1}>
          {ROLES.map((r) => (
            <Text key={r} bold={paneFocus === r} inverse={paneFocus === r}>
              {` ${r === 'techlead' ? 'Tech Lead' : 'Senior Dev'}${unread(r) ? ' •' : ''} `}
            </Text>
          ))}
        </Box>
      ) : null}
      {split ? (
        <Box>
          {paneFor('techlead', half)}
          {paneFor('dev', columns - half)}
        </Box>
      ) : paneFor(paneFocus, columns)}
      <ActionBar
        gate={gate}
        gateFocused={effFocus === 'gate'}
        feedbackMode={feedbackMode}
        feedback={feedback}
        hints={HINTS}
        tasks={engine.tasks}
        activeTask={engine.activeTask}
        width={columns}
        notice={notice}
      />
    </Box>
  );
}
