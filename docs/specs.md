# cd-agents — Specification

> Status: v0.3 — implemented · Last updated: 2026-11-09 (see §15 for where the implementation refined this spec)

## 1. Purpose

`cd-agents` enhances the Claude Code workflow by splitting software work between two AI roles, each backed by a model the user picks:

| Role | Responsibility | Typical model |
|------|----------------|---------------|
| **Tech Lead** | Clarify business requirements, explore the codebase, design the solution, break it into tasks, review the final code (never edits code) | Strong reasoning model (e.g. Opus) |
| **Senior Dev** | Implement the design, write and run tests, fix review findings, report results | Fast coding model (e.g. Sonnet) |

It is a CLI built **on top of the `claude` (Claude Code) CLI**. It does not call the Anthropic API directly; every agent turn is executed by spawning `claude` with the right model, system prompt, and tool permissions. Authentication, billing, MCP servers, and project `CLAUDE.md` files are therefore inherited from the user's existing Claude Code setup.

## 2. Goals / Non-goals

**Goals**
- One command (`cd-agents`) that opens an interactive chat, similar to Claude Code.
- Independent model selection for Tech Lead and Senior Dev, changeable through a config command.
- A fixed, staged workflow: requirement → clarify → design → implement → test → review (→ fix).
- Human approval gate between every stage by default; `--auto-approve` bypasses the gates.
- A dedicated, overridable system prompt per role.

**Non-goals (v1)**
- Replacing Claude Code's own tools, auth, or permission system.
- Running more than one Senior Dev in parallel.
- Supporting LLM providers other than Claude.
- Any git write operations (commit, branch, push, stash). The user commits manually. The tool only *reads* git state, e.g. `git diff` for review.

## 3. Installation

`cd-agents` is distributed **both** as an npm package and through an install script. Both channels run the same Claude Code prerequisite check.

| Channel | Command | Notes |
|---------|---------|-------|
| npm | `npm install -g cd-agents` | A `preinstall` script runs the `claude` check and aborts the install if it fails. A `postinstall` script creates `~/.cd-agents/` defaults. |
| Install script | `curl -fsSL <repo-url>/install.sh \| bash` | Wraps the npm install and adds friendlier checks and messages (steps below). |

### 3.1 Install script (`install.sh`)

1. Check that Claude Code is installed: `command -v claude`.
   - **If missing:** print the message below and exit with code `1` without changing anything.
     ```
     ✖ Claude Code is not installed.
       cd-agents runs on top of Claude Code. Install it first:
       https://docs.claude.com/en/docs/claude-code/setup
       Then re-run this installer.
     ```
2. Check the runtime prerequisite (Node.js ≥ 22, required by the Ink TUI library). If it's missing or too old, print a message and exit `1`.
3. Run `npm install -g cd-agents`, which puts the `cd-agents` binary on `PATH`. If the global npm prefix isn't writable, fall back to a user prefix (`~/.local`) and tell the user to add `~/.local/bin` to `PATH` if needed. Don't use `sudo` silently.
4. Create `~/.cd-agents/` with a minimal `config.json` (just the two default models) and an empty `prompts/` directory, if they don't exist yet. Never overwrite existing user files. Built-in prompts are *not* copied, so upgrades keep improving them; drop a `<role>.md` into `prompts/` to override one (§7).
5. Print a success message: `✔ Installed. Run "cd-agents" in any project directory.`

### 3.2 Runtime check
Every time `cd-agents` starts, it repeats the `claude` presence check and fails with the same message if `claude` is missing, in case it was uninstalled after setup.

### 3.3 Uninstall
`cd-agents uninstall` (or `npm uninstall -g cd-agents`) removes the binary. `cd-agents uninstall` also asks whether to delete `~/.cd-agents/`.

### 3.4 Update
`npm update -g cd-agents`, or re-run `install.sh`.

## 4. CLI usage

```
cd-agents [options]                 Start interactive chat in the current directory
cd-agents "<requirement>"           Start chat and immediately submit a requirement
cd-agents config [subcommand]       View / edit configuration (see §6)
cd-agents resume [run-id]           Resume a previous run (latest if omitted)
cd-agents claude [techlead|dev] [run-id]
                                    Continue that role's chat in the real Claude Code (§5.2)
cd-agents --version | --help
```

**Options**

