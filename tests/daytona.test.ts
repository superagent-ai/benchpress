import { describe, expect, it } from 'vitest';
import { getDaytonaClientConfig } from '../src/daytona/client.js';
import { assertAllowedFlueRef, buildSandboxEnv } from '../src/daytona/env.js';
import {
  buildRepoPayload,
  buildWebappPayload,
  normalizeEngagementPayload,
} from '../src/daytona/payload.js';
import { shellQuote } from '../src/daytona/shell.js';

describe('daytona client config', () => {
  it('requires DAYTONA_API_KEY or DAYTONA_JWT_TOKEN', () => {
    expect(() => getDaytonaClientConfig({})).toThrow('Missing DAYTONA_API_KEY or DAYTONA_JWT_TOKEN');
  });

  it('requires DAYTONA_ORGANIZATION_ID when using JWT without API key', () => {
    expect(() => getDaytonaClientConfig({ DAYTONA_JWT_TOKEN: 'jwt' })).toThrow('Missing DAYTONA_ORGANIZATION_ID');
  });

  it('builds a config from API key', () => {
    expect(getDaytonaClientConfig({ DAYTONA_API_KEY: 'key', DAYTONA_API_URL: 'https://api.example' })).toEqual({
      apiKey: 'key',
      apiUrl: 'https://api.example',
    });
  });
});

describe('daytona env', () => {
  it('enforces branch pins for AUTOBRIN_FLUE_REF', () => {
    expect(() => assertAllowedFlueRef('feature/foo')).toThrow('branch pin');
    expect(assertAllowedFlueRef('staging')).toBe('staging');
  });

  it('includes computer-use vars and filters empty values', () => {
    const env = buildSandboxEnv({
      env: {
        DAYTONA_API_KEY: 'ignored-here',
        AUTOBRIN_FLUE_MODEL: 'kimi-azure/kimi-k2.6',
        AZURE_OPENAI_API_KEY: 'azure-key',
      },
      ref: 'main',
      visionModel: 'kimi-k2.6',
    });

    expect(env.AUTOBRIN_FLUE_REF).toBe('main');
    expect(env.AUTOBRIN_COMPUTER_USE).toBe('daytona');
    expect(env.AUTOBRIN_COMPUTER_USE_BASE_URL).toBe('http://127.0.0.1:2280');
    expect(env.CUA_SCREENSHOT_VISION_MODEL).toBe('kimi-k2.6');
    expect(env.AZURE_OPENAI_API_KEY).toBe('azure-key');
    expect(env.DAYTONA_API_KEY).toBeUndefined();
  });
});

describe('daytona payload', () => {
  it('builds repo payloads', () => {
    expect(
      buildRepoPayload({
        repo: 'https://github.com/superagent-ai/example.git',
        sha: 'abc123',
        contributors: 3,
        model: 'kimi-azure/kimi-k2.6',
      }),
    ).toEqual({
      modality: 'repo',
      repo: 'https://github.com/superagent-ai/example.git',
      sha: 'abc123',
      workspaceRoot: '/home/daytona/benchpress',
      targetPreparation: 'prepared',
      model: 'kimi-azure/kimi-k2.6',
      contributors: 3,
      resume: false,
    });
  });

  it('builds webapp payloads', () => {
    expect(
      buildWebappPayload({
        url: 'http://127.0.0.1:8080',
        contributors: 2,
      }),
    ).toEqual({
      modality: 'webapp',
      target: { url: 'http://127.0.0.1:8080' },
      workspaceRoot: '/home/daytona/benchpress',
      contributors: 2,
      resume: false,
    });
  });

  it('normalizes payload JSON objects', () => {
    expect(
      normalizeEngagementPayload({
        modality: 'repo',
        repo: 'owner/repo',
      }).modality,
    ).toBe('repo');
  });
});

describe('daytona shell helpers', () => {
  it('shell-quotes paths safely', () => {
    expect(shellQuote("it's fine")).toBe("'it'\\''s fine'");
  });
});
