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

  // Regression (superagent-ai/benchpress#32): the Daytona transport's webapp payload used to carry
  // only target.url, silently dropping the rest of the canonical WebappTargetMetadata contract
  // (username/password/proofUploadingUrl/etc.) that src/contenders/autobrin.ts's buildWebappPayload
  // already sends -- neutering benchmarks like CVE-Bench, whose tasks always require credentials
  // and a proof-upload URL (see src/benchmarks/cve-bench/metadata.ts).
  it('carries the full webapp target contract through, not just url', () => {
    const payload = buildWebappPayload({
      url: 'http://127.0.0.1:8080',
      repo: 'owner/repo',
      sha: 'abc123',
      username: 'attacker',
      password: 'hunter2',
      role: 'user',
      outboundServiceUrl: 'http://target-internal:9000',
      proofUploadingUrl: 'http://127.0.0.1:9091/upload',
      secret: 'topsecret',
      secretUploadingUrl: 'http://127.0.0.1:9091/secret',
    });
    expect(payload.target).toEqual({
      url: 'http://127.0.0.1:8080',
      repo: 'owner/repo',
      sha: 'abc123',
      username: 'attacker',
      password: 'hunter2',
      role: 'user',
      outboundServiceUrl: 'http://target-internal:9000',
      proofUploadingUrl: 'http://127.0.0.1:9091/upload',
      secret: 'topsecret',
      secretUploadingUrl: 'http://127.0.0.1:9091/secret',
    });
  });

  it('normalizes webapp payloads without dropping credentials/proof-upload fields (regression: daytona transport silently stripped these)', () => {
    const normalized = normalizeEngagementPayload({
      modality: 'webapp',
      target: {
        url: 'http://127.0.0.1:8080',
        username: 'attacker',
        password: 'hunter2',
        proofUploadingUrl: 'http://127.0.0.1:9091/upload',
      },
    });
    if (normalized.modality !== 'webapp') throw new Error('expected a webapp payload');
    expect(normalized.target).toEqual({
      url: 'http://127.0.0.1:8080',
      username: 'attacker',
      password: 'hunter2',
      proofUploadingUrl: 'http://127.0.0.1:9091/upload',
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

  type RunsResponse = { status: number; headers: Record<string, string>; body: unknown };

  // Accepts a sequence of responses for GET /runs/:runId so tests can model
  // a stream that stays open across several polls (simulating a still-running
  // engagement) before it eventually closes or emits run_end. Once the
  // sequence is exhausted, the server keeps repeating the last entry.
  function fakeFlueServerScript(runsResponses: RunsResponse[]): string {
    return [
      'import json',
      'import sys',
      'from http.server import BaseHTTPRequestHandler, HTTPServer',
      '',
      // Parse as JSON at runtime rather than splicing in a JS object literal:
      // JSON's `true`/`false`/`null` are not valid Python syntax on their own
      // (`True`/`False`/`None`), so this must round-trip through json.loads.
      `RUNS_RESPONSES = json.loads(${JSON.stringify(JSON.stringify(runsResponses))})`,
      'runs_call_count = 0',
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
      '        global runs_call_count',
      '        if self.path.startswith("/runs/run_test123"):',
      '            index = min(runs_call_count, len(RUNS_RESPONSES) - 1)',
      '            runs_call_count += 1',
      '            runs_response = RUNS_RESPONSES[index]',
      '            body = json.dumps(runs_response["body"]).encode("utf-8")',
      '            self.send_response(runs_response["status"])',
      '            self.send_header("Content-Type", "application/json")',
      '            self.send_header("Content-Length", str(len(body)))',
      '            for key, value in runs_response["headers"].items():',
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

  async function startFakeFlueServerSequence(
    runsResponses: Array<{ status: number; headers?: Record<string, string>; body: unknown }>,
  ): Promise<number> {
    const dir = mkdtempSync(path.join(tmpdir(), 'benchpress-fake-flue-'));
    tmpDirs.push(dir);
    const serverPath = path.join(dir, 'server.py');
    writeFileSync(
      serverPath,
      fakeFlueServerScript(runsResponses.map((response) => ({ headers: {}, ...response }))),
    );

    const port = await findFreePort();
    const child = spawn('python3', [serverPath, String(port)], { stdio: 'ignore' });
    children.push(child);
    await waitForPortReachable(port, 10_000);
    return port;
  }

  async function startFakeFlueServer(runsResponse: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  }): Promise<number> {
    return startFakeFlueServerSequence([runsResponse]);
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

  // Async variant for tests that need to mutate the on-disk checkpoint while
  // the wait loop is still running (spawnSync above blocks the test process
  // itself, so it cannot interleave a delayed file write). Captures the exit
  // timestamp inside the 'close' handler itself -- not when the caller later
  // happens to await the result -- so callers can assert *when* the process
  // actually exited relative to other events, not just that it eventually did.
  function runWaitLoopAsync(script: string, port: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; exitedAtMs: number }> {
    const block = extractWaitLoopBlock(script);
    const child = spawn('python3', ['-c', block], { env: { ...process.env, FLUE_PORT: String(port) } });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    return new Promise((resolve) => {
      child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr, exitedAtMs: Date.now() }));
    });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  it('does not treat an in-flight "usage checkpoint" write as completion while the run-events stream is still open (regression: #8)', async () => {
    // The on-disk checkpoint already says status "ok" for the entire run --
    // AutoBrin writes this at every periodic usage checkpoint, long before
    // cycle 1 (or even the lead) finishes. A correct wait loop must ignore
    // it entirely while the live stream is still open and keep polling the
    // stream itself instead.
    const { payloadPath, resultPath } = writeTempPayloadAndResult({
      status: 'ok',
      stopReason: 'usage checkpoint',
      cyclesCompleted: 0,
    });

    // The stream stays open (not closed, no run_end) for three polls --
    // each carrying a distinguishable marker event -- before it finally
    // closes with a genuine run_end. A loop that reads the checkpoint
    // unconditionally (the bug) exits on the very first poll and never
    // observes markers 2/3 or the run_end; the fixed loop must observe all
    // of them in order before exiting.
    const openMarker = (iteration: number) => ({
      status: 200,
      headers: { 'Stream-Next-Offset': `0_${iteration}` },
      body: [{ type: 'benchpress_test_marker', iteration }],
    });
    const port = await startFakeFlueServerSequence([
      openMarker(1),
      openMarker(2),
      openMarker(3),
      {
        status: 200,
        headers: { 'Stream-Next-Offset': '0_4', 'Stream-Closed': 'true' },
        body: [{ type: 'run_end', isError: false }],
      },
    ]);

    const script = buildEngagementRunScript({ maxWaitSeconds: 10, pollIntervalSeconds: 0.2, resultPath, payloadPath });
    const { exitCode, stdout } = runWaitLoop(script, port);

    expect(stdout).toContain('"iteration": 1');
    expect(stdout).toContain('"iteration": 2');
    expect(stdout).toContain('"iteration": 3');
    expect(stdout).toContain('"type": "run_end"');
    expect(stdout).not.toContain('benchpress_engagement_incomplete');
    expect(stdout).not.toContain('benchpress_engagement_timeout');
    expect(exitCode).toBe(0);
  }, 20_000);

  it('treats a "usage checkpoint" stopReason as non-terminal even once the run-events stream is fully unavailable (regression: #8 extra safeguard)', async () => {
    // No `runs` HTTP handler at all -- every GET 404s immediately, the
    // pre-#169 scenario where the on-disk checkpoint is the *only*
    // completion signal available, so the "stream still open" gate alone
    // cannot protect against an intermediate checkpoint here.
    const { payloadPath, resultPath } = writeTempPayloadAndResult({
      status: 'ok',
      stopReason: 'usage checkpoint',
      cyclesCompleted: 0,
    });
    const port = await startFakeFlueServer({ status: 404, headers: {}, body: { error: { type: 'run_not_found' } } });

    const script = buildEngagementRunScript({ maxWaitSeconds: 10, pollIntervalSeconds: 0.2, resultPath, payloadPath });
    const resultPromise = runWaitLoopAsync(script, port);

    // Give the loop several poll cycles to (incorrectly, if the safeguard
    // were missing) settle on the intermediate "usage checkpoint" before a
    // genuinely final result.json replaces it. The exit timestamp recorded
    // inside runWaitLoopAsync's 'close' handler -- not this sleep -- is what
    // proves whether the process was still alive when the write happened.
    await sleep(700);
    const writeAtMs = Date.now();
    writeFileSync(resultPath, JSON.stringify({ status: 'ok', stopReason: 'maxCycles reached: 1 >= 1', cyclesCompleted: 1 }));

    const { exitCode, stdout, exitedAtMs } = await resultPromise;

    // A loop that misreads the intermediate checkpoint exits within roughly
    // one poll interval of startup -- well before the delayed write above --
    // instead of waiting for it. Allow a little slack for scheduling jitter.
    expect(exitedAtMs).toBeGreaterThanOrEqual(writeAtMs - 50);
    expect(stdout).not.toContain('benchpress_engagement_incomplete');
    expect(stdout).not.toContain('benchpress_engagement_timeout');
    expect(exitCode).toBe(0);
  }, 20_000);
});
