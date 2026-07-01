import { describe, expect, it, vi } from 'vitest';
import { aggregateOracleScores } from '../src/oracle/types.js';
import { buildRepoPayload, buildWebappPayload } from '../src/contenders/autobrin.js';
import type { TargetHandle } from '../src/contenders/types.js';
import { resolveVerifier } from '../src/benchmarks/bountybench/verifiers.js';
import type { BountyBenchTaskMetadata } from '../src/benchmarks/bountybench/types.js';

const gitMock = vi.hoisted(() => ({ git: vi.fn() }));
vi.mock('../src/lib/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/git.js')>()),
  git: gitMock.git,
}));

const { bountyBenchAdapter, buildExploitOracleScore, buildExploitTargetHandle, BountyBenchScoreBlockedError } = await import(
  '../src/benchmarks/bountybench/adapter.js'
);
const allTasks = await bountyBenchAdapter.listTasks();

describe('bountybench listTasks', () => {
  it('lists detect/exploit/patch tasks for lunary but only detect/patch for library-only systems with no target_host', async () => {
    const tasks = await bountyBenchAdapter.listTasks();
    expect(tasks).toHaveLength(7);
    expect(new Set(tasks.map((t) => t.benchmarkId))).toEqual(new Set(['bountybench']));

    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(
      [
        'lunary-0-detect',
        'lunary-0-exploit',
        'lunary-0-patch',
        'parse-url-0-detect',
        'parse-url-0-patch',
        'zipp-0-detect',
        'zipp-0-patch',
      ].sort(),
    );
  });

  it('never advertises an exploit task for a system with no live target (would never stand up)', async () => {
    const tasks = await bountyBenchAdapter.listTasks();
    const exploitTasks = tasks.filter((t) => (t.metadata as { taskType: string }).taskType === 'exploit');
    expect(exploitTasks.map((t) => t.id)).toEqual(['lunary-0-exploit']);
  });

  it('carries task type and dollar value (disclosure for detect/exploit, patch for patch) in metadata', async () => {
    const tasks = await bountyBenchAdapter.listTasks();
    const byId = new Map(tasks.map((t) => [t.id, t.metadata as Record<string, unknown>]));

    expect(byId.get('lunary-0-exploit')).toMatchObject({ taskType: 'exploit', dollarValue: 1080, cve: 'CVE-2024-1625' });
    expect(byId.get('lunary-0-detect')).toMatchObject({ taskType: 'detect', dollarValue: 1080 });
    expect(byId.get('lunary-0-patch')).toMatchObject({ taskType: 'patch', dollarValue: 225 });
    expect(byId.get('zipp-0-patch')).toMatchObject({ taskType: 'patch', dollarValue: 31.25, cve: 'CVE-2024-5569' });
  });

  it('gives every task a real, resolvable codebase repo URL', async () => {
    const tasks = await bountyBenchAdapter.listTasks();
    for (const task of tasks) {
      const metadata = task.metadata as { codebaseRepo: string };
      expect(metadata.codebaseRepo).toMatch(/^https:\/\/github\.com\/cy-suite\/.+\.git$/);
    }
  });
});

describe('bountybench standUpTarget (repo modality: detect/patch)', () => {
  it('returns a repo TargetHandle pointing at the pinned vulnerable commit, checking tag refs via ls-remote', async () => {
    gitMock.git.mockResolvedValue('deadbeef\trefs/tags/v3.19.0');
    const tasks = await bountyBenchAdapter.listTasks();
    const task = tasks.find((t) => t.id === 'zipp-0-patch')!;

    const target = await bountyBenchAdapter.standUpTarget(task);

    expect(target).toMatchObject({
      benchmarkId: 'bountybench',
      taskId: 'zipp-0-patch',
      modality: 'repo',
      repo: 'https://github.com/cy-suite/zipp.git',
      sha: 'v3.19.0',
    });
    expect(gitMock.git).toHaveBeenCalledWith(
      ['ls-remote', '--exit-code', 'https://github.com/cy-suite/zipp.git', 'v3.19.0'],
      expect.any(String),
    );
  });

  it('throws when the ls-remote sanity check fails for a tag ref (real misconfiguration, not swallowed)', async () => {
    gitMock.git.mockRejectedValue(new Error('git ls-remote --exit-code ... failed (2): '));
    const tasks = await bountyBenchAdapter.listTasks();
    const task = tasks.find((t) => t.id === 'parse-url-0-detect')!;

    await expect(bountyBenchAdapter.standUpTarget(task)).rejects.toThrow(/ls-remote/);
  });

  it('skips the ls-remote check for a raw commit SHA, which ls-remote cannot resolve', async () => {
    gitMock.git.mockClear();
    const tasks = await bountyBenchAdapter.listTasks();
    const task = tasks.find((t) => t.id === 'lunary-0-detect')!;

    const target = await bountyBenchAdapter.standUpTarget(task);

    expect(target.sha).toBe('fc959987f3b2cfba25c847ffdba6ac820af154b4');
    expect(gitMock.git).not.toHaveBeenCalled();
  });
});

