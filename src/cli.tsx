import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { render } from 'ink';
import { CLAUDE_MISSING_MESSAGE, claudeAvailable } from './claude.js';
import {
  DEFAULT_CONFIG, EFFORTS, getPath, leafPaths, loadConfig, resetConfig, setConfigValue, techleadWarnings, userDir, validateValue,
  type Scope,
} from './config.js';
import { Engine } from './engine.js';
import { claudeBin } from './claude.js';
import { interactiveArgs } from './roles.js';
import { listRuns, loadRunState } from './state.js';
import { toRole } from './commands.js';
import { App } from './ui/App.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

interface CommonOpts {
  autoApprove?: boolean;
  techleadModel?: string;
  devModel?: string;
  techleadEffort?: string;
  devEffort?: string;
  cwd?: string;
  verbose?: boolean;
  layout?: string;
  new?: boolean;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function requireClaude(): void {
  if (!claudeAvailable()) fail(CLAUDE_MISSING_MESSAGE);
}

function withCommon(cmd: Command): Command {
  return cmd
    .option('--auto-approve', 'skip all approval gates')
    .option('--techlead-model <model>', 'Tech Lead model for this session')
    .option('--dev-model <model>', 'Senior Dev model for this session')
    .option('--techlead-effort <level>', 'Tech Lead effort for this session (low|medium|high|xhigh|max)')
    .option('--dev-effort <level>', 'Senior Dev effort for this session (low|medium|high|xhigh|max)')
    .option('--cwd <path>', 'project directory (default: current directory)')
    .option('--verbose', 'show raw tool inputs')
    .option('--layout <layout>', 'split | tabs (default: automatic by terminal width)')
    .option('--new', 'start a new chat without asking about saved sessions');
}

async function startTui(opts: CommonOpts, first?: { requirement?: string; resume?: string | true }): Promise<void> {
  requireClaude();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('cd-agents needs an interactive terminal (stdin and stdout must be a TTY).');
  }
  const cwd = resolve(opts.cwd ?? process.cwd());
  if (opts.layout && !['split', 'tabs'].includes(opts.layout)) fail('--layout must be "split" or "tabs".');

  const flags: Record<string, unknown> = {};
  for (const [role, model, effort] of [['techlead', opts.techleadModel, opts.techleadEffort], ['dev', opts.devModel, opts.devEffort]] as const) {
    if (effort) {
      try { validateValue(`roles.${role}.effort`, effort); } catch (e) { fail((e as Error).message); }
    }
    if (model || effort) {
      flags.roles = { ...(flags.roles as object), [role]: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } };
    }
  }
  if (opts.autoApprove) flags.workflow = { autoApprove: true };
  if (opts.layout) flags.ui = { layout: opts.layout };

  let loaded;
  try { loaded = loadConfig(cwd, flags); } catch (e) { fail((e as Error).message); }
  const { config } = loaded;
  for (const w of techleadWarnings(config)) console.error(`warning: ${w}`);

  const engine = new Engine({ cwd, config, autoApprove: config.workflow.autoApprove });
  // Offer saved sessions unless the user already said what they want (a requirement, `resume`, `--new`).
  const startupRuns = !first && !opts.new ? engine.runSummaries() : [];
  const instance = render(
    <App
      engine={engine}
      verbose={!!opts.verbose}
      layout={config.ui.layout}
      splitMinColumns={config.ui.splitMinColumns}
      autoFocus={config.ui.autoFocus}
      startupRuns={startupRuns}
    />,
    { alternateScreen: true, exitOnCtrlC: false, maxFps: 30 },
  );

  if (first?.resume !== undefined) engine.resume(first.resume === true ? undefined : first.resume);
  else if (first?.requirement) engine.submit('techlead', first.requirement);

  await instance.waitUntilExit();
  const wasRunning = engine.running;
  engine.abort();
  await engine.whenSettled();
  if (engine.run) {
    console.log(`Run saved: ${engine.run.state.id}`);
    if (wasRunning) console.log('Resume it with: cd-agents resume');
    console.log(`Artifacts: ${engine.run.store.dir}`);
  }
}