| Flag | Description |
|------|-------------|
| `--auto-approve` | Skip all approval gates (see §8.3) |
| `--techlead-model <model>` | Override the Tech Lead model for this session only |
| `--dev-model <model>` | Override the Senior Dev model for this session only |
| `--techlead-effort <level>` · `--dev-effort <level>` | Override a role's effort (`low`, `medium`, `high`, `xhigh`, `max`) for this session only |
| `--cwd <path>` | Project directory (default: current directory) |
| `--verbose` | Show raw tool calls and agent output |
| `--new` | Start a new chat without asking about saved sessions (see §5.0) |
| `--layout split\|tabs` | Force the side-by-side split or the tabbed single-pane layout (default: automatic, based on terminal width) |

## 5. Interactive chat (TUI)

### 5.0 Startup: new chat or resume
When `cd-agents` starts in a project that has saved runs, it first asks what to do:

```
  What would you like to do?
  ▸ Start a new chat
  Or resume a saved session:
    1  09 Nov 10:58  ⏸ stopped at ① CLARIFY  Refactor the billing module and rename inv…
    2  09 Nov 10:57  ✔ done  Add OTP login for admins
  ↑/↓ choose · Enter confirm · 1-2 resume that session · n / Esc new chat
```

- Newest first; up to 9 are listed (older ones: `cd-agents resume <run-id>`). Each line shows when the run was last active, where it stands (`● ③ IMPLEMENT` in progress, `⏸ stopped at …` aborted, `✔ done`) and the first line of the requirement.
- `↑`/`↓` (or `j`/`k`) + `Enter`, a digit to resume that session immediately, `n` or `Esc` for a new chat. "New chat" means fresh conversations; resume a session and use `/new` to carry its conversation into the next requirement (§5.4). Resuming restores both panes and reopens the gate the run stopped at (§15).
- The question is skipped when there is nothing to ask or the intent is already clear: no saved runs, a requirement given on the command line, the `resume` subcommand, or `--new`.

The screen is split into **two side-by-side chat panes**: **Tech Lead on the left, Senior Dev on the right**. Each pane looks and feels like Claude Code, with its own scrolling transcript and its own input box. A shared header and a shared action bar span the full width.

