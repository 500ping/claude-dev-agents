import type { Entry } from '../types.js';

export interface Line {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

/** Word-wrap `text` to `width` columns, keeping existing newlines and hard-breaking long words. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.replace(/\t/g, '  ').split('\n')) {
    if (raw.length <= w) { out.push(raw); continue; }
    let line = '';
    for (const word of raw.split(/(\s+)/)) {
      if (!word) continue;
      if ((line + word).length <= w) { line += word; continue; }
      if (line.trim()) { out.push(line.trimEnd()); line = ''; }
      let rest = word.trimStart();
      while (rest.length > w) { out.push(rest.slice(0, w)); rest = rest.slice(w); }
      line = rest;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Artifacts are saved to disk and shown via the gate; keep the transcript readable. */
export function collapseArtifacts(text: string): string {
  const lines = (b: string) => b.trim().split('\n').length;
  return text
    .replace(/<artifact\s+name="([^"]+)"\s*>([\s\S]*?)<\/artifact>/g, (_m, n: string, b: string) => `📄 ${n} (${lines(b)} lines)`)
    .replace(/<artifact\s+name="([^"]+)"\s*>[\s\S]*$/, (_m, n: string) => `📄 ${n} (writing…)`);
}

export function entryLines(e: Entry, width: number, verbose: boolean): Line[] {
  switch (e.kind) {
    case 'user':
      return wrap(e.text, width - 2).map((t, i) => ({ text: (i === 0 ? '› ' : '  ') + t, color: 'cyan', bold: true }));
    case 'text': {
      const body = collapseArtifacts(e.text).replace(/\n+$/, '');
      let first = true;
      return wrap(body, width - 2).map((t) => {
        const l: Line = { text: (first ? '● ' : '  ') + t, bold: /^\s*#{1,4}\s/.test(t) || undefined };
        first = false;
        return l;
      });
    }
    case 'tool': {
      const lines: Line[] = [{ text: ('  ' + e.text).slice(0, width), dim: true }];
      if (verbose && e.detail) lines.push(...wrap(e.detail, width - 4).slice(0, 4).map((t) => ({ text: '    ' + t, dim: true })));
      return lines;
    }
    case 'marker': {
      const color = e.text.startsWith('──') ? 'yellow' : e.text.startsWith('✔') ? 'green' : undefined;
      return wrap(e.text, width).map((t) => ({ text: t, color, dim: color ? undefined : true, bold: e.text.startsWith('──') || undefined }));
    }
    case 'error':
      return wrap('✖ ' + e.text, width).map((t) => ({ text: t, color: 'red' }));
  }
}

export function transcriptLines(entries: Entry[], width: number, verbose: boolean): Line[] {
  const out: Line[] = [];
  entries.forEach((e, i) => {
    if (i > 0 && (e.kind === 'user' || e.kind === 'text') && entries[i - 1]!.kind !== 'marker') out.push({ text: '' });
    out.push(...entryLines(e, width, verbose));
  });
  return out;
}

/** The slice of `lines` visible at `offset` lines above the bottom. */
export function visibleSlice(lines: Line[], height: number, offset: number): { slice: Line[]; offset: number } {
  const maxOffset = Math.max(0, lines.length - height);
  const off = Math.min(Math.max(0, offset), maxOffset);
  const end = lines.length - off;
  return { slice: lines.slice(Math.max(0, end - height), end), offset: off };
}
