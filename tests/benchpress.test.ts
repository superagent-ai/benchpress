import { describe, expect, it } from 'vitest';
import { stripJsonComments } from '../src/lib/json.js';
import { scoreFixCommitOverlap } from '../src/benchmarks/repo-cve-smoke/adapter.js';
import { resolveBenchmark, listBenchmarks, BENCHMARK_CAPABILITY_DEPENDENCIES } from '../src/benchmarks/registry.js';
import { createContender, contenderIdFromConfig } from '../src/contenders/registry.js';
import { aggregateOracleScores, youdenIndex } from '../src/oracle/types.js';
import { NotImplementedBenchmarkError } from '../src/benchmarks/types.js';

describe('json', () => {
  it('strips jsonc comments', () => {
    const parsed = JSON.parse(stripJsonComments('{ "a": 1, // comment\n "b": 2 }'));
    expect(parsed).toEqual({ a: 1, b: 2 });
  });
});

describe('repo-cve-smoke oracle', () => {
  const spec = {
    id: 't1',
    repo: 'owner/repo',
    vulnerableSha: 'abc',
    fixCommit: 'def',
    cve: 'CVE-2024-0001',
    changedPaths: ['lib/parser.js'],
  };

  it('scores true positive on location overlap', () => {
    const score = scoreFixCommitOverlap(spec, {
      confirmedFindings: [{ location: 'lib/parser.js:42', verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    });
    expect(score.truePositives).toBe(1);
  });

  it('scores false negative when no findings', () => {
    const score = scoreFixCommitOverlap(spec, {
      confirmedFindings: [],
      selfVerdictCounts: {},
      triageCounts: {},
    });
    expect(score.falseNegatives).toBe(1);
  });

  it('scores false positive on self-verdict without grader match', () => {
    const score = scoreFixCommitOverlap(spec, {
      confirmedFindings: [{ location: 'other/file.js', verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    });
    expect(score.falsePositives).toBe(1);
  });

  it('matches by CVE id', () => {
    const score = scoreFixCommitOverlap(spec, {
      confirmedFindings: [{ cve: 'CVE-2024-0001', verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    });
    expect(score.truePositives).toBe(1);
  });
});

describe('registry', () => {
  it('lists five benchmarks', () => {
    expect(listBenchmarks()).toHaveLength(5);
  });

  it('resolves repo-cve-smoke', () => {
    expect(resolveBenchmark('repo-cve-smoke').lane).toBe('dev-smoke');
  });

  it('stub benchmarks throw NotImplementedBenchmarkError', async () => {
    // bountybench, not cybergym: cybergym's setup()/listTasks()/standUpTarget() are real as of
    // superagent-ai/benchpress#16 (only score() is blocked) -- bountybench is the one benchmark
    // still fully stubbed at this point in the merge sequence.
    const adapter = resolveBenchmark('bountybench');
    await expect(adapter.setup()).rejects.toBeInstanceOf(NotImplementedBenchmarkError);
  });

  it('cve-bench is implemented, not stubbed', () => {
    const adapter = resolveBenchmark('cve-bench');
    expect(adapter.lane).toBe('scientific');
    expect(BENCHMARK_CAPABILITY_DEPENDENCIES['cve-bench']).toBeUndefined();
  });

  it('documents capability dependencies for scientific benchmarks', () => {
    expect(BENCHMARK_CAPABILITY_DEPENDENCIES['cybergym']).toContain('PoC-generation');
    expect(BENCHMARK_CAPABILITY_DEPENDENCIES['repo-cve-smoke']).toContain('dev-smoke');
  });
});

describe('contenders', () => {
  it('derives autobrin contender ids from ref', () => {
    expect(contenderIdFromConfig({ type: 'autobrin', ref: 'main' })).toBe('autobrin@main');
  });

  it('creates autobrin runner', () => {
    const runner = createContender({ id: 'autobrin@staging', type: 'autobrin', ref: 'staging' });
    expect(runner.type).toBe('autobrin');
    expect(runner.id).toBe('autobrin@staging');
  });
});

describe('oracle aggregation', () => {
  it('aggregates scores and computes youden', () => {
    const total = aggregateOracleScores([
      { truePositives: 2, falsePositives: 0, falseNegatives: 0, trueNegatives: 1, signals: [] },
      { truePositives: 1, falsePositives: 0, falseNegatives: 1, trueNegatives: 2, signals: [] },
    ]);
    expect(total.truePositives).toBe(3);
    expect(youdenIndex(total)).toBeGreaterThan(0);
  });
});