```
┌─ cd-agents · run 20261109-101500-login-otp ── Stage ③ IMPLEMENT (2/5 tasks) ── mode: manual ─┐
│ ● TECH LEAD · opus                 idle   │ ● SENIOR DEV · sonnet          working…           │
│───────────────────────────────────────────│───────────────────────────────────────────────────│
│ [You] Add OTP login for admin users       │ [Dev] Starting T1: add otp_secret column          │
│ [TL] A few questions before designing:    │   ▸ Edit  db/migrations/0042_otp.sql              │
│   1. SMS or authenticator app?            │   ▸ Bash  npm test -- otp  ✔ 12 passed            │
│ [You] Authenticator app                   │ [Dev] T1 done. Starting T2: verify endpoint       │
│ [TL] ✔ requirements.md  ✔ design.md       │   ▸ Edit  src/auth/otp.ts                         │
│                                           │                                                   │
│ ┌───────────────────────────────────────┐ │ ┌───────────────────────────────────────────────┐ │
│ │ > ask the tech lead…                  │ │ │ > ask the dev…                         ▌      │ │
│ └───────────────────────────────────────┘ │ └───────────────────────────────────────────────┘ │
├───────────────────────────────────────────┴───────────────────────────────────────────────────┤
│ Tab switch pane · Esc interrupt focused agent · /help              Tasks: T1 ✔  T2 ●  T3 ○ T4 ○ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Layout
- **Header (full width):** run id, current stage with task progress (e.g. `③ IMPLEMENT (2/5 tasks)`), and approval mode (`manual` / `auto`).
- **Pane header:** role name, model, effort (when set), and live status: `idle`, `thinking…`, `working…` (running tools), `waiting for you`, `blocked`, or `done`.
- **Pane transcript:** only that role's conversation: your messages to it, its replies, its tool-call summaries, and stage markers such as `✔ design.md saved`. Output streams in live. Tool calls are collapsed to one line (expand with `Enter` on the line, or use `--verbose`).
- **Pane input:** a multiline input box at the bottom of each pane.
- **Action bar (full width, bottom):** key hints, a task checklist (`✔` done, `●` in progress, `○` pending), and the **approval gate** when one is open (see §8.2). Gates appear here, not inside a pane, because a gate concerns the whole run.

### Focus and input
- `Tab` / `Shift+Tab` (or `Ctrl+←` / `Ctrl+→`) cycles focus: Tech Lead pane → Senior Dev pane → the approval bar (only while a gate is open). The focused pane has a highlighted border, and typing goes to its input box.
- **Approval bar.** When a stage needs approval the UI switches to the bar by itself (`▶` marks it as focused) and single keys answer it: `a` approve, `r` reject (opens a feedback line; `Esc` cancels), `e` edit, `v` view, `q` abort. Because those are plain letters, accidental answers are prevented three ways: (1) a letter that is **not** a gate key is treated as typing, so focus goes back to the pane you were in and the text is typed there; (2) a gate key only takes effect after a short delay (350 ms), and if another key follows within it, as in "actually…" or "run it twice", it was the start of a word and everything is typed into the pane instead; (3) the bar never takes focus while the focused input holds unsent text or you typed in the last ~1.2 s. Aborting also needs `q` pressed twice. `/approve` and `/reject <feedback>` work from any pane.
- Plain text is sent to the focused pane's role. Lines starting with `/` are slash commands and are global, whichever pane is focused.
- **Automatic focus** (turn off with `ui.autoFocus: false`):
  - When a gate opens, focus moves to the approval bar, unless you are typing (unsent text, or a keystroke in the last ~1.2 s); then the bar only shows `Approval waiting — press Ctrl+G to answer`. When a role asks you something (questions, a blocker), focus moves to its pane.
  - After a gate is answered, focus **follows the work**: it moves to the role that owns the next stage (approve clarify → Tech Lead designs; approve design → Senior Dev implements; approve test → Tech Lead reviews).
  - Focus **never moves while you are typing**: if the focused input has unsent text, or you typed in the last ~1.2 s, the action bar shows a notice instead.
- `Ctrl+G` jumps straight to the approval bar (useful when it did not switch automatically because you were typing). `Esc` leaves it. Typing a message while the bar is focused and pressing `Enter` sends it to the role as a side chat; the gate stays open.
- `PageUp` / `PageDown` scroll the focused pane. The panes scroll independently.

### Chatting with each role
Both panes accept messages at any time, so you can talk to either role and watch progress side by side.

| You message… | When that role… | Behaviour |
|--------------|-----------------|-----------|
| The role that owns the current stage | is working on it | Your message is **queued** and delivered as soon as its current turn finishes (`Esc` interrupts the turn first if you need to). It becomes part of that stage, e.g. extra guidance during Implement. |
| The role that owns the current stage | is waiting for you | Your message is delivered immediately as the answer. |
| The role that is **not** in the current stage | is idle | **Side chat.** The role answers in its own pane using **read-only tools only**, even the Senior Dev. A side chat never edits code, never advances the workflow, and never opens a gate. Examples: asking the dev "how hard would task T3 be?" during Design, or asking the tech lead "why did you choose this approach?" during Implement. |

A side chat uses the same Claude session as that role, so whatever is discussed stays in the role's context for its later stages. If a side chat produces a decision that should change the plan (for example, the tech lead agrees to drop a task), the role says so. The change only takes effect through a gate, by rejecting with feedback or editing the artifact. That way the artifacts stay the single source of truth.

### 5.2 Resume a role's chat as Claude
`/claude [techlead|dev]` (default: the focused pane's role) suspends the split view and runs the real interactive `claude --resume <that role's session id>` with the role's model and system prompt, in the project directory. You continue the same conversation with full Claude Code features; exit it (`/exit`) and the panes come back.

- Needs an existing conversation (the role must have run at least one turn) and an idle role. If it is busy: wait, or `Esc` to interrupt it first.
- While Claude Code is open, nothing else runs on that role's session, so messages and stages for that role wait until you return.
- The role's hard limits stay: the Tech Lead cannot edit files, and neither role can run git write commands. Everything else is under your control through Claude Code's normal permission prompts.
- What you said there is not mirrored into the pane (a marker says so), and its cost isn't counted in the header. The role does remember it, because it is the same session.
- `cd-agents claude [techlead|dev] [run-id]` does the same without opening the TUI, for the latest (or a given) saved run.

