import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression test for a Bugbot finding: runViaDaytona previously raced ensureAutobrinCheckout
// against runDaytonaEngagement via Promise.all. A fast local-checkout failure (e.g. a transient
// git error -- observed for real while validating this feature) still let the expensive, billed
// sandbox engagement run to completion for a result that got thrown away, since nothing was left
// awaiting or cancelling it. Both collaborators are mocked here specifically to assert *call
// ordering*, which a real end-to-end run can't observe.
const checkoutMocks = vi.hoisted(() => ({
  ensureAutobrinCheckout: vi.fn(),
}));
vi.mock('../src/lib/checkout.js', () => checkoutMocks);

const launcherMocks = vi.hoisted(() => ({
  runDaytonaEngagement: vi.fn(),
}));
vi.mock('../src/daytona/launcher.js', () => launcherMocks);

const { createAutobrinRunner } = await import('../src/contenders/autobrin.js');

describe('autobrin daytona transport: local checkout must resolve before the sandbox engagement starts', () => {
  const baseTask = { id: 't1', benchmarkId: 'repo-cve-smoke' };
  const baseTarget = {
    benchmarkId: 'repo-cve-smoke',
    taskId: 't1',
    modality: 'repo' as const,
    repo: 'owner/repo',
    sha: 'abc123',
  };
  const baseControls = { model: 'kimi-azure/kimi-k2.6' };

  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeContext() {
    const root = mkdtempSync(path.join(tmpdir(), 'benchpress-daytona-sequencing-'));
    tmpDirs.push(root);
    return { runId: 'run1', resultsDir: path.join(root, 'results'), engagementsDir: path.join(root, 'engagements') };
  }

  it('never starts the sandbox engagement when the cheap local checkout fails first', async () => {
    checkoutMocks.ensureAutobrinCheckout.mockReset().mockRejectedValue(new Error('spawn git ENOENT'));
    launcherMocks.runDaytonaEngagement.mockReset();

    const runner = createAutobrinRunner({ config: { id: 'x', type: 'autobrin', transport: 'daytona', image: 'test-image' } });

    await expect(
      runner.run({ task: baseTask, target: baseTarget, controls: baseControls, context: makeContext() }),
    ).rejects.toThrow('spawn git ENOENT');
    expect(launcherMocks.runDaytonaEngagement).not.toHaveBeenCalled();
  });

  it('starts the sandbox engagement only after the local checkout resolves, and reports its resolved ref/sha', async () => {
    checkoutMocks.ensureAutobrinCheckout.mockReset().mockResolvedValue({ root: '/cache/x', ref: 'staging', commitSha: 'deadbeef' });
    launcherMocks.runDaytonaEngagement.mockReset().mockResolvedValue({
      sandboxId: 'sandbox-1',
      engagement: { exitCode: 0, streamLogPath: 'x', resultPath: 'y', resultJson: {} },
      computerUse: {},
      keptSandbox: false,
    });

    const runner = createAutobrinRunner({ config: { id: 'x', type: 'autobrin', transport: 'daytona', image: 'test-image' } });
    const result = await runner.run({ task: baseTask, target: baseTarget, controls: baseControls, context: makeContext() });

    expect(result.resolvedRef).toBe('staging');
    expect(result.commitSha).toBe('deadbeef');
    expect(result.raw).toEqual({ sandboxId: 'sandbox-1' });
    expect(launcherMocks.runDaytonaEngagement).toHaveBeenCalledTimes(1);
    expect(checkoutMocks.ensureAutobrinCheckout).toHaveBeenCalledTimes(1);
  });
});

describe('autobrin daytona transport: webapp modality (superagent-ai/benchpress#32)', () => {
  const baseTask = { id: 'CVE-2024-3234', benchmarkId: 'cve-bench' };
  const webappTarget = {
    benchmarkId: 'cve-bench',
    taskId: 'CVE-2024-3234',
    modality: 'webapp' as const,
    metadata: {
      webapp: {
        url: 'http://127.0.0.1:54321',
        username: 'tester',
        password: 'hunter2',
        proofUploadingUrl: 'http://127.0.0.1:54322/upload',
      },
    },
  };
  const baseControls = { model: 'kimi-azure/kimi-k2.6' };

  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeContext() {
    const root = mkdtempSync(path.join(tmpdir(), 'benchpress-daytona-webapp-'));
    tmpDirs.push(root);
    return { runId: 'run1', resultsDir: path.join(root, 'results'), engagementsDir: path.join(root, 'engagements') };
  }

  it('builds a webapp payload (not buildRepoPayload) and never requires target.repo', async () => {
    checkoutMocks.ensureAutobrinCheckout.mockReset().mockResolvedValue({ root: '/cache/x', ref: 'staging', commitSha: 'deadbeef' });
    launcherMocks.runDaytonaEngagement.mockReset().mockResolvedValue({
      sandboxId: 'sandbox-1',
      engagement: { exitCode: 0, streamLogPath: 'x', resultPath: 'y', resultJson: {} },
      computerUse: {},
      keptSandbox: false,
    });

    const runner = createAutobrinRunner({ config: { id: 'x', type: 'autobrin', transport: 'daytona', image: 'test-image' } });
    const result = await runner.run({ task: baseTask, target: webappTarget, controls: baseControls, context: makeContext() });

    expect(result.exitCode).toBe(0);
    expect(launcherMocks.runDaytonaEngagement).toHaveBeenCalledTimes(1);
    const options = launcherMocks.runDaytonaEngagement.mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(options.payload).toMatchObject({
      modality: 'webapp',
      target: {
        url: 'http://127.0.0.1:54321',
        username: 'tester',
        password: 'hunter2',
        proofUploadingUrl: 'http://127.0.0.1:54322/upload',
      },
    });
    // Daytona transport omits workspaceRoot for webapp too -- the sandbox-side launcher defaults
    // it to its own root, same as the existing repo-modality behavior.
    expect('workspaceRoot' in options.payload).toBe(false);
    expect('repo' in options.payload).toBe(false);
  });

  it('rejects an unsupported modality (e.g. "model") with a clear error, and never starts the sandbox', async () => {
    checkoutMocks.ensureAutobrinCheckout.mockReset();
    launcherMocks.runDaytonaEngagement.mockReset();
    const runner = createAutobrinRunner({ config: { id: 'x', type: 'autobrin', transport: 'daytona', image: 'test-image' } });
    const modelTarget = { benchmarkId: 'b', taskId: 't1', modality: 'model' as const };

    await expect(
      runner.run({ task: baseTask, target: modelTarget, controls: baseControls, context: makeContext() }),
    ).rejects.toThrow(/does not support modality "model"/);
    expect(launcherMocks.runDaytonaEngagement).not.toHaveBeenCalled();
    expect(checkoutMocks.ensureAutobrinCheckout).not.toHaveBeenCalled();
  });

  it('still rejects modality "repo" missing target.repo, unchanged from before', async () => {
    checkoutMocks.ensureAutobrinCheckout.mockReset();
    launcherMocks.runDaytonaEngagement.mockReset();
    const runner = createAutobrinRunner({ config: { id: 'x', type: 'autobrin', transport: 'daytona', image: 'test-image' } });
    const repoTargetMissingRepo = { benchmarkId: 'b', taskId: 't1', modality: 'repo' as const };

    await expect(
      runner.run({ task: baseTask, target: repoTargetMissingRepo, controls: baseControls, context: makeContext() }),
    ).rejects.toThrow(/modality "repo" requires target\.repo/);
    expect(launcherMocks.runDaytonaEngagement).not.toHaveBeenCalled();
  });
});
