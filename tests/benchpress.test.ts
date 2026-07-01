import { describe, expect, it } from 'vitest';
import { stripJsonComments } from '../src/lib/json.js';
import { repoCveSmokeAdapter, scoreFixCommitOverlap } from '../src/benchmarks/repo-cve-smoke/adapter.js';
import { resolveBenchmark, listBenchmarks, BENCHMARK_CAPABILITY_DEPENDENCIES } from '../src/benchmarks/registry.js';
import { createContender, contenderIdFromConfig } from '../src/contenders/registry.js';
import { aggregateOracleScores, youdenIndex } from '../src/oracle/types.js';

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

// Regression coverage for superagent-ai/benchpress#27: the shipped task data itself (not just the
// generic scoring function above) previously pointed fixCommit at a README-only deprecation
// commit that never touched changedPaths, so every score was either an impossible false_positive
// or a coincidental true_positive. These checks catch the same class of data-entry mistake
// without needing network access to re-fetch the real commit from GitHub.
describe('repo-cve-smoke tasks.jsonc', () => {
  it('lists tasks with internally consistent CVE/commit/path metadata', async () => {
    const tasks = await repoCveSmokeAdapter.listTasks();
    expect(tasks.length).toBeGreaterThan(0);

    for (const task of tasks) {
      const spec = task.metadata as { cve: string; fixCommit: string; vulnerableSha: string; changedPaths: string[] };
      expect(spec.cve).toMatch(/^CVE-\d{4}-\d+$/);
      expect(spec.fixCommit).toMatch(/^[0-9a-f]{40}$/i);
      expect(spec.vulnerableSha.trim()).not.toBe('');
      expect(spec.fixCommit).not.toBe(spec.vulnerableSha);
      expect(spec.changedPaths.length).toBeGreaterThan(0);
      for (const changedPath of spec.changedPaths) {
        expect(changedPath.trim()).not.toBe('');
      }
    }
  });

  it('pins the verified sanitize-html CVE-2024-21501 fix, not the old README-only deprecation commit', async () => {
    const tasks = await repoCveSmokeAdapter.listTasks();
    const task = tasks.find((t) => t.id === 'sanitize-html-cve-2024-21501');
    const spec = task?.metadata as { fixCommit: string; vulnerableSha: string; changedPaths: string[] } | undefined;

    expect(spec).toBeDefined();
    // apostrophecms/sanitize-html@c5dbdf7 merges PR #650 ("fix: ignore source maps when
    // processing with postcss"), cited by both GHSA-rm97-x556-q36h and NVD as the fix for
    // CVE-2024-21501; verified locally to land in 2.12.1 and be absent from 2.11.0.
    expect(spec?.fixCommit).toBe('c5dbdf77fe8b836d3bf4554ea39edb45281ec0b4');
    expect(spec?.vulnerableSha).toBe('2.11.0');
    expect(spec?.changedPaths).toContain('index.js');
  });
});

describe('registry', () => {
  it('lists five benchmarks', () => {
    expect(listBenchmarks()).toHaveLength(5);
  });

  it('resolves repo-cve-smoke', () => {
    expect(resolveBenchmark('repo-cve-smoke').lane).toBe('dev-smoke');
  });

  it('cve-bench is implemented, not stubbed', () => {
    const adapter = resolveBenchmark('cve-bench');
    expect(adapter.lane).toBe('scientific');
    expect(BENCHMARK_CAPABILITY_DEPENDENCIES['cve-bench']).toBeUndefined();
  });

  it('cybergym is implemented for autobrin contenders, not stubbed (fixes #29)', () => {
    const adapter = resolveBenchmark('cybergym');
    expect(adapter.lane).toBe('scientific');
    expect(BENCHMARK_CAPABILITY_DEPENDENCIES['cybergym']).toBeUndefined();
  });

  it('owasp is implemented, not stubbed (superagent-ai/benchpress#30)', () => {
    const adapter = resolveBenchmark('owasp');
    expect(adapter.lane).toBe('scientific');
    expect(BENCHMARK_CAPABILITY_DEPENDENCIES['owasp']).toBeUndefined();
  });

  it('bountybench is implemented (Detect/Exploit/Patch lanes all real), not stubbed (fixes #31)', () => {
    // Reconciling superagent-ai/benchpress#20 with #21 (cve-bench) retired the last
    // `stubAdapter()` user: bountybench's setup()/listTasks()/standUpTarget() were already real
    // before detect-only mode merged. #33 wired Detect (ground-truth mapping, no verifier needed)
    // and Patch (real post-patch verifier, autobrin-only by design) lane scoring on top of that,
    // so no registered benchmark blocks on a missing autobrin-flue capability anymore -- there is
    // no "the stub" left to single out here. See BENCHMARK_CAPABILITY_DEPENDENCIES and
    // src/benchmarks/bountybench/README.md.
    const adapter = resolveBenchmark('bountybench');
    expect(adapter.lane).toBe('scientific');
    expect(adapter.isScoreable).toBeTypeOf('function');
    expect(BENCHMARK_CAPABILITY_DEPENDENCIES['bountybench']).toBeUndefined();
  });

  it('documents capability dependencies for scientific benchmarks', () => {
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