### 5.3 Compact
`/compact [techlead|dev|all] [what to keep]` runs Claude Code's `/compact` on the role's session (default: the focused pane's role). The conversation continues in the same session with a summarised history; the pane shows `✔ Context compacted: 20.9k → 5.6k tokens`. It queues behind any turn in progress, never changes files, and doesn't affect the workflow. Optional text tells Claude what to preserve (`/compact keep the API decisions`). Claude Code also compacts automatically when a session gets full; that is shown in the pane too (`Context auto-compacted by Claude`). Compacting does not touch the pane transcript or the saved artifacts; use `/clear` to tidy the visible pane.

**Automatic compaction at the end of a requirement.** When a run completes (after the final review is approved), both roles' conversations are compacted so the next requirement starts light. The Tech Lead is told to keep the requirement, key design decisions and review findings; the Senior Dev to keep what was implemented, how it was tested and open concerns. This happens before the run counts as finished (panes show `compacting context…`, then the token savings), only for roles that actually had a conversation, and a failure is shown in the pane but never fails the run. Resuming an already finished run does not compact it again. Disable with `workflow.autoCompact: false`.

### 5.4 Context across requirements
Each requirement is its own run (own run folder, own `docs/<slug>/`), but related work usually needs earlier context. Three mechanisms carry it:

1. **`/new` continues the conversations.** Both roles keep their Claude sessions, which were compacted when the last requirement finished (§5.3), so the Tech Lead still remembers earlier requirements and decisions and the Senior Dev still remembers the code it wrote and why. The new run records the carried session ids, so resuming it later keeps them. `/new fresh` starts clean sessions instead (use it for unrelated work, or when a conversation has drifted).
2. **Earlier-work digest.** The Tech Lead's clarify prompt lists up to five earlier requirements of this project that produced documents (newest first, with date, first line of the requirement, whether it finished, and its docs folder) and says: if the new requirement builds on or touches one of them, read its documents before asking questions or designing; otherwise ignore the list. This works with or without carried sessions, so work older than what a compaction kept is still reachable. Runs that never produced `requirements.md` are not listed.
3. **The documents and the code themselves.** `docs/<slug>/…` is committed to the project, and the Senior Dev works in the real repository, so anything written down stays available to both roles.

At startup, **Start a new chat** begins with fresh conversations (there are none to carry yet) plus the digest. To carry a previous conversation into a new requirement from a fresh launch, resume that session (§5.0) and then use `/new`.

Notes: because two runs can share a session, resuming an *older* run later continues the shared conversation (it may mention newer work). A long chain of requirements relies on compaction (`workflow.autoCompact`, on by default) to keep the shared sessions small.

### Interrupts and exit
- `Esc` stops the focused pane's agent turn. The other pane keeps running.
- `Ctrl+C` twice exits. The run is saved first so it can be resumed.

### Narrow terminals
If the terminal is narrower than `ui.splitMinColumns` (default 120), the layout falls back to a **single pane with tabs**: `[ Tech Lead ] [ Senior Dev ]`. `Tab` switches between them, and an unread marker (`•`) appears on the hidden tab when it gets new output. You can force a layout with `--layout split|tabs` or `ui.layout`.

### 5.1 Slash commands

| Command | Action |
|---------|--------|
| `/help` | List commands |
| `/focus techlead\|dev` | Move focus to a pane (same as `Tab`) |
| `/clear [techlead\|dev]` | Clear a pane's visible transcript. The log on disk and the role's session are kept. |
| `/config` | Open the interactive config menu (same as `cd-agents config`) |
| `/model techlead <model> [--effort <level>] [--save]` · `/model dev …` | Change a role's model (and optionally its effort) for this session; `--save` also stores it as the user default |
| `/effort techlead <level> [--save]` · `/effort dev <level>` | Change a role's effort: `low`, `medium`, `high`, `xhigh`, `max`, or `default` (Claude's own default). Takes effect on the role's next turn. Without arguments, shows both. |
| `/status` | Show run id, stage, models, and artifact paths |
| `/approve` | Approve the current gate (same as answering `y`) |
| `/reject <feedback>` | Reject the current gate and send feedback to the role that produced it |
| `/auto on\|off` | Toggle auto-approve for the rest of the session |
| `/artifacts` | List the files produced by this run |
| `/wontfix 1,3` | Mark review findings as "won't fix" before the Fix stage |
| `/abort` | Stop the current run (saved, resumable) |
| `/new [fresh]` | Start a new requirement. By default both roles **keep their conversations** (§5.4); `fresh` starts clean ones. Refused while a run is active. |
| `/resume [run-id]` | Resume a saved run |
| `/claude [techlead\|dev]` | Continue that role's chat in the real, interactive Claude Code, then return to the panes (§5.2) |
| `/compact [techlead\|dev\|all] [what to keep]` | Compact a role's conversation context (§5.3) |
| `/exit` | Quit |

## 6. Configuration

### 6.1 Files and precedence (highest wins)
1. CLI flags
2. Project config: `<project>/.cd-agents/config.json`
3. User config: `~/.cd-agents/config.json`
4. Built-in defaults

### 6.2 Schema

```json
{
  "roles": {
    "techlead": {
      "model": "opus",
      "effort": null,
      "systemPromptFile": null,
      "allowedTools": ["Read", "Grep", "Glob", "WebSearch", "WebFetch",
        "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git show:*)"],
      "permissionMode": "dontAsk"
    },
    "dev": {
      "model": "sonnet",
      "effort": null,
      "systemPromptFile": null,
      "allowedTools": ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
      "permissionMode": "acceptEdits"
    }
  },
  "workflow": {
    "autoApprove": false,
    "maxFixIterations": 3,
    "maxReviewIterations": 2,
    "autoCompact": true
  },
  "testCommand": null,
  "docsDir": "docs",
  "ui": {
    "layout": "auto",
    "splitMinColumns": 120,
    "autoFocus": true
  }
}
```

