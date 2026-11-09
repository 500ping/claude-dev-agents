#!/usr/bin/env bash
# cd-agents installer.
#   curl -fsSL <repo-url>/install.sh | bash
# Env: CD_AGENTS_SOURCE  npm spec or tarball/dir to install (default: "cd-agents")
set -euo pipefail

PKG="${CD_AGENTS_SOURCE:-cd-agents}"
CLAUDE_BIN="${CD_AGENTS_CLAUDE_BIN:-claude}"
MIN_NODE=22

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# 1. Claude Code must exist — otherwise stop before changing anything.
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1 || ! "$CLAUDE_BIN" --version >/dev/null 2>&1; then
  red "✖ Claude Code is not installed."
  cat >&2 <<'MSG'
  cd-agents runs on top of Claude Code. Install it first:
  https://docs.claude.com/en/docs/claude-code/setup
  Then re-run this installer.
MSG
  exit 1
fi

# 2. Node.js >= 22 and npm.
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  red "✖ Node.js $MIN_NODE+ and npm are required. Install them from https://nodejs.org and re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
  red "✖ Node.js $(node -v) is too old. cd-agents needs Node.js $MIN_NODE or newer."
  exit 1
fi

# 3. Install. If the global prefix isn't writable, fall back to ~/.local (never sudo silently).
echo "Installing cd-agents…"
BIN_DIR=""
if out="$(npm install -g "$PKG" 2>&1)"; then
  :
elif grep -qE 'EACCES|EPERM' <<<"$out"; then
  echo "Global npm prefix is not writable; installing to \$HOME/.local instead."
  if ! out="$(npm install -g --prefix "$HOME/.local" "$PKG" 2>&1)"; then
    printf '%s\n' "$out" >&2
    red "✖ Installation failed."
    exit 1
  fi
  BIN_DIR="$HOME/.local/bin"
else
  printf '%s\n' "$out" >&2
  red "✖ Installation failed."
  exit 1
fi

# 4. Make sure ~/.cd-agents exists even if npm lifecycle scripts were disabled. Never overwrite.
CFG_DIR="${CD_AGENTS_HOME:-$HOME/.cd-agents}"
mkdir -p "$CFG_DIR/prompts"
if [ ! -f "$CFG_DIR/config.json" ]; then
  printf '{\n  "roles": {\n    "techlead": { "model": "opus" },\n    "dev": { "model": "sonnet" }\n  }\n}\n' > "$CFG_DIR/config.json"
fi

green '✔ Installed. Run "cd-agents" in any project directory.'
if [ -n "$BIN_DIR" ] && ! command -v cd-agents >/dev/null 2>&1; then
  echo "  Add this to your shell profile so the command is found:  export PATH=\"$BIN_DIR:\$PATH\""
fi
