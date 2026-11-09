# cd-agents

A CLI on top of [Claude Code](https://docs.claude.com/en/docs/claude-code) that splits work between two roles, each with its own model and system prompt:

- **Tech Lead** (default `opus`) — clarifies the requirement, designs the solution, reviews the result. Read-only; never edits code.
- **Senior Dev** (default `sonnet`) — implements the design, writes and runs tests, applies review fixes.

```
requirement → ① clarify → ② design → ③ implement → ④ test → ⑤ review ⇄ ⑥ fix → done
                (Tech Lead)            (Senior Dev)           (TL)     (Dev)
```

The Tech Lead reviews only the Senior Dev's changes (diff plus new files), not the whole source. Every stage ends at an approval gate (approve / reject with feedback / edit / view / abort). Pass `--auto-approve` to skip the gates. Nothing is ever committed for you.

## Install

Requires Claude Code and Node.js ≥ 22.

```sh
curl -fsSL <repo-url>/install.sh | bash     # checks for Claude Code first
# or
npm install -g cd-agents
```

If `claude` isn't installed, both exit with a message and change nothing.

## Use

```sh
cd your-project
cd-agents                       # asks: new chat, or resume a saved session (skipped if none)
cd-agents --new                 # skip the question, start a new chat
cd-agents "Add OTP login"       # start with a requirement
cd-agents --auto-approve "…"    # no approval gates
cd-agents resume                # continue the latest saved run
```

Type a requirement into the left pane. `Tab` / `Shift+Tab` switches panes (and the approval bar when a gate is open), When a stage needs approval the UI switches to the approval bar by itself — press `a` to approve, `r` to reject with feedback, `e` to edit, `v` to view (stray typing can't approve by accident: text goes to the pane, and gate keys commit after a short delay). `Ctrl+G` jumps to the bar if you were typing when it opened, `Esc` interrupts the focused role, `/help` lists commands. Focus follows the work — after you approve a stage it moves to the role that takes over — but never while you have text typed in a box. Talking to the role that isn't working gives a read-only side chat.

**Several requirements in a row.** `/new` starts the next requirement and *keeps both roles' conversations*, so the Tech Lead and Senior Dev remember earlier work (`/new fresh` for a clean slate). On top of that, the Tech Lead is shown a short list of earlier requirements and their `docs/` folders and reads the ones that are relevant.

When a requirement finishes, both roles' conversations are compacted automatically (turn off with `cd-agents config set workflow.autoCompact false`).

Two commands for long sessions:
- `/claude [techlead|dev]` — continue that role's chat in the real Claude Code (same session, same model), then come back to the panes. Outside the TUI: `cd-agents claude [techlead|dev]`.
- `/compact [techlead|dev|all] [what to keep]` — compact a role's context, like Claude Code's `/compact`.

### Models and config

```sh
cd-agents config                              # interactive
cd-agents config set roles.techlead.model opus
cd-agents config set roles.dev.model sonnet
cd-agents config show                         # effective values + where each comes from
cd-agents --dev-model haiku                   # one session only
```

Precedence: flags > `.cd-agents/config.json` (project) > `~/.cd-agents/config.json` (user) > defaults. Override a role prompt by putting `techlead.md` / `dev.md` in `~/.cd-agents/prompts/` or `.cd-agents/prompts/`.

The Tech Lead's documents (`requirements.md`, `design.md`, `review.md`) are written to `docs/<requirement-slug>/` in your project (change with `cd-agents config set docsDir <path>`), so you can commit them. Run bookkeeping — transcripts, session state, the Senior Dev's final messages — is in `.cd-agents/runs/<id>/` (the Senior Dev writes no report files); add `.cd-agents/runs/` to your `.gitignore`.

## Develop

```sh
npm install
npm run dev -- "some requirement"   # run from source
npm test                            # uses a fake `claude`, no tokens spent
npm run build
```

Full design: [docs/specs.md](docs/specs.md).