- `model` accepts any value that `claude --model` accepts (aliases such as `opus` and `sonnet`, or full model IDs).
- `effort` is Claude Code's `--effort` level for that role: `low`, `medium`, `high`, `xhigh` or `max`. `null` (the default) passes no flag, so Claude uses its default for the model. Higher effort means deeper reasoning, slower turns and more cost; a typical split is a high effort for the Tech Lead's design/review and a lower one for routine implementation. It applies to every turn of the role, including side chats, compaction and `/claude`.
- `systemPromptFile: null` means use the default prompt (see §7).
- `testCommand` (e.g. `npm test`): if `null`, the Senior Dev detects it from the project.
- `docsDir`: project-relative folder for the Tech Lead's documents (§10). Must stay inside the project.
- `maxFixIterations`: how many times the Senior Dev may try to fix failing tests in the Test stage before stopping.
- `autoCompact`: when a requirement finishes, compact both roles' conversations (§5.3). Set to `false` to keep full histories.
- `maxReviewIterations`: how many review → fix rounds may run before stopping to ask the user (see §8.1).
- The Tech Lead's `allowedTools` must stay read-only (no `Edit`, `Write`, or code-changing `Bash`) so it cannot modify code in any stage, Review included. The CLI warns if the config breaks this. The Tech Lead may run read-only git commands such as `git diff` and `git status`.

### 6.3 `cd-agents config` command

```
cd-agents config                         Interactive menu (pick role → pick model, etc.)
cd-agents config show                    Print the effective merged config and where each value comes from
cd-agents config set <key> <value>       e.g. config set roles.techlead.model opus
cd-agents config get <key>
cd-agents config reset                   Restore defaults (asks for confirmation)
cd-agents config --project ...           Write to the project config instead of the user config
```

The interactive menu lists the available models (`opus`, `sonnet`, `haiku`, plus "custom ID…") and the effort levels (`low` … `max`, or `default`) for each role.

## 7. Roles and system prompts

Each role's system prompt is passed to `claude` with `--append-system-prompt`, so Claude Code's base behaviour and the project's `CLAUDE.md` still apply. Prompts are Markdown files resolved in this order:

1. `roles.<role>.systemPromptFile` from config
2. `<project>/.cd-agents/prompts/<role>.md`
3. `~/.cd-agents/prompts/<role>.md`
4. Built-in default (`prompts/<role>.md` in the package)

### 7.1 Tech Lead — default prompt outline
- **Identity:** a pragmatic tech lead who owns the requirements and the design, and does **not** write production code.
- **Clarify:** restate the requirement in business terms, and list assumptions, open questions, acceptance criteria, and what is out of scope. Ask only questions whose answers would change the design, grouped and numbered.
- **Explore:** read the relevant code to understand existing architecture, conventions, and constraints before designing.
- **Design:** produce `design.md` with an overview, the components and files affected, data and API changes, edge cases, risks, a test strategy, and an ordered task list. Each task gets an id, a description, the files it touches, and a "done when" criterion.
- **Review:** review **only the Senior Dev's changes** against `requirements.md` and `design.md`, not the whole source. The CLI collects the changes and hands them over (§8.5); other files are opened only when needed to judge a specific change. Check correctness, whether acceptance criteria are met, edge cases, test coverage, security, and consistency with codebase conventions. **Never change code.** Write `review.md` with a verdict (`APPROVED` or `CHANGES_REQUESTED`) and numbered findings. Each finding has a severity (`blocker` / `major` / `minor` / `nit`), a file and line, the problem, and the expected fix.
- **Output contract:** deliver each document wrapped in `<artifact name="…">` tags so the CLI can extract and save it.
- **With auto-approve on:** don't wait for answers. Make reasonable assumptions and record them under "Assumptions" in `requirements.md`.

### 7.2 Senior Dev — default prompt outline
- **Identity:** a senior engineer who implements an approved design faithfully.
- **Scope discipline:** follow `design.md` and the task list. Don't add unrequested features. If the design is wrong or blocked, stop and report it instead of silently deviating.
- **Code quality:** match the existing style and conventions, make small focused changes, add no dead code.
- **Testing:** write or update tests for every task, run the test command, and fix failures (up to `maxFixIterations`).
- **Review fixes:** in the Fix stage, address every `blocker` and `major` finding in `review.md`. Address `minor` and `nit` findings unless there's a stated reason not to. Re-run tests afterwards, and say in the final message how each finding was handled.
- **No git writes:** never run `git commit`, `branch`, `checkout`, `stash`, `push`, or `reset`. The user commits manually.
- **No report files:** never create `implementation.md`, `test-report.md`, `fixes.md` or similar. The final chat message of each stage is the report: files changed, tests, results, deviations and concerns. The Test stage's message must start with `RESULT: PASS` or `RESULT: FAIL`.

