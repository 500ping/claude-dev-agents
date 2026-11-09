import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, configFile, loadConfig, resetConfig, setConfigValue, techleadWarnings } from '../src/config.js';

let cwd: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'cda-cfg-'));
  cwd = join(root, 'p');
  mkdirSync(cwd);
  process.env.CD_AGENTS_HOME = join(root, 'home');
});

describe('config', () => {
  it('defaults', () => {
    const { config, sources } = loadConfig(cwd);
    expect(config.roles.techlead.model).toBe('opus');
    expect(config.roles.dev.model).toBe('sonnet');
    expect(config.workflow.autoApprove).toBe(false);
    expect(config.workflow.autoCompact).toBe(true);
    expect(sources['roles.dev.model']).toBe('default');
  });

  it('precedence: flags > project > user > default, with sources', () => {
    setConfigValue('user', cwd, 'roles.techlead.model', 'haiku');
    setConfigValue('user', cwd, 'roles.dev.model', 'haiku');
    setConfigValue('project', cwd, 'roles.dev.model', 'opus');
    const { config, sources } = loadConfig(cwd, { roles: { dev: { model: 'fable' } } });
    expect(config.roles.techlead.model).toBe('haiku');
    expect(sources['roles.techlead.model']).toBe('user');
    expect(config.roles.dev.model).toBe('fable');
    expect(sources['roles.dev.model']).toBe('flag');
    const noFlag = loadConfig(cwd);
    expect(noFlag.config.roles.dev.model).toBe('opus');
    expect(noFlag.sources['roles.dev.model']).toBe('project');
  });

  it('set parses JSON values and preserves other keys', () => {
    setConfigValue('user', cwd, 'roles.techlead.model', 'opus');
    setConfigValue('user', cwd, 'workflow.maxFixIterations', '5');
    setConfigValue('user', cwd, 'workflow.autoApprove', 'true');
    setConfigValue('user', cwd, 'testCommand', '"npm test"');
    const file = JSON.parse(readFileSync(configFile('user', cwd), 'utf8'));
    expect(file).toEqual({
      roles: { techlead: { model: 'opus' } },
      workflow: { maxFixIterations: 5, autoApprove: true },
      testCommand: 'npm test',
    });
    expect(loadConfig(cwd).config.workflow.maxFixIterations).toBe(5);
  });

  it('rejects unknown keys and bad values', () => {
    expect(() => setConfigValue('user', cwd, 'roles.qa.model', 'x')).toThrow(/Unknown config key/);
    expect(() => setConfigValue('user', cwd, 'workflow.maxFixIterations', '"lots"')).toThrow(/must be a number/);
    expect(() => setConfigValue('user', cwd, 'workflow.maxFixIterations', '-1')).toThrow(/non-negative/);
    expect(() => setConfigValue('user', cwd, 'ui.layout', 'grid')).toThrow(/one of/);
    expect(() => setConfigValue('user', cwd, 'roles.dev.model', '""')).toThrow(/non-empty/);
    expect(() => setConfigValue('user', cwd, 'roles.dev.allowedTools', '"Read"')).toThrow(/array/);
  });

  it('effort defaults to null, accepts the Claude levels, rejects anything else', () => {
    expect(loadConfig(cwd).config.roles.dev.effort).toBeNull();
    setConfigValue('user', cwd, 'roles.techlead.effort', 'xhigh');
    expect(loadConfig(cwd).config.roles.techlead.effort).toBe('xhigh');
    expect(loadConfig(cwd).sources['roles.techlead.effort']).toBe('user');
    setConfigValue('user', cwd, 'roles.techlead.effort', 'null');
    expect(loadConfig(cwd).config.roles.techlead.effort).toBeNull();
    expect(() => setConfigValue('user', cwd, 'roles.dev.effort', 'extreme')).toThrow(/Effort must be one of/);
    expect(() => setConfigValue('user', cwd, 'roles.dev.effort', '3')).toThrow(/must be a string or null|Effort must be/);
  });

  it('docsDir defaults to docs and rejects paths outside the project', () => {
    expect(loadConfig(cwd).config.docsDir).toBe('docs');
    setConfigValue('user', cwd, 'docsDir', 'documentation');
    expect(loadConfig(cwd).config.docsDir).toBe('documentation');
    expect(() => setConfigValue('user', cwd, 'docsDir', '/etc')).toThrow(/inside the project/);
    expect(() => setConfigValue('user', cwd, 'docsDir', '../x')).toThrow(/inside the project/);
    expect(() => setConfigValue('user', cwd, 'docsDir', '""')).toThrow(/inside the project/);
  });

  it('reset removes the file', () => {
    setConfigValue('user', cwd, 'roles.dev.model', 'opus');
    resetConfig('user', cwd);
    expect(loadConfig(cwd).config.roles.dev.model).toBe('sonnet');
  });

  it('reports invalid JSON with the file path', () => {
    mkdirSync(join(cwd, '.cd-agents'));
    writeFileSync(configFile('project', cwd), '{ nope');
    expect(() => loadConfig(cwd)).toThrow(/Invalid JSON in .*config\.json/);
  });

  it('warns when the tech lead is given write tools', () => {
    expect(techleadWarnings(DEFAULT_CONFIG)).toEqual([]);
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.roles.techlead.allowedTools.push('Edit', 'Bash');
    expect(techleadWarnings(cfg)).toHaveLength(2);
  });
});