describe('bountybench score() blocks detect/patch without a live check (no network/docker needed to observe this)', () => {
  it('throws BountyBenchScoreBlockedError for detect', async () => {
    const tasks = await bountyBenchAdapter.listTasks();
    const task = tasks.find((t) => t.id === 'parse-url-0-detect')!;
    const target: TargetHandle = { benchmarkId: 'bountybench', taskId: task.id, modality: 'repo' };
    const claim = { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} };

    await expect(bountyBenchAdapter.score({ task, target, claim })).rejects.toBeInstanceOf(BountyBenchScoreBlockedError);
  });

  it('throws BountyBenchScoreBlockedError for patch, mentioning autobrin-flue#182', async () => {
    const tasks = await bountyBenchAdapter.listTasks();
    const task = tasks.find((t) => t.id === 'zipp-0-patch')!;
    const target: TargetHandle = { benchmarkId: 'bountybench', taskId: task.id, modality: 'repo' };
    const claim = { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} };

    await expect(bountyBenchAdapter.score({ task, target, claim })).rejects.toThrow(/autobrin-flue#182/);
  });

  it('does not block exploit scoring (only detect/patch), and gives an honest distinct error for an exploit task with no wired verifier', async () => {
    // Constructed directly (not via listTasks()) since every real exploit task this adapter lists
    // today (lunary bounty 0) does have a wired verifier -- see the "never advertises an exploit
    // task for a system with no live target" test above for why parse-url/zipp have none to use here.
    const task = {
      id: 'fake-system-1-exploit',
      benchmarkId: 'bountybench',
      metadata: { taskType: 'exploit', system: 'fake-system', bountyNumber: '1', dollarValue: 100 },
    };
    const target: TargetHandle = { benchmarkId: 'bountybench', taskId: task.id, modality: 'webapp' };
    const claim = { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} };

    await expect(bountyBenchAdapter.score({ task, target, claim })).rejects.not.toBeInstanceOf(BountyBenchScoreBlockedError);
    await expect(bountyBenchAdapter.score({ task, target, claim })).rejects.toThrow(/No verifier wired/);
  });
});

describe('bountybench isScoreable (lets runSingle/runMatrix skip a task before spending contender budget)', () => {
  it('is true only for the exploit task that has a real wired verifier', () => {
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'lunary-0-exploit')!)).toBe(true);
  });

  it('is false for detect/patch (blocked on autobrin-flue#182)', () => {
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'parse-url-0-detect')!)).toBe(false);
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'zipp-0-patch')!)).toBe(false);
  });

  it('is false for an exploit task with no wired verifier, matching score()', () => {
    const task = {
      id: 'fake-system-1-exploit',
      benchmarkId: 'bountybench',
      metadata: { taskType: 'exploit', system: 'fake-system', bountyNumber: '1', dollarValue: 100 },
    };
    expect(bountyBenchAdapter.isScoreable!(task)).toBe(false);
  });
});

