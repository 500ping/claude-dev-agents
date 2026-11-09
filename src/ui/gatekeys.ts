import type { Key } from 'ink';
import type { GateOption } from '../engine.js';

/**
 * A gate key (`a`, `r`, …) only takes effect this long after it was pressed. If another key
 * arrives in that window the user is typing a message ("actually…"), not answering the gate.
 */
export const COMMIT_DELAY_MS = 350;

export type GateKey =
  | { kind: 'option'; opt: GateOption }
  /** Printable text that isn't a gate key: the user is typing a message. */
  | { kind: 'typing' }
  | { kind: 'ignore' };

export function classifyGateKey(input: string, key: Key, options: GateOption[]): GateKey {
  if (
    key.ctrl || key.meta || key.escape || key.tab || key.return || key.backspace || key.delete ||
    key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown ||
    key.home || key.end || !input
  ) return { kind: 'ignore' };
  if (input.length === 1) {
    const opt = options.find((o) => o.key === input.toLowerCase());
    if (opt) return { kind: 'option', opt };
  }
  return { kind: 'typing' };
}
