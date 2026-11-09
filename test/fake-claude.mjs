#!/usr/bin/env node
// Fake `claude` for tests: speaks stream-json, replies based on the <stage> tag in the prompt.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.0-fake'); process.exit(0); }

const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

// Interactive launch (no -p): what `/claude` and `cd-agents claude` start.
if (!args.includes('-p')) {
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ interactive: true, args, cwd: process.cwd(), stage: 'interactive' }) + '\n');
  }
  console.log(`FAKE-INTERACTIVE resume=${arg('--resume')} model=${arg('--model')}`);
  if (process.env.FAKE_INTERACTIVE_WAIT) await new Promise((r) => process.stdin.once('data', r));
  process.exit(0);
}

let prompt = '';
for await (const c of process.stdin) prompt += c;

const log = process.env.FAKE_CLAUDE_LOG;
const isCompact = prompt.trim().startsWith('/compact');
const stage = isCompact ? 'compact' : prompt.match(/<stage>(\w+)<\/stage>/)?.[1];
const side = prompt.includes('<mode>side-chat</mode>');
const sessionId = arg('--session-id') ?? arg('--resume');
const rec = { model: arg('--model'), effort: arg('--effort'), resume: args.includes('--resume'), sessionId, stage: side ? 'side' : stage,
  allowed: arg('--allowedTools'), disallowed: arg('--disallowedTools'), permissionMode: arg('--permission-mode'),
  system: (arg('--append-system-prompt') ?? '').slice(0, 40), prompt, cwd: process.cwd() };
if (log) appendFileSync(log, JSON.stringify(rec) + '\n');
const priorCalls = (st) => log && existsSync(log)
  ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.stage === st).length - 1 : 0;

await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY || 0)));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const art = (name, body) => `<artifact name="${name}"${name === 'requirements.md' && process.env.FAKE_FOLDER ? ` folder="${process.env.FAKE_FOLDER}"` : ''}>\n${body}\n</artifact>`;

if (process.env.FAKE_FAIL_STAGE === stage && !existsSync(join(process.cwd(), '.failed-once'))) {
  writeFileSync(join(process.cwd(), '.failed-once'), '1');
  console.error('boom: simulated failure');
  process.exit(2);
}

if (isCompact) {
  const o = (x) => process.stdout.write(JSON.stringify(x) + '\n');
  o({ type: 'system', subtype: 'init', session_id: sessionId });
  o({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 20948, post_tokens: 5606 } });
  o({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sessionId, total_cost_usd: 0.002 });
  process.exit(0);
}


let tool = null;
let text;
const verdicts = (process.env.FAKE_VERDICTS || 'APPROVED').split(',');
if (side) text = `side answer from ${arg('--model')}`;
else switch (stage) {
  case 'clarify':
    if (process.env.FAKE_ASK === '1' && priorCalls('clarify') === 0) text = '1. SMS or app?';
    else text = 'Clear.\n' + art('requirements.md', '# Requirements\nDo the thing.');
    break;
  case 'design':
    text = 'Designed.\n' + art('design.md', '# Design\n\n### T1 — first task\nx\n\n### T2 — second task\ny');
    break;
  case 'implement':
    tool = { name: 'Write', input: { file_path: 'impl.txt' } };
    writeFileSync(join(process.cwd(), 'impl.txt'), 'implemented\n');
    text = 'TASK_START: T1\nTASK_DONE: T1\nTASK_START: T2\nTASK_DONE: T2\nImplemented T1 and T2 in impl.txt.';
    break;
  case 'test':
{
    const mode = process.env.FAKE_TEST_RESULT || 'PASS';
    // NONE: never reports a RESULT line; LATE: only after being nudged for it
    const withResult = mode === 'NONE' ? false : mode === 'LATE' ? priorCalls('test') > 0 : true;
    text = (withResult ? `RESULT: ${mode === 'FAIL' ? 'FAIL' : 'PASS'}\n` : '') + 'ran tests';
    break;
  }
  case 'review': {
    const v = verdicts[Math.min(priorCalls('review'), verdicts.length - 1)];
    text = art('review.md', `VERDICT: ${v}\n1. [major] src/a.ts:1 fix it`);
    break;
  }
  case 'fix':
    text = 'Fixed finding 1.';
    break;
  default: text = 'ok';
}

out({ type: 'system', subtype: 'init', session_id: sessionId });
if (tool) out({ type: 'assistant', message: { id: 'm0', content: [{ type: 'tool_use', name: tool.name, input: tool.input }] } });
out({ type: 'stream_event', event: { type: 'message_start' } });
for (let i = 0; i < text.length; i += 12) {
  out({ type: 'stream_event', api_message_id: 'm1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + 12) } } });
}
out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text }] } });
out({ type: 'stream_event', event: { type: 'message_stop' } });
out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.01 });
