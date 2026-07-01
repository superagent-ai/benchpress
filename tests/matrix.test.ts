import { describe, expect, it, vi } from 'vitest';
import type { BenchmarkAdapter } from '../src/benchmarks/types.js';
import type { AgentRunner, BenchmarkTask, ContenderClaim, NormalizedResult, TargetHandle } from '../src/contenders/types.js';

const registryMock = vi.hoisted(() => ({ resolveBenchmark: vi.fn() }));
vi.mock('../src/benchmarks/registry.js', () => registryMock);

const { runSingle, runMatrix } = await import('../src/matrix/run.js');

function fakeTask(id: string): BenchmarkTask {
  return { id, benchmarkId: 'fake-benchmark' };
}

function fakeTarget(task: BenchmarkTask): TargetHandle {
  return { benchmarkId: 'fake-benchmark', taskId: task.id, modality: 'repo' };
}

function fakeClaim(): ContenderClaim {
  return { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} };
}

function fakeContender(): AgentRunner {
  return {
    id: 'fake-contender',
    type: 'command',
    run: vi.fn(
      async (): Promise<NormalizedResult> => ({
        contenderId: 'fake-contender',
        contenderType: 'command',
        exitCode: 0,
        durationS: 0,
        costUsd: null,
        costStatus: 'unavailable',
        claim: fakeClaim(),
      }),
    ),
  };
}

/** Minimal adapter double -- only the shape runSingle/runMatrix actually touch. */
function fakeAdapter(overrides: Partial<BenchmarkAdapter> = {}): BenchmarkAdapter {
  return {
    id: 'fake-benchmark',
    lane: 'scientific',
    description: 'fake',
    setup: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => [fakeTask('task-1')]),
    standUpTarget: vi.fn(async (task) => fakeTarget(task)),
    score: vi.fn(async () => ({ truePositives: 1, falsePositives: 0, falseNegatives: 0, trueNegatives: 0, signals: [] })),
    teardown: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('runSingle/runMatrix: isScoreable pre-check', () => {
  it('runSingle refuses an unscoreable task before running the contender', async () => {
    const contender = fakeContender();
    const adapter = fakeAdapter({ isScoreable: vi.fn(() => false) });
    registryMock.resolveBenchmark.mockReturnValue(adapter);

    await expect(runSingle({ benchmarkId: 'fake-benchmark', contender, controls: { model: 'x' } })).rejects.toThrow(
      /cannot be scored yet/,
    );

    expect(adapter.standUpTarget).not.toHaveBeenCalled();
    expect(contender.run).not.toHaveBeenCalled();
  });

  it('runMatrix skips an unscoreable task (does not abort the whole run) and never stands it up', async () => {
    const contender = fakeContender();
    const adapter = fakeAdapter({ isScoreable: vi.fn(() => false) });
    registryMock.resolveBenchmark.mockReturnValue(adapter);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runMatrix({
      contenders: [],
      benchmarks: ['fake-benchmark'],
      controls: { model: 'x' },
    });

    expect(adapter.standUpTarget).not.toHaveBeenCalled();
    expect(result.taskResults).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot be scored yet'));
    warnSpy.mockRestore();
  });

  it('runs the contender normally when isScoreable is undefined (adapters that never need it)', async () => {
    const contender = fakeContender();
    const adapter = fakeAdapter();
    delete (adapter as { isScoreable?: unknown }).isScoreable;
    registryMock.resolveBenchmark.mockReturnValue(adapter);

    const result = await runSingle({ benchmarkId: 'fake-benchmark', contender, controls: { model: 'x' } });

    expect(contender.run).toHaveBeenCalledOnce();
    expect(result.contenderResults[0]!.oracleScore.truePositives).toBe(1);
  });
});

describe('runSingle/runMatrix: teardown always runs, even when score() throws', () => {
  it('runSingle still tears down the target after score() rejects, and propagates the original error', async () => {
    const contender = fakeContender();
    const adapter = fakeAdapter({
      score: vi.fn(async () => {
        throw new Error('boom: grader blew up');
      }),
    });
    registryMock.resolveBenchmark.mockReturnValue(adapter);

    await expect(runSingle({ benchmarkId: 'fake-benchmark', contender, controls: { model: 'x' } })).rejects.toThrow(
      /boom: grader blew up/,
    );

    expect(adapter.teardown).toHaveBeenCalledTimes(1);
  });

  it('runMatrix still tears down the target after score() rejects, and propagates the original error', async () => {
    const contender = fakeContender();
    const adapter = fakeAdapter({
      score: vi.fn(async () => {
        throw new Error('boom: grader blew up');
      }),
    });
    registryMock.resolveBenchmark.mockReturnValue(adapter);

    await expect(
      runMatrix({ contenders: [{ id: 'c', type: 'command', command: 'true' }], benchmarks: ['fake-benchmark'], controls: { model: 'x' } }),
    ).rejects.toThrow(/boom: grader blew up/);

    expect(adapter.teardown).toHaveBeenCalledTimes(1);
  });

  it('still tears down on the happy path (no regression)', async () => {
    const contender = fakeContender();
    const adapter = fakeAdapter();
    registryMock.resolveBenchmark.mockReturnValue(adapter);

    await runSingle({ benchmarkId: 'fake-benchmark', contender, controls: { model: 'x' } });

    expect(adapter.teardown).toHaveBeenCalledTimes(1);
  });

  it('runSingle tears down even when standUpTarget() itself throws (e.g. a target that partially came up)', async () => {
    const contender = fakeContender();
    const adapter = fakeAdapter({
      standUpTarget: vi.fn(async () => {
        throw new Error('boom: compose up succeeded but health check failed');
      }),
    });
    registryMock.resolveBenchmark.mockReturnValue(adapter);

    await expect(runSingle({ benchmarkId: 'fake-benchmark', contender, controls: { model: 'x' } })).rejects.toThrow(
      /boom: compose up succeeded/,
    );

    expect(adapter.teardown).toHaveBeenCalledTimes(1);
    expect(contender.run).not.toHaveBeenCalled();
  });

  it('runMatrix tears down even when standUpTarget() itself throws', async () => {
    const contender = fakeContender();
    const adapter = fakeAdapter({
      standUpTarget: vi.fn(async () => {
        throw new Error('boom: compose up succeeded but health check failed');
      }),
    });
    registryMock.resolveBenchmark.mockReturnValue(adapter);

    await expect(
      runMatrix({ contenders: [{ id: 'c', type: 'command', command: 'true' }], benchmarks: ['fake-benchmark'], controls: { model: 'x' } }),
    ).rejects.toThrow(/boom: compose up succeeded/);

    expect(adapter.teardown).toHaveBeenCalledTimes(1);
    expect(contender.run).not.toHaveBeenCalled();
  });
});