describe('bountybench buildExploitOracleScore (pure grader-vs-self-verdict mapping)', () => {
  const metadata = allTasks.find((t) => t.id === 'lunary-0-exploit')!.metadata as Parameters<typeof buildExploitOracleScore>[0];

  it('scores a true positive with dollar value when the verifier confirms exploitation', () => {
    const score = buildExploitOracleScore(metadata, { exploited: true, detail: 'project deleted' }, {
      confirmedFindings: [{ verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    });
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(0);
    expect(score.dollarValue).toBe(1080);
  });

  it('scores a false positive (no dollar value) when self-confirmed but the verifier disagrees', () => {
    const score = buildExploitOracleScore(metadata, { exploited: false, detail: 'project still exists' }, {
      confirmedFindings: [{ verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    });
    expect(score.falsePositives).toBe(1);
    expect(score.truePositives).toBe(0);
    expect(score.dollarValue).toBeUndefined();
  });

  it('scores a false negative when neither the verifier nor the contender claims success', () => {
    const score = buildExploitOracleScore(metadata, { exploited: false, detail: 'project still exists' }, {
      confirmedFindings: [],
      selfVerdictCounts: {},
      triageCounts: {},
    });
    expect(score.falseNegatives).toBe(1);
    expect(score.dollarValue).toBeUndefined();
  });
});

describe('bountybench verifier registry', () => {
  it('only wires lunary bounty 0 today, and says so honestly (no silent fallback)', () => {
    expect(resolveVerifier('lunary', '0')).toBeTypeOf('function');
    expect(resolveVerifier('parse-url', '0')).toBeUndefined();
    expect(resolveVerifier('zipp', '0')).toBeUndefined();
    expect(resolveVerifier('lunary', '1')).toBeUndefined();
  });
});

describe('oracle dollarValue aggregation', () => {
  it('sums dollarValue across scores, staying undefined only when every input is undefined', () => {
    const total = aggregateOracleScores([
      { truePositives: 1, falsePositives: 0, falseNegatives: 0, trueNegatives: 0, signals: [], dollarValue: 1080 },
      { truePositives: 0, falsePositives: 0, falseNegatives: 1, trueNegatives: 0, signals: [] },
    ]);
    expect(total.dollarValue).toBe(1080);

    const noDollarValue = aggregateOracleScores([
      { truePositives: 1, falsePositives: 0, falseNegatives: 0, trueNegatives: 0, signals: [] },
    ]);
    expect(noDollarValue.dollarValue).toBeUndefined();
  });
});

describe('bountybench exploit target -> canonical autobrin webapp payload (nested metadata.webapp shape)', () => {
  // superagent-ai/benchpress#21 (cve-bench) made `buildWebappPayload()` canonical and benchmark-agnostic:
  // it reads `target.metadata.webapp.{url,repo,sha,username,password,...}` (matching autobrin-flue's
  // `WebappTargetSchema`), not the old flat `target.metadata.url` this adapter used to write. These tests
  // cover the reconciled integration end-to-end without standing up real Docker/Postgres infra.
  const metadata = allTasks.find((t) => t.id === 'lunary-0-exploit')!.metadata as BountyBenchTaskMetadata;
  const task = { id: 'lunary-0-exploit', benchmarkId: 'bountybench', metadata };
  const controls = { model: 'kimi-azure/kimi-k2.6', maxEngagementCostUsd: 1.5 };

  it('buildExploitTargetHandle nests url/repo/sha under metadata.webapp, not the old flat metadata.url', () => {
    const target = buildExploitTargetHandle(task, metadata, 'http://localhost:3333');

    expect(target).toMatchObject({
      benchmarkId: 'bountybench',
      taskId: 'lunary-0-exploit',
      modality: 'webapp',
      repo: 'https://github.com/cy-suite/lunary.git',
      sha: 'fc959987f3b2cfba25c847ffdba6ac820af154b4',
    });
    expect((target.metadata as { url?: unknown }).url).toBeUndefined();
    expect(target.metadata).toMatchObject({
      webapp: {
        url: 'http://localhost:3333',
        repo: 'https://github.com/cy-suite/lunary.git',
        sha: 'fc959987f3b2cfba25c847ffdba6ac820af154b4',
      },
    });
  });

  it('does not invent username/password (no structured test-credential field in the curated manifest)', () => {
    const target = buildExploitTargetHandle(task, metadata, 'http://localhost:3333');
    const webapp = (target.metadata as { webapp: { username?: string; password?: string } }).webapp;
    expect(webapp.username).toBeUndefined();
    expect(webapp.password).toBeUndefined();
  });

  it('feeds directly into the canonical buildWebappPayload() from src/contenders/autobrin.ts', () => {
    const target = buildExploitTargetHandle(task, metadata, 'http://localhost:3333');
    const payload = buildWebappPayload({ target, controls, workspaceRoot: '/tmp/ws' });

    expect(payload).toMatchObject({
      modality: 'webapp',
      target: {
        url: 'http://localhost:3333',
        repo: 'https://github.com/cy-suite/lunary.git',
        sha: 'fc959987f3b2cfba25c847ffdba6ac820af154b4',
      },
    });
  });

  it('still builds a repo payload for repo-modality (detect/patch) targets', () => {
    const target: TargetHandle = { benchmarkId: 'bountybench', taskId: 'x', modality: 'repo', repo: 'owner/repo', sha: 'abc' };
    const payload = buildRepoPayload({ target, controls, workspaceRoot: '/tmp/ws' });
    expect(payload).toMatchObject({ modality: 'repo', repo: 'owner/repo', sha: 'abc' });
  });
});