// ───────────────────────── config command ─────────────────────────

const MODELS = ['opus', 'sonnet', 'haiku'];

function showConfig(cwd: string): void {
  const { config, sources } = loadConfig(cwd);
  const w = Math.max(...leafPaths(DEFAULT_CONFIG).map((k) => k.length));
  for (const k of leafPaths(DEFAULT_CONFIG)) {
    console.log(`${k.padEnd(w)}  ${JSON.stringify(getPath(config, k))}  (${sources[k]})`);
  }
}

async function interactiveConfig(cwd: string, scope: Scope): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string) => (await rl.question(q)).trim();
  try {
    for (;;) {
      const { config, sources } = loadConfig(cwd);
      console.log(`\nConfiguring ${scope} settings`);
      console.log(`  1) Tech Lead model : ${config.roles.techlead.model} (${sources['roles.techlead.model']})`);
      console.log(`  2) Senior Dev model: ${config.roles.dev.model} (${sources['roles.dev.model']})`);
      console.log(`  3) Tech Lead effort: ${config.roles.techlead.effort ?? 'default'} (${sources['roles.techlead.effort']})`);
      console.log(`  4) Senior Dev effort: ${config.roles.dev.effort ?? 'default'} (${sources['roles.dev.effort']})`);
      console.log(`  5) Test command    : ${config.testCommand ?? '(detect)'}`);
      console.log(`  6) Auto-approve    : ${config.workflow.autoApprove}`);
      console.log('  q) Quit');
      const choice = (await ask('> ')).toLowerCase();
      if (choice === 'q' || choice === '') return;
      try {
        if (choice === '1' || choice === '2') {
          const key = choice === '1' ? 'roles.techlead.model' : 'roles.dev.model';
          MODELS.forEach((m, i) => console.log(`  ${i + 1}) ${m}`));
          console.log(`  ${MODELS.length + 1}) custom model ID…`);
          const pick = await ask('Model: ');
          const n = Number(pick);
          let model = n >= 1 && n <= MODELS.length ? MODELS[n - 1]! : pick;
          if (n === MODELS.length + 1) model = await ask('Model ID: ');
          setConfigValue(scope, cwd, key, JSON.stringify(model));
        } else if (choice === '3' || choice === '4') {
          const key = choice === '3' ? 'roles.techlead.effort' : 'roles.dev.effort';
          const levels = [...EFFORTS, 'default'];
          levels.forEach((l, i) => console.log(`  ${i + 1}) ${l}${l === 'default' ? " (Claude's default for the model)" : ''}`));
          const pick = await ask('Effort: ');
          const n = Number(pick);
          const level = n >= 1 && n <= levels.length ? levels[n - 1]! : pick.toLowerCase();
          setConfigValue(scope, cwd, key, level === 'default' ? 'null' : JSON.stringify(level));
        } else if (choice === '5') {
          const cmd = await ask('Test command (empty to auto-detect): ');
          setConfigValue(scope, cwd, 'testCommand', cmd ? JSON.stringify(cmd) : 'null');
        } else if (choice === '6') {
          setConfigValue(scope, cwd, 'workflow.autoApprove', String(!config.workflow.autoApprove));
        } else {
          console.log('Unknown choice.');
        }
      } catch (e) {
        console.error((e as Error).message);
      }
    }
  } finally {
    rl.close();
  }
}

// ───────────────────────── program ─────────────────────────

const program = new Command();
program
  .name('cd-agents')
  .description('Tech Lead + Senior Dev workflow on top of Claude Code')
  .version(pkg.version);

withCommon(program)
  .argument('[requirement...]', 'requirement to start with')
  .action(async (req: string[], opts: CommonOpts) => {
    await startTui(opts, req.length ? { requirement: req.join(' ') } : undefined);
  });