## 8. Workflow

### 8.1 Stages

```
 [You] requirement
      │
      ▼
 ① CLARIFY   (Tech Lead)  ⇄ Q&A with you         → requirements.md   ── gate ──┐
      ▼                                                                         │
 ② DESIGN    (Tech Lead)  explores code, designs  → design.md          ── gate ──┤ reject → back to
      ▼                                                                         │ the same stage
 ③ IMPLEMENT (Senior Dev) codes task by task      → (chat summary)    ── gate ──┤ with your feedback
      ▼                                                                         │
 ④ TEST      (Senior Dev) writes/runs tests, fixes → (RESULT: PASS|FAIL) ── gate ──┤
      ▼                                                                         │
 ⑤ REVIEW    (Tech Lead)  reviews the CHANGES only → review.md      ── gate ──┘
      │
      ├─ APPROVED ──────────────────────────────────────────────▶ DONE
      │
      └─ CHANGES_REQUESTED
             ▼
 ⑥ FIX       (Senior Dev) fixes findings, re-tests → (chat summary) ── gate ── back to ⑤
             (at most maxReviewIterations rounds, then you decide: accept as-is / keep going / abort)

   DONE  → summary of changes, tests, review verdict, and artifact paths.
           Changes stay uncommitted in the working tree for you to review and commit.
```

| # | Stage | Role | Input | Output artifact |
|---|-------|------|-------|-----------------|
| 1 | Clarify | Tech Lead | Your requirement and answers | `requirements.md` (problem, acceptance criteria, assumptions, out of scope) |
| 2 | Design | Tech Lead | `requirements.md` and the codebase | `design.md` (solution and task list) |
| 3 | Implement | Senior Dev | `design.md` | Code changes; final chat message (files per task, deviations) |
| 4 | Test | Senior Dev | `design.md` test strategy and the code changes | Tests; final chat message starting `RESULT: PASS\|FAIL` (commands, results, fixes) |
| 5 | Review | Tech Lead (read-only) | requirements, design, the Senior Dev's notes, and **the changes only** (§8.5) | `review.md` (verdict and findings) |
| 6 | Fix | Senior Dev | `review.md` | Code changes; final chat message (how each finding was handled, test result) |

On later rounds, the review is versioned as `review-2.md` and so on. Senior Dev stages produce **no files**: the gate for them offers approve / reject / abort only (nothing to edit or view; the message is already in the pane), and the message is kept in `state.json` under `notes` for later stages.

At the Review gate you can also mark individual findings as "won't fix" before the Fix stage starts. The Senior Dev then skips them.

### 8.2 Approval gates (default behaviour)
At the end of every stage the CLI pauses and shows:

```
── Stage ② DESIGN complete ── artifact: .cd-agents/runs/<id>/design.md
[a] Approve & continue   [r] Reject with feedback   [e] Edit artifact   [v] View full   [q] Abort
```

- **Approve:** move to the next stage.
- **Reject:** prompt for feedback, then re-run the **same** stage with the same role, passing the feedback and the previous artifact.
- **Edit:** open the artifact in `$EDITOR`. The edited version becomes the input to the next stage.
- **Abort:** stop and save the run so it can be resumed later. Code changes already made stay in place.

The gate is shown in the full-width action bar at the bottom (§5) and can be answered whichever pane has focus.

During Clarify, the Q&A itself is conversational: you reply in the Tech Lead pane. The gate appears once the Tech Lead produces `requirements.md`.

A stage can also be gated *inside* itself (for example, the Senior Dev pausing before each task). This is optional and off by default (v2 candidate).

### 8.3 `--auto-approve`
- All gates are approved automatically, and the CLI logs `✔ auto-approved` for each.
- The Tech Lead is told not to wait for answers; it records its assumptions instead (§7.1).
- The run still stops and asks you when:
  - an agent explicitly reports that it is blocked, or
  - tests still fail after `maxFixIterations`, or
  - the review is still `CHANGES_REQUESTED` after `maxReviewIterations` rounds.
- Auto-approve does **not** change Claude Code's own tool permissions. These are still controlled by `allowedTools` / `permissionMode` in the config.

