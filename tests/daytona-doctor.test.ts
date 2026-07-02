import { exec } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Sandbox } from '@daytona/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkComputerUseScreenshot, ensureComputerUseAssets, ensureComputerUseStarted } from '../src/daytona/assets.js';
import { describeAutobrinFlueCloneFailure } from '../src/daytona/bootstrap.js';

const clientMocks = vi.hoisted(() => ({
  AUTO_STOP_SAFETY_NET_MINUTES: 60,
  createDaytonaClient: vi.fn(),
  createSandbox: vi.fn(),
  deleteDaytonaSandbox: vi.fn(),
  applyAutoStopSafetyNet: vi.fn(),
}));

vi.mock('../src/daytona/client.js', () => clientMocks);

const { runDaytonaDoctor } = await import('../src/daytona/doctor.js');

type ExecuteCommandResult = { exitCode: number; result: string };
type ExecuteCommandFn = (
  command: string,
  cwd?: string,
  env?: Record<string, string>,
  timeout?: number,
) => Promise<ExecuteCommandResult>;

function fakeSandbox(executeCommand: ExecuteCommandFn, id = 'fake-sandbox'): Sandbox {
  return { id, process: { executeCommand } } as unknown as Sandbox;
}

/** Sandbox stub driven by canned per-command responses; unmatched commands succeed by default. */
function scriptedSandbox(
  rules: Array<[RegExp | string, ExecuteCommandResult]>,
  fallback: ExecuteCommandResult = { exitCode: 0, result: '' },
): Sandbox {
  const executeCommand: ExecuteCommandFn = async (command) => {
    for (const [matcher, result] of rules) {
      const matches = typeof matcher === 'string' ? command.includes(matcher) : matcher.test(command);
      if (matches) return result;
    }
    return fallback;
  };
  return fakeSandbox(executeCommand);
}

/**
 * Sandbox stub for `ensureComputerUseStarted`: a mockable `computerUse.start()` plus a
 * screenshot-check response sequence (the last entry repeats once exhausted), so tests can model
 * "ready immediately", "ready after N polls", and "never ready" without real sleeps/servers.
 */
function computerUseStartSandbox(options: {
  start?: () => Promise<{ message?: string }>;
  screenshotResults: ExecuteCommandResult[];
  id?: string;
}): Sandbox & { screenshotCallCount: () => number } {
  let callCount = 0;
  const start = options.start ?? (async () => ({ message: 'started' }));
  const executeCommand: ExecuteCommandFn = async (command) => {
    if (command.includes('computeruse/screenshot')) {
      const index = Math.min(callCount, options.screenshotResults.length - 1);
      callCount += 1;
      return options.screenshotResults[index];
    }
    return { exitCode: 0, result: '' };
  };
  return {
    id: options.id ?? 'fake-sandbox',
    process: { executeCommand },
    computerUse: { start },
    screenshotCallCount: () => callCount,
  } as unknown as Sandbox & { screenshotCallCount: () => number };
}

/** Sandbox stub that really runs the command via bash, so the actual curl/mktemp/wc script is exercised. */
function realShellSandbox(): Sandbox {
  const executeCommand: ExecuteCommandFn = (command) =>
    new Promise((resolve) => {
      exec(command, { shell: '/bin/bash' }, (error, stdout) => {
        const code = (error as (Error & { code?: number | string }) | null)?.code;
        const exitCode = error ? (typeof code === 'number' ? code : 1) : 0;
        resolve({ exitCode, result: stdout.toString() });
      });
    });
  return fakeSandbox(executeCommand);
}

const FAKE_PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

