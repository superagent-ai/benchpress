import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// runDaytonaEngagement's own collaborators (sandbox lifecycle, bootstrap, computer-use assets,
// engagement execution) are mocked so these tests isolate the afterEngagement hook's contract:
// it must run once the engagement finishes but strictly before the sandbox is torn down, since
// that hook is the only place callers (e.g. the autobrin daytona-transport contender) can read
// anything from the sandbox's filesystem -- by the time runDaytonaEngagement itself resolves, the
// sandbox is already deleted.
const clientMocks = vi.hoisted(() => ({
  AUTO_STOP_SAFETY_NET_MINUTES: 60,
  createDaytonaClient: vi.fn(() => ({})),
  createSandbox: vi.fn(),
  deleteDaytonaSandbox: vi.fn(),
  applyAutoStopSafetyNet: vi.fn(async () => undefined),
}));
vi.mock('../src/daytona/client.js', () => clientMocks);

const bootstrapMocks = vi.hoisted(() => ({
  bootstrapAutobrinFlue: vi.fn(async () => undefined),
  prepareRepoTarget: vi.fn(async () => undefined),
  prepareWebappTarget: vi.fn(async () => undefined),
}));
vi.mock('../src/daytona/bootstrap.js', () => bootstrapMocks);

const assetsMocks = vi.hoisted(() => ({
  ensureComputerUseAssets: vi.fn(async () => ({
    bundledSkillPresent: true,
    cuaDriverAvailable: true,
    computerUseStatusOk: true,
    computerUseScreenshotOk: true,
    visionHelperPresent: true,
    usedFallback: false,
  })),
}));
vi.mock('../src/daytona/assets.js', () => assetsMocks);

type FakeEngagementResult = {
  exitCode: number;
  streamLogPath: string;
  resultPath: string;
  resultJson: Record<string, unknown>;
};

const engagementMocks = vi.hoisted(() => ({
  runEngagementViaHttp: vi.fn(
    async (): Promise<FakeEngagementResult> => ({
      exitCode: 0,
      streamLogPath: '/logs/stream.jsonl',
      resultPath: '/result.json',
      resultJson: { status: 'ok' },
    }),
  ),
}));
vi.mock('../src/daytona/engagement.js', () => engagementMocks);

const { runDaytonaEngagement } = await import('../src/daytona/launcher.js');

describe('runDaytonaEngagement afterEngagement hook', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    clientMocks.createSandbox.mockReset().mockResolvedValue({ id: 'sandbox-1' });
    clientMocks.deleteDaytonaSandbox.mockReset().mockResolvedValue(undefined);
    engagementMocks.runEngagementViaHttp.mockReset().mockResolvedValue({
      exitCode: 0,
      streamLogPath: '/logs/stream.jsonl',
      resultPath: '/result.json',
      resultJson: { status: 'ok' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseOptions = {
    image: 'test-image',
    payload: { modality: 'repo' as const, repo: 'owner/repo' },
    env: { DAYTONA_API_KEY: 'test' },
  };

  it('runs after the engagement completes but before the sandbox is deleted', async () => {
    const order: string[] = [];
    engagementMocks.runEngagementViaHttp.mockImplementation(async () => {
      order.push('engagement');
      return { exitCode: 0, streamLogPath: 'x', resultPath: 'y', resultJson: {} };
    });
    clientMocks.deleteDaytonaSandbox.mockImplementation(async () => {
      order.push('deleted');
    });

    await runDaytonaEngagement({
      ...baseOptions,
      afterEngagement: async (sandbox, payload, engagement) => {
        order.push('afterEngagement');
        expect(sandbox.id).toBe('sandbox-1');
        expect(payload.modality).toBe('repo');
        expect(engagement.exitCode).toBe(0);
      },
    });

    expect(order).toEqual(['engagement', 'afterEngagement', 'deleted']);
  });

  it('still deletes the sandbox and rejects the call when afterEngagement throws', async () => {
    await expect(
      runDaytonaEngagement({
        ...baseOptions,
        afterEngagement: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    expect(clientMocks.deleteDaytonaSandbox).toHaveBeenCalledWith('sandbox-1', baseOptions.env);
  });

  it('is optional: omitting it leaves the existing create/run/cleanup behavior unchanged', async () => {
    const result = await runDaytonaEngagement(baseOptions);

    expect(result.sandboxId).toBe('sandbox-1');
    expect(result.engagement.exitCode).toBe(0);
    expect(clientMocks.deleteDaytonaSandbox).toHaveBeenCalledWith('sandbox-1', baseOptions.env);
  });

  it('still runs and still deletes the sandbox when keepSandbox is false and the hook does not throw', async () => {
    let hookCalled = false;
    await runDaytonaEngagement({
      ...baseOptions,
      afterEngagement: async () => {
        hookCalled = true;
      },
    });

    expect(hookCalled).toBe(true);
    expect(clientMocks.deleteDaytonaSandbox).toHaveBeenCalledTimes(1);
  });

  it('runs even when keepSandbox is true, and does not delete the sandbox afterward', async () => {
    let hookCalled = false;
    const result = await runDaytonaEngagement({
      ...baseOptions,
      keepSandbox: true,
      afterEngagement: async () => {
        hookCalled = true;
      },
    });

    expect(hookCalled).toBe(true);
    expect(result.keptSandbox).toBe(true);
    expect(clientMocks.deleteDaytonaSandbox).not.toHaveBeenCalled();
  });
});
