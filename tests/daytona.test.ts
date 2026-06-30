import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { getDaytonaClientConfig } from '../src/daytona/client.js';
import { buildEngagementRunScript } from '../src/daytona/engagement.js';
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

describe('engagement run script', () => {
  function extractPythonBlocks(script: string): string[] {
    const blocks: string[] = [];
    // The heredoc opener line may have trailing shell syntax after the
    // quoted delimiter (e.g. `<<'PY' | tee "$STREAM_LOG"` or `<<'PY' || true`).
    const heredocPattern = /<<'PY'[^\n]*\n([\s\S]*?)\nPY/g;
    for (const match of script.matchAll(heredocPattern)) {
      blocks.push(match[1]);
    }
    return blocks;
  }

  it('is valid bash (set -euo pipefail parses with bash -n)', () => {
    const script = buildEngagementRunScript();
    expect(() => execFileSync('bash', ['-n'], { input: script })).not.toThrow();
  });

  it('embeds only syntactically valid python3 heredocs', () => {
    const script = buildEngagementRunScript();
    const blocks = extractPythonBlocks(script);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      expect(() => execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: block })).not.toThrow();
    }
  });

  it('admits the workflow via POST without treating the response as an event stream', () => {
    const script = buildEngagementRunScript();
    expect(script).toContain('/workflows/engagement');
    expect(script).toContain('method="POST"');
    // Regression guard: the admission response is a fast 202 receipt, never a
    // live SSE stream, regardless of Accept header -- do not reintroduce a
    // "treat the POST body itself as the whole engagement" assumption.
    expect(script).not.toContain('text/event-stream');
    expect(script).toContain('run_id = admission.get("runId")');
  });

  it('waits for completion via the run-events endpoint with a result.json fallback', () => {
    const script = buildEngagementRunScript();
    expect(script).toContain('/runs/{run_id}');
    expect(script).toContain('Stream-Closed');
    expect(script).toContain('Stream-Next-Offset');
    expect(script).toContain('read_result_status');
    expect(script).toContain('error.code == 404');
    expect(script).toContain('benchpress_run_events_unavailable');
  });

  it('clears a stale result.json checkpoint before polling for this run', () => {
    const script = buildEngagementRunScript();
    expect(script).toMatch(/rm -f '\/home\/daytona\/benchpress\/result\.json'/);
  });

  it('reports a clear timeout diagnostic and a non-zero exit instead of silently succeeding', () => {
    const script = buildEngagementRunScript();
    expect(script).toContain('benchpress_engagement_timeout');
    expect(script).toContain('benchpress_engagement_incomplete');
    expect(script).toContain('sys.exit(1)');
    expect(script).toContain('MAX_WAIT_SECONDS = 3300');
  });

  it('honors custom wait/poll options', () => {
    const script = buildEngagementRunScript({ maxWaitSeconds: 120, pollIntervalSeconds: 1 });
    expect(script).toContain('MAX_WAIT_SECONDS = 120');
    expect(script).toContain('POLL_INTERVAL_SECONDS = 1');
  });

  it('still shuts down observability and kills the Flue server after waiting', () => {
    const script = buildEngagementRunScript();
    expect(script).toContain('/__autobrin/observability/shutdown');
    expect(script).toContain('kill "$FLUE_SERVER_PID"');
    expect(script).toContain('exit_code=${PIPESTATUS[0]}');
    expect(script).toContain('exit "$exit_code"');
  });
});