### 8.4 Hand-off between roles
The roles share no conversation history. They hand off **only through the Tech Lead's documents, the Senior Dev's final message, and the code itself**, which keeps each role's context focused and makes every hand-off reviewable. Within one role, consecutive stages and rejection loops reuse the same Claude session (`--resume <session-id>`) so the role keeps its own context.

### 8.5 What the Tech Lead reviews
To keep reviews focused and cheap, the Tech Lead gets a `<changes>` block built by the CLI instead of exploring the source itself:

- The diff of tracked files against `HEAD` (or against the empty tree in a repo with no commits), plus the content of new untracked files. Binary files are skipped; each new file is capped at 30 KB and the whole block at 150 KB (the Tech Lead is told to fetch the rest with `git diff -- <file>`).
- The run's own folders (`.cd-agents/` and the run's docs folder) are excluded.
- Only read-only git commands are used. Changes that were already uncommitted before the run started also show up, so start from a clean tree for the cleanest review.
- Not a git repository: the block says so, and the Tech Lead reviews only the files the Senior Dev's message lists as changed.
- The prompt says: review only these changes, don't audit the rest of the source, open another file only to judge a specific change.

## 9. Integration with Claude Code

Each agent turn spawns:

```
claude -p --output-format stream-json --verbose --include-partial-messages \
  --model <role.model> [--effort <role.effort>] \
  --append-system-prompt "<role system prompt>" \
  --permission-mode <role.permissionMode> \
  --allowedTools "<comma-joined list>" --disallowedTools "<comma-joined list>" \
  (--session-id <uuid> | --resume <uuid>)
```

The prompt (stage instructions, artifact contents, user feedback) is written to **stdin**, which avoids argv size limits. The first turn of a role creates its session with `--session-id`; every later turn uses `--resume`.

**Tool policy is enforced by flags, not just by prompts:**

| Turn | Allowed | Always denied |
|------|---------|---------------|
| Tech Lead stage | the configured read-only list (any `Edit`, `Write`, `NotebookEdit` or bare `Bash` in config is ignored) | file writes, all git write commands |
| Senior Dev stage | the configured list | all git write commands (`commit`, `add`, `push`, `branch`, `checkout`, `switch`, `stash`, `reset`, `merge`, `rebase`, `tag`, `cherry-pick`, `clean`, `restore`, `pull`, `fetch`) |
| Side chat (either role) | `Read`, `Grep`, `Glob`, read-only git | file writes, git writes; permission mode `dontAsk`, so anything not listed is refused |

- The JSON stream is parsed to render text, tool-call summaries, cost and token usage, and the session id in the TUI.
- The working directory is the project directory, so `CLAUDE.md`, `.claude/settings.json`, and MCP config all apply.
- If `claude` exits with a non-zero code, the error appears in the transcript and you're offered **retry** or **abort**.

## 10. Run state and artifacts

```
<project>/docs/<slug>/        Tech Lead documents — the project's own, meant to be committed
  requirements.md
  design.md
  review.md, review-2.md…     Tech Lead review(s)

<project>/.cd-agents/
  config.json                 (optional project config)
  prompts/                    (optional prompt overrides)
  runs/<run-id>/              run bookkeeping (gitignored)
    state.json                stage, status, models, role session ids, docs folder, timestamps, cost
    requirement.txt           your original input
    (no Senior Dev report files; their messages live in state.json → notes)
    techlead.jsonl            Tech Lead pane transcript (stage turns and side chats)
    dev.jsonl                 Senior Dev pane transcript (stage turns and side chats)
    events.jsonl              stage transitions and gate decisions
```

- `run-id` format: `YYYYMMDD-HHMMSS-<slug>`.
- The Tech Lead's documents go to `<docsDir>/<slug>/` (default `docs/<slug>/`), where `<slug>` is a short technical name (e.g. `otp-login-flow`, `sales-report-csv-export`), never the user's sentence. The Tech Lead chooses it: when it delivers `requirements.md` it puts a `folder="…"` attribute on the artifact tag (`<artifact name="requirements.md" folder="otp-login-flow">`). The CLI sanitises it to lowercase kebab-case (max 40 characters, no path separators) and creates the folder when the first document is saved; once any document exists the name is final, so a rejected-and-revised clarify does not move it. If the Tech Lead gives no folder, the name is the requirement without filler words (at most five words). If that folder already exists (an earlier run, or a hand-written one), `-2`, `-3`, … is appended, so earlier documents are never overwritten. Gates, edits (`[e]`) and later stages all read these files. The folder is recorded in `state.json`, so `resume` finds it even if config changes.
- `state.json` is written after every stage and gate decision, so `cd-agents resume` continues from the last completed gate.
- On first run in a project, the CLI suggests adding `.cd-agents/runs/` to `.gitignore`.

