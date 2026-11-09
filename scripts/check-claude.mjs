#!/usr/bin/env node
// Runs as `preinstall`: abort the install when Claude Code is missing or Node is too old.
import { spawnSync } from 'node:child_process';

const bin = process.env.CD_AGENTS_CLAUDE_BIN || 'claude';
const res = spawnSync(bin, ['--version'], { stdio: 'ignore' });
const major = Number(process.versions.node.split('.')[0]);

if (res.error || res.status !== 0) {
  console.error(`
✖ Claude Code is not installed.
  cd-agents runs on top of Claude Code. Install it first:
  https://docs.claude.com/en/docs/claude-code/setup
  Then re-run this installer.
`);
  process.exit(1);
}
if (major < 22) {
  console.error(`
✖ Node.js ${process.versions.node} is too old. cd-agents needs Node.js 22 or newer.
`);
  process.exit(1);
}
