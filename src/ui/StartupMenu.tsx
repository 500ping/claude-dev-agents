import { Box, Text } from 'ink';
import type { RunSummary } from '../engine.js';
import { STAGES } from '../stages.js';

/** Runs offered at startup (keys 1–9 resume them directly). */
export const MAX_LISTED = 9;

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
}

export function stageLabel(r: RunSummary): string {
  if (r.stage === 'done') return '✔ done';
  const def = (STAGES as Record<string, { n: string; title: string } | undefined>)[r.stage];
  const name = def ? `${def.n} ${def.title}` : r.stage;
  return r.aborted ? `⏸ stopped at ${name}` : `● ${name}`;
}

/** One menu line: time · state · requirement, cut to `width`. */
export function runLabel(r: RunSummary, width: number): string {
  const head = `${when(r.updatedAt)}  ${stageLabel(r)}  `;
  const req = (r.requirement.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  const room = Math.max(8, width - head.length);
  return head + (req.length > room ? req.slice(0, room - 1) + '…' : req);
}

interface Props {
  runs: RunSummary[];
  selected: number;
  cwd: string;
  width: number;
}

export function StartupMenu({ runs, selected, cwd, width }: Props) {
  const listed = runs.slice(0, MAX_LISTED);
  const inner = Math.max(30, Math.min(width - 6, 110));
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} width={width}>
      <Text bold color="cyan">cd-agents</Text>
      <Text dimColor wrap="truncate-end">{cwd}</Text>
      <Box marginTop={1}><Text bold>What would you like to do?</Text></Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold={selected === 0} color={selected === 0 ? 'cyan' : undefined}>
          {selected === 0 ? '▸ ' : '  '}Start a new chat
        </Text>
        <Text dimColor>    fresh conversations; the Tech Lead is still told about earlier requirements</Text>
        <Box marginTop={1}><Text dimColor>Or resume a saved session (then /new carries its conversation into the next requirement):</Text></Box>
        {listed.map((r, i) => (
          <Text key={r.id} bold={selected === i + 1} color={selected === i + 1 ? 'cyan' : undefined} wrap="truncate-end">
            {selected === i + 1 ? '▸ ' : '  '}{i + 1}  {runLabel(r, inner - 5)}
          </Text>
        ))}
        {runs.length > listed.length ? <Text dimColor>  … and {runs.length - listed.length} older (cd-agents resume &lt;run-id&gt;)</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ choose · Enter confirm · 1-{Math.min(MAX_LISTED, Math.max(1, listed.length))} resume that session · n / Esc new chat</Text>
      </Box>
    </Box>
  );
}
