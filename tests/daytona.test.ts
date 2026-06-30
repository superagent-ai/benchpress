import { type ChildProcess, spawn, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDaytonaClientConfig } from '../src/daytona/client.js';
import { buildEngagementRunScript } from '../src/daytona/engagement.js';
import { assertAllowedFlueRef, buildSandboxEnv } from '../src/daytona/env.js';
import {
  buildRepoPayload,
  buildWebappPayload,
  engagementResultPath,
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

  it('derives the result.json checkpoint path from workspaceRoot, not BENCHPRESS_ROOT', () => {
    expect(engagementResultPath(buildRepoPayload({ repo: 'owner/repo' }))).toBe('/home/daytona/benchpress/result.json');
    expect(
      engagementResultPath(buildRepoPayload({ repo: 'owner/repo', workspaceRoot: '/custom/workspace' })),
    ).toBe('/custom/workspace/result.json');
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

  it('honors a custom resultPath/payloadPath instead of always using BENCHPRESS_ROOT (regression: workspaceRoot-derived checkpoint)', () => {
    const script = buildEngagementRunScript({
      resultPath: '/custom/workspace/result.json',
      payloadPath: '/custom/payload.json',
    });
    expect(script).toContain("RESULT_PATH = \"/custom/workspace/result.json\"");
    expect(script).toContain("PAYLOAD_PATH = \"/custom/payload.json\"");
    expect(script).toMatch(/rm -f '\/custom\/workspace\/result\.json'/);
    expect(script).not.toContain('/home/daytona/benchpress/result.json');
  });
});

describe('engagement run script wait loop (behavioral)', () => {
  // Runs the actual generated "admit, then wait" Python block as a real
  // subprocess against a real local fake-Flue HTTP server, so these tests
  // exercise the same control flow Bugbot flagged rather than just asserting
  // the generated source contains certain substrings. The fake server is
  // itself Python (http.server), not Node's http module -- Node's HTTP
  // server and Python's urllib client don't reliably handshake against each
  // other in this sandbox, while python-to-python works correctly.
  const children: ChildProcess[] = [];
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function extractWaitLoopBlock(script: string): string {
    const match = script.match(/<<'PY' \| tee "\$STREAM_LOG"\n([\s\S]*?)\nPY/);
    if (!match) throw new Error('main python block not found in generated script');
    return match[1];
  }

  async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  function fakeFlueServerScript(runsResponse: { status: number; headers: Record<string, string>; body: unknown }): string {
    return [
      'import json',
      'import sys',
      'from http.server import BaseHTTPRequestHandler, HTTPServer',
      '',
      // Parse as JSON at runtime rather than splicing in a JS object literal:
      // JSON's `true`/`false`/`null` are not valid Python syntax on their own
      // (`True`/`False`/`None`), so this must round-trip through json.loads.
      `RUNS_RESPONSE = json.loads(${JSON.stringify(JSON.stringify(runsResponse))})`,
      '',
      'class Handler(BaseHTTPRequestHandler):',
      '    def log_message(self, *args):',
      '        pass',
      '',
      '    def do_POST(self):',
      '        if self.path == "/workflows/engagement":',
      '            body = b\'{"runId":"run_test123"}\'',
      '            self.send_response(202)',
      '            self.send_header("Content-Type", "application/json")',
      '            self.send_header("Content-Length", str(len(body)))',
      '            self.end_headers()',
      '            self.wfile.write(body)',
      '            return',
      '        self.send_response(404)',
      '        self.end_headers()',
      '',
      '    def do_GET(self):',
      '        if self.path.startswith("/runs/run_test123"):',
      '            body = json.dumps(RUNS_RESPONSE["body"]).encode("utf-8")',
      '            self.send_response(RUNS_RESPONSE["status"])',
      '            self.send_header("Content-Type", "application/json")',
      '            self.send_header("Content-Length", str(len(body)))',
      '            for key, value in RUNS_RESPONSE["headers"].items():',
      '                self.send_header(key, value)',
      '            self.end_headers()',
      '            self.wfile.write(body)',
      '            return',
      '        body = b\'{"error":{"type":"run_not_found","message":"not found","details":""}}\'',
      '        self.send_response(404)',
      '        self.send_header("Content-Type", "application/json")',
      '        self.send_header("Content-Length", str(len(body)))',
      '        self.end_headers()',
      '        self.wfile.write(body)',
      '',
      'if __name__ == "__main__":',
      '    HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()',
    ].join('\n');
  }

  async function startFakeFlueServer(runsResponse: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  }): Promise<number> {
    const dir = mkdtempSync(path.join(tmpdir(), 'benchpress-fake-flue-'));
    tmpDirs.push(dir);
    const serverPath = path.join(dir, 'server.py');
    writeFileSync(serverPath, fakeFlueServerScript({ headers: {}, ...runsResponse }));

    const port = await findFreePort();
    const child = spawn('python3', [serverPath, String(port)], { stdio: 'ignore' });
    children.push(child);
    await waitForPortReachable(port, 10_000);
    return port;
  }

  function waitForPortReachable(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', () => {
          socket.destroy();
          if (Date.now() >= deadline) {
            reject(new Error(`fake Flue server on port ${port} did not become reachable`));
          } else {
            setTimeout(attempt, 50);
          }
        });
      };
      attempt();
    });
  }

  function writeTempPayloadAndResult(initialResult?: Record<string, unknown>): { payloadPath: string; resultPath: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'benchpress-engagement-test-'));
    tmpDirs.push(dir);
    const payloadPath = path.join(dir, 'payload.json');
    const resultPath = path.join(dir, 'result.json');
    writeFileSync(payloadPath, JSON.stringify({ modality: 'repo', repo: 'owner/repo' }));
    if (initialResult) writeFileSync(resultPath, JSON.stringify(initialResult));
    return { payloadPath, resultPath };
  }

  function runWaitLoop(script: string, port: number): { exitCode: number | null; stdout: string; stderr: string } {
    const block = extractWaitLoopBlock(script);
    const result = spawnSync('python3', ['-c', block], {
      env: { ...process.env, FLUE_PORT: String(port) },
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('succeeds via the result.json checkpoint when the stream closes without ever emitting run_end (Bugbot: stream-closed-skips-checkpoint)', async () => {
    const { payloadPath, resultPath } = writeTempPayloadAndResult({ status: 'ok' });
    // Stream reports closed but never includes a run_end event -- this is
    // exactly the scenario Bugbot flagged as skipping the result.json read.
    const port = await startFakeFlueServer({
      status: 200,
      headers: { 'Stream-Next-Offset': '0_1', 'Stream-Closed': 'true' },
      body: [{ type: 'log', message: 'no run_end here' }],
    });

    const script = buildEngagementRunScript({ maxWaitSeconds: 5, pollIntervalSeconds: 0.2, resultPath, payloadPath });
    const { exitCode, stdout } = runWaitLoop(script, port);

    expect(stdout).not.toContain('benchpress_engagement_incomplete');
    expect(stdout).not.toContain('benchpress_engagement_timeout');
    expect(exitCode).toBe(0);
  }, 20_000);

  it('fails via the result.json checkpoint when the stream closes without run_end and the checkpoint reports an error', async () => {
    const { payloadPath, resultPath } = writeTempPayloadAndResult({ status: 'error' });
    const port = await startFakeFlueServer({
      status: 200,
      headers: { 'Stream-Next-Offset': '0_1', 'Stream-Closed': 'true' },
      body: [],
    });

    const script = buildEngagementRunScript({ maxWaitSeconds: 5, pollIntervalSeconds: 0.2, resultPath, payloadPath });
    const { exitCode } = runWaitLoop(script, port);

    expect(exitCode).toBe(1);
  }, 20_000);

  it('still succeeds promptly via a real run_end event when the run-events endpoint works', async () => {
    const { payloadPath, resultPath } = writeTempPayloadAndResult();
    const port = await startFakeFlueServer({
      status: 200,
      headers: { 'Stream-Next-Offset': '0_1', 'Stream-Closed': 'true' },
      body: [{ type: 'run_end', isError: false }],
    });

    const script = buildEngagementRunScript({ maxWaitSeconds: 5, pollIntervalSeconds: 0.2, resultPath, payloadPath });
    const { exitCode, stdout } = runWaitLoop(script, port);

    expect(stdout).toContain('"type": "run_end"');
    expect(exitCode).toBe(0);
  }, 20_000);

  it('times out with a non-zero exit and a diagnostic instead of a silent success when nothing ever signals completion', async () => {
    const { payloadPath, resultPath } = writeTempPayloadAndResult();
    // Stream never closes and never reports a run_end -- an available but
    // perpetually-stuck stream (the 404/unavailable case is covered above).
    const port = await startFakeFlueServer({
      status: 200,
      headers: { 'Stream-Next-Offset': '0_1' },
      body: [],
    });

    const script = buildEngagementRunScript({ maxWaitSeconds: 1, pollIntervalSeconds: 0.2, resultPath, payloadPath });
    const { exitCode, stdout } = runWaitLoop(script, port);

    expect(stdout).toContain('benchpress_engagement_timeout');
    expect(stdout).toContain('benchpress_engagement_incomplete');
    expect(exitCode).toBe(1);
  }, 20_000);
});
