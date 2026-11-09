import type { Key } from 'ink';

export interface InputState { text: string; cursor: number }
export const emptyInput: InputState = { text: '', cursor: 0 };

export interface InputResult { state: InputState; submit?: string }

const wordStart = (t: string, c: number) => {
  let i = c;
  while (i > 0 && /\s/.test(t[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(t[i - 1]!)) i--;
  return i;
};

/** Pure line-editor reducer for one keypress. */
export function applyKey(s: InputState, input: string, key: Key): InputResult {
  const { text, cursor } = s;
  const set = (t: string, c: number): InputResult => ({ state: { text: t, cursor: c } });

  if (key.return) {
    // Alt+Enter, or a trailing backslash, inserts a newline instead of submitting.
    if (key.meta) return set(text.slice(0, cursor) + '\n' + text.slice(cursor), cursor + 1);
    if (text.endsWith('\\') && cursor === text.length) return set(text.slice(0, -1) + '\n', text.length);
    return { state: emptyInput, submit: text };
  }
  if (key.backspace || key.delete) {
    if (cursor === 0) return { state: s };
    return set(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
  }
  if (key.leftArrow) return set(text, Math.max(0, cursor - 1));
  if (key.rightArrow) return set(text, Math.min(text.length, cursor + 1));
  if (key.home || (key.ctrl && input === 'a')) {
    const ls = text.lastIndexOf('\n', cursor - 1) + 1;
    return set(text, ls);
  }
  if (key.end || (key.ctrl && input === 'e')) {
    const le = text.indexOf('\n', cursor);
    return set(text, le === -1 ? text.length : le);
  }
  if (key.ctrl && input === 'u') {
    const ls = text.lastIndexOf('\n', cursor - 1) + 1;
    return set(text.slice(0, ls) + text.slice(cursor), ls);
  }
  if (key.ctrl && input === 'k') {
    const le = text.indexOf('\n', cursor);
    return set(text.slice(0, cursor) + (le === -1 ? '' : text.slice(le)), cursor);
  }
  if (key.ctrl && input === 'w') {
    const ws = wordStart(text, cursor);
    return set(text.slice(0, ws) + text.slice(cursor), ws);
  }
  if (key.ctrl && input === 'j') return set(text.slice(0, cursor) + '\n' + text.slice(cursor), cursor + 1);
  if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
    return { state: s };
  }
  if (!input) return { state: s };
  const clean = input.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return set(text.slice(0, cursor) + clean + text.slice(cursor), cursor + clean.length);
}
