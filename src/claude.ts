import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RunOptions {
  cwd: string;
  prompt: string;
  model: string;
  /** `--effort` level; null/undefined = Claude's default. */
  effort?: string | null;
  systemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
  sessionId: string;
  /** true → `--resume <id>`; false → `--session-id <id>` (first turn). */
  resume: boolean;
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string; detail: string }
  | { type: 'tool_error'; text: string }
  | { type: 'compact'; trigger: string; pre: number; post: number };

export interface RunResult {
  text: string;
  costUsd: number;
  isError: boolean;
  error?: string;
  interrupted: boolean;
}

export function claudeBin(): string {
  return process.env.CD_AGENTS_CLAUDE_BIN || 'claude';
}

/** Is the claude binary runnable? */
export function claudeAvailable(): boolean {
  const r = spawnSync(claudeBin(), ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

export const CLAUDE_MISSING_MESSAGE = `✖ Claude Code is not installed.
  cd-agents runs on top of Claude Code. Install it first:
  https://docs.claude.com/en/docs/claude-code/setup
  Then re-run this installer.`;

export function buildArgs(o: Omit<RunOptions, 'cwd' | 'prompt' | 'signal' | 'onEvent'>): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', o.model,
    ...(o.effort ? ['--effort', o.effort] : []),
    '--append-system-prompt', o.systemPrompt,
    '--permission-mode', o.permissionMode,
  ];
  if (o.allowedTools.length) args.push('--allowedTools', o.allowedTools.join(','));
  if (o.disallowedTools.length) args.push('--disallowedTools', o.disallowedTools.join(','));
  args.push(o.resume ? '--resume' : '--session-id', o.sessionId);
  return args;
}

export function summarizeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof i[k] === 'string' && i[k]) return i[k] as string;
    return '';
  };
  const s = pick('file_path', 'path', 'command', 'pattern', 'url', 'query', 'description').replace(/\s+/g, ' ');
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

/** Spawn `claude -p`, stream parsed events, resolve with the turn result. */
export function runClaude(o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(claudeBin(), buildArgs(o), {
      cwd: o.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cd-agents' },
    });

    let text = '';
    let costUsd = 0;
    let isError = false;
    let error: string | undefined;
    let sawResult = false;
    let interrupted = false;
    let stderr = '';
    const deltaMsgs = new Set<string>();

    const onAbort = () => {
      interrupted = true;
      child.kill('SIGTERM');
    };
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdin.on('error', () => {});
    child.stdin.end(o.prompt);

    const emitText = (t: string) => {
      if (!t) return;
      text += t;
      o.onEvent({ type: 'text', text: t });
    };

    createInterface({ input: child.stdout }).on('line', (line) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init' && ev.session_id) o.onEvent({ type: 'session', id: ev.session_id });
          if (ev.subtype === 'compact_boundary') {
            const m = ev.compact_metadata ?? {};
            o.onEvent({ type: 'compact', trigger: String(m.trigger ?? 'auto'), pre: Number(m.pre_tokens ?? 0), post: Number(m.post_tokens ?? 0) });
          }
          break;
        case 'stream_event': {
          const e = ev.event;
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            if (ev.api_message_id) deltaMsgs.add(ev.api_message_id);
            emitText(e.delta.text);
          } else if (e?.type === 'message_stop' && text && !text.endsWith('\n')) {
            // keep consecutive assistant messages from running together
            text += '\n';
            o.onEvent({ type: 'text', text: '\n' });
          }
          break;
        }
        case 'assistant': {
          const msg = ev.message;
          for (const b of msg?.content ?? []) {
            if (b.type === 'text' && !deltaMsgs.has(msg.id)) emitText(b.text + '\n');
            if (b.type === 'tool_use') {
              o.onEvent({
                type: 'tool',
                name: b.name,
                summary: summarizeTool(b.name, b.input),
                detail: JSON.stringify(b.input ?? {}),
              });
            }
          }
          break;
        }
        case 'user':
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'tool_result' && b.is_error) {
              const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
              o.onEvent({ type: 'tool_error', text: t.slice(0, 200) });
            }
          }
          break;
        case 'result':
          sawResult = true;
          costUsd = Number(ev.total_cost_usd ?? 0);
          isError = !!ev.is_error;
          if (isError) error = typeof ev.result === 'string' && ev.result ? ev.result : 'Claude reported an error.';
          break;
      }
    });

    child.on('error', (e) => {
      resolve({ text, costUsd, isError: true, error: `Failed to start claude: ${e.message}`, interrupted });
    });
    child.on('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort);
      if (interrupted) return resolve({ text, costUsd, isError: false, interrupted: true });
      if (!sawResult && code !== 0) {
        isError = true;
        error = (stderr.trim().split('\n').slice(-3).join('\n') || `claude exited with code ${code}`);
      }
      resolve({ text, costUsd, isError, error, interrupted: false });
    });
  });
}
