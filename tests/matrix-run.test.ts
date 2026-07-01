import { describe, expect, it, vi } from 'vitest';
import { assertSingleContenderForStatefulTarget, runTaskAcrossContenders } from '../src/matrix/run.js';
import type { BenchmarkAdapter } from '../src/benchmarks/types.js';
import type { AgentRunner, BenchmarkTask, NormalizedResult, RunContext, TargetHandle } from '../src/contenders/types.js';
import { emptyOracleScore } from '../src/oracle/types.js';

function fakeTask(): BenchmarkTask {
  return { id: 'task-1', benchmarkId: 'fake-benchmark' };
}

function fakeTarget(task: BenchmarkTask): TargetHandle {
  return { benchmarkId: task.benchmarkId, taskId: task.id, modality: 'repo' };
}

function fakeResult(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    contenderId: 'fake-contender',
    contenderType: 'command',
    exitCode: 0,
    durationS: 0,
    costUsd: null,
    costStatus: 'unavailable',
    claim: { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} },
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<BenchmarkAdapter> = {}): BenchmarkAdapter {
  return {
    id: 'fake-benchmark',
    lane: 'scientific',
    description: 'fake benchmark for matrix/run.ts unit tests',
    async setup() {},
    async listTasks() {
      return [fakeTask()];
    },
    async standUpTarget(task) {
      return fakeTarget(task);
    },
    async score() {
      return emptyOracleScore();
    },
    ...overrides,
  };
}

function fakeContender(overrides: Partial<AgentRunner> = {}): AgentRunner {
  return {
    id: 'fake-contender',
    type: 'command',
    async run() {
      return fakeResult();
    },
    ...overrides,
  };
}

const context: RunContext = { runId: 'test-run', resultsDir: '/tmp/results', engagementsDir: '/tmp/engagements' };

describe('assertSingleContenderForStatefulTarget', () => {
  it('allows any contender count for a non-stateful (default) adapter', () => {
    expect(() =>
      assertSingleContenderForStatefulTarget({ id: 'repo-cve-smoke' }, [fakeContender(), fakeContender({ id: 'b' })]),
    ).not.toThrow();
  });

  it('allows a single contender even for a stateful-target adapter', () => {
    expect(() =>
      assertSingleContenderForStatefulTarget({ id: 'cve-bench', statefulTarget: true }, [fakeContender()]),
    ).not.toThrow();
  });

  it('rejects more than one contender against a stateful-target adapter (regression: shared mutable target)', () => {
    expect(() =>
      assertSingleContenderForStatefulTarget({ id: 'cve-bench', statefulTarget: true }, [
        fakeContender({ id: 'autobrin@staging' }),
        fakeContender({ id: 'autobrin@main' }),
      ]),
    ).toThrow(/cve-bench stands up one live, mutable target/);
  });
});

describe('runTaskAcrossContenders', () => {
  it('tears down the target even when a contender run throws (regression: leaked Docker stack on failure)', async () => {
    const teardown = vi.fn(async () => {});
    const adapter = fakeAdapter({ teardown });
    const contender = fakeContender({
      async run() {
        throw new Error('contender crashed mid-engagement');
      },
    });

    await expect(
      runTaskAcrossContenders({ adapter, task: fakeTask(), contenders: [contender], controls: { model: 'x' }, context }),
    ).rejects.toThrow('contender crashed mid-engagement');
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('tears down the target even when score() throws', async () => {
    const teardown = vi.fn(async () => {});
    const adapter = fakeAdapter({
      teardown,
      async score() {
        throw new Error('grader endpoint unreachable');
      },
    });

    await expect(
      runTaskAcrossContenders({ adapter, task: fakeTask(), contenders: [fakeContender()], controls: { model: 'x' }, context }),
    ).rejects.toThrow('grader endpoint unreachable');
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('tears down exactly once and returns a normal result on success', async () => {
    const teardown = vi.fn(async () => {});
    const adapter = fakeAdapter({ teardown });

    const result = await runTaskAcrossContenders({
      adapter,
      task: fakeTask(),
      contenders: [fakeContender()],
      controls: { model: 'x' },
      context,
    });

    expect(result.contenderResults).toHaveLength(1);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('does not require teardown to be defined', async () => {
    const adapter = fakeAdapter({ teardown: undefined });
    await expect(
      runTaskAcrossContenders({ adapter, task: fakeTask(), contenders: [fakeContender()], controls: { model: 'x' }, context }),
    ).resolves.toBeDefined();
  });
});
