import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { collectChanges } from '../src/changes.js';

let cwd: string;
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' });
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'cda-chg-')); });

describe('collectChanges', () => {
  it('not a git repo', () => {
    expect(collectChanges(cwd)).toEqual({ isGit: false, text: '', files: [], truncated: false });
  });

  it('tracked edits, new files, and exclusions', () => {
    git('init', '-q');
    writeFileSync(join(cwd, 'a.ts'), 'const a = 1;\n');
    git('add', '.'); git('commit', '-qm', 'init');
    writeFileSync(join(cwd, 'a.ts'), 'const a = 2;\n');
    writeFileSync(join(cwd, 'b.ts'), 'export const b = 1;\n');
    mkdirSync(join(cwd, 'docs', 'x'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'x', 'design.md'), 'DOC');
    mkdirSync(join(cwd, '.cd-agents', 'runs'), { recursive: true });
    writeFileSync(join(cwd, '.cd-agents', 'runs', 'state.json'), '{}');
    const c = collectChanges(cwd, ['.cd-agents', 'docs/x']);
    expect(c.isGit).toBe(true);
    expect(c.files.sort()).toEqual(['a.ts', 'b.ts']);
    expect(c.text).toContain('-const a = 1;');
    expect(c.text).toContain('+const a = 2;');
    expect(c.text).toContain('=== new file: b.ts ===');
    expect(c.text).not.toContain('DOC');
    expect(c.text).not.toContain('state.json');
    expect(collectChanges(cwd).files).toContain('docs/x/design.md'); // only excluded when asked
  });

  it('repo without any commit still shows staged/new files', () => {
    git('init', '-q');
    writeFileSync(join(cwd, 'new.ts'), 'x');
    expect(collectChanges(cwd).files).toEqual(['new.ts']);
    writeFileSync(join(cwd, 'staged.ts'), 'y');
    git('add', 'staged.ts');
    expect(collectChanges(cwd).files.sort()).toEqual(['new.ts', 'staged.ts']);
  });

  it('no changes', () => {
    git('init', '-q');
    writeFileSync(join(cwd, 'a'), '1');
    git('add', '.'); git('commit', '-qm', 'i');
    expect(collectChanges(cwd)).toMatchObject({ isGit: true, files: [], text: '' });
  });

  it('skips binary content and truncates huge output', () => {
    git('init', '-q');
    writeFileSync(join(cwd, 'a-image.bin'), Buffer.from([1, 2, 0, 3]));
    for (let i = 0; i < 12; i++) writeFileSync(join(cwd, `big${i}.txt`), 'x'.repeat(20_000));
    const c = collectChanges(cwd);
    expect(c.text).toContain('(binary file)');
    expect(c.truncated).toBe(true);
    expect(c.text.length).toBeLessThan(151_000);
    expect(c.text).toContain('truncated');
  });
});
