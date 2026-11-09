import { loadConfig, type Scope } from './config.js';
import type { Engine } from './engine.js';
import { promptPath } from './roles.js';
import { ROLES, type Role } from './types.js';

export interface CommandCtx {
  focused: Role;
  focus: (r: Role) => void;
  exit: () => void;
  /** Suspend the TUI and run the role's session in the real interactive `claude`. */
  openClaude: (r: Role) => void;
}

const HELP = `Commands (work from either pane):
  /help                         this list
  /focus techlead|dev           move focus (same as Tab)
  /clear [techlead|dev]         clear a pane's visible transcript
  /config                       show effective configuration
  /model techlead|dev <model> [--save]   change a role's model (--save keeps it as default)
  /claude [techlead|dev]        continue that role's chat in the real Claude Code, then come back here
  /compact [techlead|dev|all] [what to keep]   compact a role's conversation context
  /status                       run id, stage, models, cost
  /approve                      approve the open gate
  /reject <feedback>            reject the open gate, send feedback to the role
  /wontfix 1,3                  mark review findings as "won't fix" before the Fix stage
  /auto on|off                  toggle auto-approve
  /artifacts                    list files produced by this run
  /abort                        stop the run (saved, resumable)
  /new [fresh]                  start a new requirement, continuing both roles' conversations (fresh = clean slate)
  /resume [run-id]              resume a saved run
  /exit                         quit
At a gate: [a] approve  [r] reject  [e] edit  [v] view  [q] abort.
Text you send to the role that isn't working is a read-only side chat.`;

export const toRole = (s: string | undefined): Role | undefined =>
  s === 'techlead' || s === 'tl' ? 'techlead' : s === 'dev' || s === 'senior' ? 'dev' : undefined;

export function runCommand(engine: Engine, line: string, ctx: CommandCtx): void {
  const [cmd = '', ...rest] = line.trim().slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const say = (t: string) => engine.note(ctx.focused, t);

  switch (cmd.toLowerCase()) {
    case 'help': case '?': return say(HELP);
    case 'exit': case 'quit': return ctx.exit();
    case 'focus': {
      const r = toRole(rest[0]);
      return r ? ctx.focus(r) : say('Usage: /focus techlead|dev');
    }
    case 'clear': {
      const r = toRole(rest[0]);
      if (rest[0] && !r) return say('Usage: /clear [techlead|dev]');
      return engine.clearPane(r ?? ctx.focused);
    }
    case 'config': {
      const { sources } = loadConfig(engine.cwd);
      const c = engine.config;
      const lines = ROLES.map((r) =>
        `${r === 'techlead' ? 'Tech Lead' : 'Senior Dev'}: model=${c.roles[r].model} (${sources[`roles.${r}.model`]}) prompt=${safePrompt(engine, r)}`);
      lines.push(
        `approval: ${engine.autoApprove ? 'auto' : 'manual'} · maxFix=${c.workflow.maxFixIterations} · maxReview=${c.workflow.maxReviewIterations}`,
        `testCommand: ${c.testCommand ?? '(detect)'} · layout=${c.ui.layout}`,
        `Change a model with /model, or run "cd-agents config set <key> <value>" for anything else.`,
      );
      return say(lines.join('\n'));
    }
    case 'model': {
      if (!rest.length) return say(`Tech Lead = ${engine.config.roles.techlead.model} · Senior Dev = ${engine.config.roles.dev.model}`);
      const role = toRole(rest[0]);
      const save = rest.includes('--save');
      const model = rest.slice(1).filter((x) => x !== '--save')[0];
      if (!role || !model) return say('Usage: /model techlead|dev <model> [--save]');
      try {
        engine.setModel(role, model, save ? ('user' as Scope) : undefined);
        return say(`${role === 'techlead' ? 'Tech Lead' : 'Senior Dev'} model → ${model}${save ? ' (saved as default)' : ' (this session only; add --save to keep)'}`);
      } catch (e) { return say((e as Error).message); }
    }
    case 'claude': {
      const r = rest[0] ? toRole(rest[0]) : ctx.focused;
      return r ? ctx.openClaude(r) : say('Usage: /claude [techlead|dev]');
    }
    case 'compact': {
      const first = rest[0]?.toLowerCase();
      const target: Role | 'all' | undefined = first === 'all' ? 'all' : toRole(first);
      const instructions = (target ? rest.slice(1) : rest).join(' ');
      void engine.compact(target ?? ctx.focused, instructions || undefined);
      return;
    }
    case 'status': return say(engine.describe());
    case 'approve': return engine.gate ? engine.decide('a') : say('No approval is pending.');
    case 'reject': {
      if (!engine.gate) return say('No approval is pending.');
      if (!engine.gate.options.some((o) => o.needsText)) return say('This prompt has no reject option.');
      return arg ? engine.decide('r', arg) : say('Usage: /reject <feedback>');
    }
    case 'wontfix': {
      const nums = arg.split(/[\s,]+/).filter(Boolean).map(Number);
      if (!nums.length || nums.some((n) => !Number.isInteger(n) || n < 1)) return say('Usage: /wontfix 1,3');
      engine.setWontFix(nums);
      return say(`Findings marked won't fix: ${nums.join(', ')}`);
    }
    case 'auto': {
      if (arg !== 'on' && arg !== 'off') return say(`Auto-approve is ${engine.autoApprove ? 'on' : 'off'}. Usage: /auto on|off`);
      engine.setAutoApprove(arg === 'on');
      return say(`Auto-approve ${arg}.`);
    }
    case 'artifacts': {
      const files = engine.artifactList();
      return say(files.length ? files.join('\n') : 'No artifacts yet.');
    }
    case 'abort':
      if (!engine.running) return say('Nothing is running.');
      return engine.abort();
    case 'new':
    {
      const arg0 = rest[0]?.toLowerCase();
      const fresh = arg0 === 'fresh' || arg0 === '--fresh';
      if (arg0 && !fresh) return say('Usage: /new [fresh]');
      return engine.newRun({ fresh }) ? undefined : say('A run is in progress. Use /abort first.');
    }
    case 'resume':
      if (!engine.resume(arg || undefined)) say(engine.running ? 'A run is in progress. Use /abort first.' : 'Could not resume.');
      return;
    default: return say(`Unknown command /${cmd}. Type /help.`);
  }
}

function safePrompt(engine: Engine, role: Role): string {
  try { return promptPath(role, engine.cwd, engine.config); } catch { return '(missing)'; }
}