async function startFixtureServer(screenshot: Buffer | null): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/computeruse/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'partial' }));
      return;
    }
    if (req.url === '/computeruse/screenshot') {
      if (!screenshot) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(screenshot);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('checkComputerUseScreenshot (real curl/mktemp/wc script over loopback HTTP)', () => {
  it('reports ok with a byte count for a non-empty screenshot response', async () => {
    const fixture = await startFixtureServer(FAKE_PNG_BYTES);
    try {
      const result = await checkComputerUseScreenshot(realShellSandbox(), fixture.baseUrl);
      expect(result.ok).toBe(true);
      expect(result.bytes).toBe(FAKE_PNG_BYTES.length);
      expect(result.exitCode).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('reports not-ok when the screenshot endpoint fails (e.g. daemon not running yet)', async () => {
    const fixture = await startFixtureServer(null);
    try {
      const result = await checkComputerUseScreenshot(realShellSandbox(), fixture.baseUrl);
      expect(result.ok).toBe(false);
      expect(result.bytes).toBe(0);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('reports not-ok when Toolbox is entirely unreachable', async () => {
    const result = await checkComputerUseScreenshot(realShellSandbox(), 'http://127.0.0.1:1');
    expect(result.ok).toBe(false);
  });
});

describe('ensureComputerUseStarted (superagent-ai/benchpress#38 — start() is never fire-and-forget)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('calls sandbox.computerUse.start() and returns true immediately when the first screenshot check already succeeds', async () => {
    const start = vi.fn(async () => ({ message: 'started' }));
    const sandbox = computerUseStartSandbox({
      start,
      screenshotResults: [{ exitCode: 0, result: '54321' }],
    });

    const ready = await ensureComputerUseStarted(sandbox, { timeoutMs: 200, pollIntervalMs: 10 });

    expect(ready).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(sandbox.screenshotCallCount()).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('polls until the screenshot check succeeds, not just on the first attempt', async () => {
    const sandbox = computerUseStartSandbox({
      screenshotResults: [
        { exitCode: 1, result: '' },
        { exitCode: 1, result: '' },
        { exitCode: 0, result: '98765' },
      ],
    });

    const ready = await ensureComputerUseStarted(sandbox, { timeoutMs: 500, pollIntervalMs: 5 });

    expect(ready).toBe(true);
    expect(sandbox.screenshotCallCount()).toBeGreaterThanOrEqual(3);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('gives up and warns clearly after the timeout when the desktop never becomes screenshot-ready (fails clearly, does not hang)', async () => {
    const sandbox = computerUseStartSandbox({
      screenshotResults: [{ exitCode: 1, result: '' }],
    });

    const ready = await ensureComputerUseStarted(sandbox, { timeoutMs: 30, pollIntervalMs: 10 });

    expect(ready).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('did not become screenshot-ready'));
  }, 10_000);

  it('warns and returns false without ever polling when sandbox.computerUse.start() itself throws', async () => {
    const start = vi.fn(async () => {
      throw new Error('computer use not supported on this image');
    });
    const sandbox = computerUseStartSandbox({
      start,
      screenshotResults: [{ exitCode: 0, result: '54321' }],
    });

    const ready = await ensureComputerUseStarted(sandbox, { timeoutMs: 200, pollIntervalMs: 10 });

    expect(ready).toBe(false);
    expect(sandbox.screenshotCallCount()).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('computer use not supported on this image'));
  });

  it('uses the provided baseUrl when checking readiness (real curl against a fixture server)', async () => {
    const fixture = await startFixtureServer(FAKE_PNG_BYTES);
    try {
      const sandbox = { ...realShellSandbox(), computerUse: { start: async () => ({ message: 'started' }) } } as Sandbox;
      const ready = await ensureComputerUseStarted(sandbox, {
        baseUrl: fixture.baseUrl,
        timeoutMs: 200,
        pollIntervalMs: 10,
      });
      expect(ready).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

describe('ensureComputerUseAssets (superagent-ai/benchpress#4 — cua-driver is informational only)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('reports CU usable when cua-driver is entirely missing but Toolbox status + screenshot work (generic daytona-large)', async () => {
    const sandbox = scriptedSandbox([
      ['command -v cua-driver', { exitCode: 127, result: '' }],
      ['computeruse/status', { exitCode: 0, result: '' }],
      ['computeruse/screenshot', { exitCode: 0, result: '54321' }],
    ]);

    const status = await ensureComputerUseAssets(sandbox);

    expect(status.cuaDriverAvailable).toBe(false);
    expect(status.computerUseStatusOk).toBe(true);
    expect(status.computerUseScreenshotOk).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reports CU usable when cua-driver is installed but Toolbox status is only "partial" (app-parity node:22-bookworm)', async () => {
    const sandbox = scriptedSandbox([
      ['command -v cua-driver', { exitCode: 0, result: '' }],
      // curl -fsS only cares about the HTTP status code, not the body, so a "partial" status
      // (vs. "active") still exits 0 here -- matching the live-validation evidence in issue #4.
      ['computeruse/status', { exitCode: 0, result: '' }],
      ['computeruse/screenshot', { exitCode: 0, result: '98765' }],
    ]);

    const status = await ensureComputerUseAssets(sandbox);

    expect(status.cuaDriverAvailable).toBe(true);
    expect(status.computerUseStatusOk).toBe(true);
    expect(status.computerUseScreenshotOk).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns (but does not throw) when Toolbox is unreachable and screenshot capture fails, regardless of cua-driver', async () => {
    const sandbox = scriptedSandbox([
      ['command -v cua-driver', { exitCode: 0, result: '' }],
      ['computeruse/status', { exitCode: 7, result: '' }],
      ['computeruse/screenshot', { exitCode: 1, result: '' }],
    ]);

    const status = await ensureComputerUseAssets(sandbox);

    expect(status.computerUseStatusOk).toBe(false);
    expect(status.computerUseScreenshotOk).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Toolbox'));
  });

  it('warns when status is reachable but screenshot capture alone fails, and does not also claim Toolbox is fully healthy', async () => {
    const sandbox = scriptedSandbox([
      ['command -v cua-driver', { exitCode: 0, result: '' }],
      ['computeruse/status', { exitCode: 0, result: '' }],
      ['computeruse/screenshot', { exitCode: 1, result: '' }],
    ]);

    const status = await ensureComputerUseAssets(sandbox);

    expect(status.computerUseStatusOk).toBe(true);
    expect(status.computerUseScreenshotOk).toBe(false);
    // This is the scenario runDaytonaDoctor treats as a failed image (pass = status && screenshot),
    // so ensureComputerUseAssets must warn here too instead of staying silent. See benchpress#6 review.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Toolbox'));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('Toolbox loopback status and screenshot capture both succeeded'));
  });
});

describe('runDaytonaDoctor (superagent-ai/benchpress#4)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    clientMocks.createDaytonaClient.mockReset().mockReturnValue({});
    clientMocks.applyAutoStopSafetyNet.mockReset().mockResolvedValue(undefined);
    clientMocks.deleteDaytonaSandbox.mockReset().mockResolvedValue(undefined);
    clientMocks.createSandbox.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes on a generic daytona-large snapshot where cua-driver is not installed at all', async () => {
    clientMocks.createSandbox.mockResolvedValue(
      scriptedSandbox([
        ['command -v cua-driver', { exitCode: 127, result: '' }],
        ['cua-driver status', { exitCode: 127, result: 'bash: cua-driver: command not found' }],
        ['computeruse/status', { exitCode: 0, result: '' }],
        ['computeruse/screenshot', { exitCode: 0, result: '54321' }],
      ]),
    );

    const result = await runDaytonaDoctor({ snapshot: 'daytona-large', env: { DAYTONA_API_KEY: 'test' } });

    expect(result.pass).toBe(true);
    expect(result.computerUseStatusOk).toBe(true);
    expect(result.computerUseScreenshotOk).toBe(true);
    expect(result.cuaDriverAvailable).toBe(false);
    expect(result.cuaDriverStatusOk).toBe(false);
  });

  it('passes on the app-parity node:22-bookworm image where cua-driver has no running daemon or start subcommand', async () => {
    clientMocks.createSandbox.mockResolvedValue(
      scriptedSandbox([
        ['command -v cua-driver', { exitCode: 0, result: '' }],
        // No `start` subcommand and no daemon running by default -- `cua-driver status` fails even
        // though Toolbox loopback CU (status + screenshot) works fine. See issue #4 evidence.
        ['cua-driver status', { exitCode: 1, result: 'Unknown tool: status' }],
        ['computeruse/status', { exitCode: 0, result: '' }],
        ['computeruse/screenshot', { exitCode: 0, result: '98765' }],
      ]),
    );

    const result = await runDaytonaDoctor({ image: 'node22-bookworm-cu', env: { DAYTONA_API_KEY: 'test' } });

    expect(result.pass).toBe(true);
    expect(result.cuaDriverAvailable).toBe(true);
    expect(result.cuaDriverStatusOk).toBe(false);
    expect(result.computerUseStatusOk).toBe(true);
    expect(result.computerUseScreenshotOk).toBe(true);
  });

  it('fails when Toolbox loopback is unreachable even though cua-driver reports healthy', async () => {
    clientMocks.createSandbox.mockResolvedValue(
      scriptedSandbox([
        ['command -v cua-driver', { exitCode: 0, result: '' }],
        ['cua-driver status', { exitCode: 0, result: 'ok' }],
        ['computeruse/status', { exitCode: 7, result: '' }],
        ['computeruse/screenshot', { exitCode: 1, result: '' }],
      ]),
    );

    const result = await runDaytonaDoctor({ image: 'broken-image', env: { DAYTONA_API_KEY: 'test' } });

    expect(result.pass).toBe(false);
    expect(result.computerUseStatusOk).toBe(false);
  });

  it('fails when screenshot capture returns nothing even though status is reachable and cua-driver is healthy', async () => {
    clientMocks.createSandbox.mockResolvedValue(
      scriptedSandbox([
        ['command -v cua-driver', { exitCode: 0, result: '' }],
        ['cua-driver status', { exitCode: 0, result: 'ok' }],
        ['computeruse/status', { exitCode: 0, result: '' }],
        ['computeruse/screenshot', { exitCode: 1, result: '' }],
      ]),
    );

    const result = await runDaytonaDoctor({ image: 'no-screenshot', env: { DAYTONA_API_KEY: 'test' } });

    expect(result.pass).toBe(false);
    expect(result.computerUseScreenshotOk).toBe(false);
    expect(result.cuaDriverStatusOk).toBe(true);
  });
});

describe('describeAutobrinFlueCloneFailure (superagent-ai/benchpress#5)', () => {
  const repo = 'https://github.com/superagent-ai/autobrin-flue.git';

  it('distinguishes "no token configured" from "token present but rejected"', () => {
    const noToken = describeAutobrinFlueCloneFailure({ repo, hasToken: false, logPath: '/x/log' });
    const withToken = describeAutobrinFlueCloneFailure({ repo, hasToken: true, logPath: '/x/log' });

    expect(noToken).toMatch(/no GitHub token configured/i);
    expect(withToken).toMatch(/lacks read access/i);
    expect(withToken).not.toMatch(/no GitHub token configured/i);
    expect(noToken).toContain(repo);
    expect(withToken).toContain(repo);
  });
});
