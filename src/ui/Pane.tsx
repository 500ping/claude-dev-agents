import { Box, Text } from 'ink';
import type { Entry, Role, Status } from '../types.js';
import { ROLE_LABEL } from '../types.js';
import type { InputState } from './input.js';
import { transcriptLines, visibleSlice } from './lines.js';

const STATUS_COLOR: Record<Status, string> = {
  idle: 'gray', thinking: 'yellow', working: 'cyan', waiting: 'magenta', blocked: 'red', done: 'green',
};
const STATUS_TEXT: Record<Status, string> = {
  idle: 'idle', thinking: 'thinking…', working: 'working…', waiting: 'waiting for you', blocked: 'blocked', done: 'done',
};

export const INPUT_MAX_LINES = 4;

export function inputHeight(text: string): number {
  return Math.min(INPUT_MAX_LINES, Math.max(1, text.split('\n').length)) + 2;
}

interface Props {
  role: Role;
  model: string;
  status: Status;
  entries: Entry[];
  input: InputState;
  width: number;
  height: number;
  focused: boolean;
  scroll: number;
  verbose: boolean;
  placeholder: string;
}

function InputView({ input, focused, placeholder, width }: { input: InputState; focused: boolean; placeholder: string; width: number }) {
  const lines = input.text.split('\n');
  const visible = lines.slice(-INPUT_MAX_LINES);
  // locate the cursor within the visible window
  const before = input.text.slice(0, input.cursor).split('\n');
  const cursorLine = before.length - 1 - (lines.length - visible.length);
  const cursorCol = before[before.length - 1]!.length;

  if (!input.text) {
    return (
      <Text wrap="truncate-end">
        <Text color="cyan">{'> '}</Text>
        {focused ? <Text inverse>{' '}</Text> : null}
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      {visible.map((l, i) => {
        // keep the cursor on screen for long lines
        const max = Math.max(4, width - 2);
        const start = i === cursorLine && cursorCol >= max ? cursorCol - max + 1 : 0;
        const shown = l.slice(start, start + max);
        const c = cursorCol - start;
        return (
          <Text key={i} wrap="truncate-end">
            <Text color="cyan">{i === 0 && visible.length === lines.length ? '> ' : '  '}</Text>
            {focused && i === cursorLine ? (
              <>
                {shown.slice(0, c)}
                <Text inverse>{shown[c] ?? ' '}</Text>
                {shown.slice(c + 1)}
              </>
            ) : shown}
          </Text>
        );
      })}
    </Box>
  );
}

export function Pane(p: Props) {
  const inner = Math.max(10, p.width - 4);
  const ih = inputHeight(p.input.text);
  const th = Math.max(1, p.height - 2 - 1 - ih);
  const lines = transcriptLines(p.entries, inner, p.verbose);
  const { slice, offset } = visibleSlice(lines, th, p.scroll);
  const pad = th - slice.length;

  return (
    <Box
      flexDirection="column"
      width={p.width}
      height={p.height}
      borderStyle="round"
      borderColor={p.focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <Box justifyContent="space-between" height={1}>
        <Text bold color={p.focused ? 'cyan' : undefined} wrap="truncate-end">
          ● {ROLE_LABEL[p.role]} · {p.model}
        </Text>
        <Text color={STATUS_COLOR[p.status]}>{offset > 0 ? `↑${offset} · ` : ''}{STATUS_TEXT[p.status]}</Text>
      </Box>
      <Box flexDirection="column" height={th}>
        {Array.from({ length: Math.max(0, pad) }, (_, i) => <Text key={`p${i}`}> </Text>)}
        {slice.map((l, i) => (
          <Text key={i} color={l.color} dimColor={l.dim} bold={l.bold} wrap="truncate-end">{l.text || ' '}</Text>
        ))}
      </Box>
      <Box
        borderStyle="round"
        borderColor={p.focused ? 'cyan' : 'gray'}
        paddingX={1}
        height={ih}
        flexDirection="column"
      >
        <InputView input={p.input} focused={p.focused} placeholder={p.placeholder} width={inner - 4} />
      </Box>
    </Box>
  );
}
