import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KIMI_AZURE_PI_EXTENSION_FILENAME,
  ensureKimiAzurePiExtension,
  piAgentExtensionsDir,
  renderKimiAzurePiExtension,
} from '../src/contenders/pithosKimiAzureExtension.js';

describe('pithosKimiAzureExtension: piAgentExtensionsDir', () => {
  it('resolves to <home>/.pi/agent/extensions', () => {
    expect(piAgentExtensionsDir('/home/operator')).toBe(path.join('/home/operator', '.pi', 'agent', 'extensions'));
  });
});

describe('pithosKimiAzureExtension: renderKimiAzurePiExtension', () => {
  const content = renderKimiAzurePiExtension();

  it('registers the azure-openai-responses provider id, not a fresh kimi-azure id', () => {
    // Required so PITHOS's own CLI-side provider-auth allowlist (_PROVIDER_AUTH_ENV in
    // pithos/cli.py) accepts the run without --pi-config-dir (which would break global
    // extension discovery); see module docstring for the full chain of evidence.
    expect(content).toContain("pi.registerProvider('azure-openai-responses'");
    expect(content).not.toMatch(/registerProvider\(\s*['"]kimi-azure['"]/);
  });

  it('switches only the kimi model to the openai-completions transport', () => {
    expect(content).toContain("api: 'openai-completions'");
    expect(content).toContain("id: KIMI_AZURE_MODEL_ID");
  });

  it('preserves built-in azure-openai-responses models instead of clobbering them', () => {
    expect(content).toContain("getModels('azure-openai-responses')");
    expect(content).toContain('...builtinModels');
  });

  it('carries the same compat flags as autobrin-flue\'s kimiAzureModel()', () => {
    expect(content).toContain('supportsStore: false');
    expect(content).toContain('supportsDeveloperRole: false');
    expect(content).toContain('supportsReasoningEffort: false');
    expect(content).toContain("maxTokensField: 'max_tokens'");
    expect(content).toContain('supportsStrictMode: false');
  });

  it('carries the ported cost/context metadata from autobrin-flue\'s modelMetadata.ts', () => {
    expect(content).toContain('262144');
    expect(content).toContain('"input":0.95');
    expect(content).toContain('"output":4');
  });

  it('no-ops without Azure credentials instead of registering with an undefined apiKey', () => {
    expect(content).toContain('if (!apiKey || !baseUrl) return;');
  });

  it('does not register a before_provider_request payload rewrite (not needed for this integration)', () => {
    expect(content).not.toContain("pi.on('before_provider_request'");
  });
});

describe('pithosKimiAzureExtension: ensureKimiAzurePiExtension', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeHomeDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'benchpress-kimi-azure-home-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('writes nothing and returns undefined when Azure credentials are absent', async () => {
    const homeDir = makeHomeDir();

    const result = await ensureKimiAzurePiExtension({ env: {}, homeDir });

    expect(result).toBeUndefined();
    expect(existsSync(piAgentExtensionsDir(homeDir))).toBe(false);
  });

  it('writes nothing when only one of the two required env vars is set', async () => {
    const homeDir = makeHomeDir();

    const result = await ensureKimiAzurePiExtension({ env: { AZURE_OPENAI_API_KEY: 'key' }, homeDir });

    expect(result).toBeUndefined();
    expect(existsSync(piAgentExtensionsDir(homeDir))).toBe(false);
  });

  it('writes the extension to <home>/.pi/agent/extensions when both env vars are set', async () => {
    const homeDir = makeHomeDir();

    const result = await ensureKimiAzurePiExtension({
      env: { AZURE_OPENAI_API_KEY: 'key', AZURE_OPENAI_BASE_URL: 'https://example.openai.azure.com' },
      homeDir,
    });

    const expectedPath = path.join(piAgentExtensionsDir(homeDir), KIMI_AZURE_PI_EXTENSION_FILENAME);
    expect(result).toBe(expectedPath);
    expect(readFileSync(expectedPath, 'utf8')).toBe(renderKimiAzurePiExtension());
  });

  it('overwrites an existing file on a second run (idempotent, always fresh)', async () => {
    const homeDir = makeHomeDir();
    const env = { AZURE_OPENAI_API_KEY: 'key', AZURE_OPENAI_BASE_URL: 'https://example.openai.azure.com' };

    const first = await ensureKimiAzurePiExtension({ env, homeDir });
    const second = await ensureKimiAzurePiExtension({ env, homeDir });

    expect(first).toBe(second);
    expect(readFileSync(second!, 'utf8')).toBe(renderKimiAzurePiExtension());
  });
});
