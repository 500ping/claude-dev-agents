import { Box, Text } from 'ink';
import type { Gate } from '../engine.js';
import type { Task } from '../stages.js';
import type { InputState } from './input.js';

export function taskSummary(tasks: Task[], active: string | undefined, width: number): string {
  if (!tasks.length) return '';
  const parts = tasks.map((t) => `${t.id} ${t.done ? '✔' : t.id === active ? '●' : '○'}`);
  let out = 'Tasks: ';
  for (let i = 0; i < parts.length; i++) {
    const next = out + parts[i] + ' ';
    if (next.length > width - 8 && i < parts.length - 1) return out + `+${parts.length - i} more`;
    out = next;
  }
  return out.trimEnd();
}

export function actionBarLines(gate: Gate | undefined, feedback: boolean): number {
  if (!gate) return 1;
  return 2 + (gate.warning ? 1 : 0) + (feedback ? 1 : 0);
}

interface Props {
  gate?: Gate;
  gateFocused: boolean;
  feedbackMode: boolean;
  feedback: InputState;
  hints: string;
  tasks: Task[];
  activeTask?: string;
  width: number;
  notice?: string;
}

export function ActionBar(p: Props) {
  const tasks = taskSummary(p.tasks, p.activeTask, Math.floor(p.width / 2));
  if (!p.gate) {
    return (
      <Box borderStyle="single" borderColor="gray" borderBottom={false} borderLeft={false} borderRight={false} justifyContent="space-between" width={p.width} height={2}>
        <Text dimColor wrap="truncate-end">{p.notice ?? p.hints}</Text>
        <Text dimColor wrap="truncate-end">{tasks}</Text>
      </Box>
    );
  }
  const g = p.gate;
  const color = 'yellow'; // always visible; the keys below only act while this bar has focus
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={color} borderBottom={false} borderLeft={false} borderRight={false} width={p.width} height={actionBarLines(g, p.feedbackMode) + 1}>
      <Box justifyContent="space-between">
        <Text bold color={color} wrap="truncate-end">── {g.title}{g.artifact ? ` ── ${g.artifact.split('/').slice(-3).join('/')}` : ''}</Text>
        {p.notice ? <Text color="yellow" wrap="truncate-end">{p.notice}</Text> : <Text dimColor wrap="truncate-end">{tasks}</Text>}
      </Box>
      {g.warning ? <Text color="red" wrap="truncate-end">⚠ {g.warning}</Text> : null}
      <Text wrap="truncate-end">
        {p.gateFocused ? <Text bold color="yellow">▶ </Text> : null}
        {g.options.map((o, i) => (
          <Text key={o.key}>{i ? '   ' : ''}<Text bold color={p.gateFocused ? 'yellow' : undefined}>[{o.key}]</Text> {o.label}</Text>
        ))}
        {p.gateFocused ? <Text dimColor>   (or just start typing to message a role)</Text> : <Text dimColor>   (press Ctrl+G to answer)</Text>}
      </Text>
      {p.feedbackMode ? (
        <Text wrap="truncate-end">
          <Text color="yellow">feedback › </Text>
          {p.feedback.text.slice(0, p.feedback.cursor)}
          <Text inverse>{p.feedback.text[p.feedback.cursor] ?? ' '}</Text>
          {p.feedback.text.slice(p.feedback.cursor + 1)}
        </Text>
      ) : null}
    </Box>
  );
}