withCommon(program.command('resume').argument('[run-id]', 'run to resume (latest if omitted)').description('resume a saved run'))
  .action(async (runId: string | undefined, opts: CommonOpts) => {
    await startTui(opts, { resume: runId ?? true });
  });

program
  .command('claude')
  .description("continue a role's chat in the real Claude Code (latest run, or a given run)")
  .argument('[role]', 'techlead | dev', 'techlead')
  .argument('[run-id]', 'run id (latest if omitted)')
  .option('--cwd <path>', 'project directory')
  .action((roleArg: string, runId: string | undefined, o: { cwd?: string }) => {
    requireClaude();
    const cwd = resolve(o.cwd ?? process.cwd());
    const role = toRole(roleArg);
    if (!role) fail('Role must be "techlead" or "dev".');
    const ids = listRuns(cwd);
    const id = runId ?? ids[ids.length - 1];
    const state = id ? loadRunState(cwd, id) : undefined;
    if (!id || !state) fail(runId ? `Run "${runId}" not found.` : 'No saved runs in this directory.');
    const session = state.sessions[role];
    if (!session.started) fail(`The ${roleArg} has no conversation in run ${id} yet.`);
    let args: string[];
    try { args = interactiveArgs(role, loadConfig(cwd).config, cwd, session.id); } catch (e) { fail((e as Error).message); }
    console.error(`Resuming the ${roleArg}'s conversation from run ${id}…`);
    const r = spawnSync(claudeBin(), args, { stdio: 'inherit', cwd });
    process.exit(r.status ?? 1);
  });

program
  .command('config')
  .description('view / edit configuration')
  .argument('[subcommand]', 'show | get | set | reset')
  .argument('[key]')
  .argument('[value...]')
  .option('--project', 'use the project config instead of the user config')
  .option('--cwd <path>', 'project directory')
  .option('-y, --yes', 'skip confirmation (reset)')
  .action(async (sub: string | undefined, key: string | undefined, value: string[], o: { project?: boolean; cwd?: string; yes?: boolean }) => {
    const cwd = resolve(o.cwd ?? process.cwd());
    const scope: Scope = o.project ? 'project' : 'user';
    try {
      switch (sub) {
        case undefined:
          if (!process.stdin.isTTY) return showConfig(cwd);
          return await interactiveConfig(cwd, scope);
        case 'show': return showConfig(cwd);
        case 'get': {
          if (!key) fail('Usage: cd-agents config get <key>');
          const v = getPath(loadConfig(cwd).config, key);
          if (v === undefined) fail(`Unknown config key "${key}".`);
          return console.log(typeof v === 'string' ? v : JSON.stringify(v));
        }
        case 'set': {
          if (!key || !value.length) fail('Usage: cd-agents config set <key> <value>');
          setConfigValue(scope, cwd, key, value.join(' '));
          return console.log(`${key} = ${JSON.stringify(getPath(loadConfig(cwd).config, key))}  (${scope})`);
        }
        case 'reset': {
          if (!o.yes) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const a = (await rl.question(`Reset ${scope} config to defaults? [y/N] `)).trim().toLowerCase();
            rl.close();
            if (a !== 'y') return console.log('Cancelled.');
          }
          resetConfig(scope, cwd);
          return console.log(`${scope} config reset.`);
        }
        default: fail(`Unknown config subcommand "${sub}". Use show | get | set | reset.`);
      }
    } catch (e) {
      fail((e as Error).message);
    }
  });

program
  .command('uninstall')
  .description('remove cd-agents')
  .option('-y, --yes', 'also delete ~/.cd-agents without asking')
  .action(async (o: { yes?: boolean }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const dir = userDir();
    const a = o.yes ? 'y' : (await rl.question(`Also delete ${dir} (config and prompts)? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (a === 'y') { rmSync(dir, { recursive: true, force: true }); console.log(`Deleted ${dir}`); }
    const r = spawnSync('npm', ['uninstall', '-g', 'cd-agents'], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  });

program.parseAsync().catch((e: Error) => fail(e.message));