## 11. Technical stack

- **Language:** TypeScript on Node.js ≥ 22 (Ink 8 requires it; Node 18 and 20 are end-of-life).
- **TUI:** Ink (React for CLIs), for a chat experience close to Claude Code's.
- **CLI parsing:** commander.
- **Process management:** `child_process.spawn` with line-delimited JSON parsing.
- **Tests:** vitest. The `claude` binary is mocked with a fake script that emits recorded stream-json.

## 12. Acceptance criteria (v1)

1. When `claude` is not on `PATH`, both `install.sh` and `npm install -g cd-agents` print the "not installed" message, exit non-zero, and change nothing.
2. After installation, running `cd-agents` in any directory opens the chat UI. On a terminal at least 120 columns wide, it shows the Tech Lead pane on the left and the Senior Dev pane on the right. On narrower terminals it uses tabs.
   - Each pane has its own input box and transcript, and `Tab` moves focus between them. Both panes stream output at the same time without mixing content.
   - Messaging the role that isn't in the current stage gets an answer in its pane without any file changes and without advancing the workflow.
3. `cd-agents config set roles.techlead.model opus` and `/model dev sonnet` both change the model used by the next agent turn, and `config show` reflects the change.
4. Submitting a requirement runs Clarify → Design → Implement → Test → Review in order. The Tech Lead handles ①, ② and ⑤, and the Senior Dev handles ③, ④ and ⑥, each using its configured model and system prompt.
5. During Review, the Tech Lead makes no file changes. The working tree is identical before and after stage ⑤.
6. A `CHANGES_REQUESTED` review sends the run to Fix (Senior Dev) and then back to Review, up to `maxReviewIterations` rounds.
7. Without `--auto-approve`, nothing moves to the next stage until you approve. Rejecting re-runs the same stage with your feedback.
8. With `--auto-approve`, a run completes without prompts except in the blocking cases listed in §8.3.
9. No git commits, branches, or other git write operations are made at any point. All changes are left uncommitted.
10. All artifacts are saved under `.cd-agents/runs/<id>/`, and an aborted run can be resumed.

## 13. Decisions

| Topic | Decision |
|-------|----------|
| Final code review | **Yes.** A Tech Lead Review stage (⑤) runs after Test. The Tech Lead is read-only and never changes code. The Senior Dev applies fixes in the Fix stage (⑥). |
| Git commits | **No automatic commits.** Neither role writes to git. The user commits manually. |
| Distribution | **Both** an npm package (`npm i -g cd-agents`) and `install.sh`, which wraps the npm install. |
| Tech Lead documents | Saved under the project's `docs/<slug>/` (configurable via `docsDir`), not hidden in `.cd-agents/`. The Senior Dev writes no report files: its final message is the report (kept in run state). |
| Review scope | The Tech Lead reviews **only the changes** (diff + new files, supplied by the CLI), not the full source. |
| Chat layout | **Two side-by-side panes**: Tech Lead on the left, Senior Dev on the right. Each has its own input. Gates sit in a shared bottom bar. Narrow terminals fall back to tabs. |

## 14. Open questions

- None at this time.

## 15. Implementation notes (where v0.3 refines this spec)

- **Artifacts travel in the reply.** Both roles wrap documents in `<artifact name="…">…</artifact>`; the CLI extracts and saves them. This is what lets the Tech Lead stay truly read-only (it never needs a write tool). In the panes an artifact is collapsed to `📄 design.md (42 lines)`; use `[v]` at the gate to read it.
- **Marker conventions the engine parses:** `TASK_START: T1` / `TASK_DONE: T1` (Senior Dev, drives the `2/5 tasks` progress), `RESULT: PASS|FAIL` (first line of the Senior Dev's Test message), `VERDICT: APPROVED|CHANGES_REQUESTED` (first line of `review.md`), and `BLOCKED: <reason>` (instead of an artifact). Task ids come from `### T1 — title` headings in `design.md`.
- **Extra safety stops (even with `--auto-approve`):** a review with no verdict, and a `claude` process failure (offers retry / abort).
- **Auto-approve nudges:** if a role forgets the artifact, the CLI asks for it up to twice before handing the floor back to you.
- **Side chat before a run** (typing to the Senior Dev, or anything after a run completes) never starts a workflow. Only the first message to the Tech Lead does.
- **Resume** restores both panes from `techlead.jsonl` / `dev.jsonl`, reuses both Claude sessions, and re-opens the gate if the run stopped at one; otherwise it re-runs the interrupted stage.
- **Testing without tokens:** `CD_AGENTS_CLAUDE_BIN` points the CLI at another binary; the test suite uses a fake `claude` that emits real stream-json.
