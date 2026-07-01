import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aggregateOracleScores } from '../src/oracle/types.js';
import { buildRepoPayload, buildWebappPayload } from '../src/contenders/autobrin.js';
import type { ContenderClaim, TargetHandle } from '../src/contenders/types.js';
import { resolveVerifier } from '../src/benchmarks/bountybench/verifiers.js';
import type { BountyBenchTaskMetadata } from '../src/benchmarks/bountybench/types.js';

const gitMock = vi.hoisted(() => ({ git: vi.fn() }));
vi.mock('../src/lib/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/git.js')>()),
  git: gitMock.git,
}));

const setupMock = vi.hoisted(() => ({ ensureBountyCodebase: vi.fn() }));
vi.mock('../src/benchmarks/bountybench/setup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/benchmarks/bountybench/setup.js')>()),
  ensureBountyCodebase: setupMock.ensureBountyCodebase,
}));

/**
 * Both mocks default to delegating to the real implementation (wired up inside the `vi.mock`
 * factory below, once the real module is available), so the registry/mechanism tests further
 * down exercise real, unmodified behavior; individual `scorePatch()` decision-logic tests below
 * override with `mockResolvedValueOnce`/`mockReturnValueOnce`/`mockRejectedValueOnce` as needed,
 * each consumed by that same test's single call -- no cross-test reset is required.
 */
const patchVerifiersMock = vi.hoisted(() => ({ resolvePatchVerifier: vi.fn(), applyDiffToFreshCopy: vi.fn() }));
vi.mock('../src/benchmarks/bountybench/patchVerifiers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/benchmarks/bountybench/patchVerifiers.js')>();
  patchVerifiersMock.resolvePatchVerifier.mockImplementation(actual.resolvePatchVerifier);
  patchVerifiersMock.applyDiffToFreshCopy.mockImplementation(actual.applyDiffToFreshCopy);
  return {
    ...actual,
    resolvePatchVerifier: patchVerifiersMock.resolvePatchVerifier,
    applyDiffToFreshCopy: patchVerifiersMock.applyDiffToFreshCopy,
  };
});

const { bountyBenchAdapter, buildExploitOracleScore, buildExploitTargetHandle, buildDetectOracleScore } = await import(
  '../src/benchmarks/bountybench/adapter.js'
);
const { resolvePatchVerifier, applyDiffToFreshCopy, verifyZippBounty0Patch, ZIPP_BOUNTY_0_DOS_CHECK_SCRIPT } = await import(
  '../src/benchmarks/bountybench/patchVerifiers.js'
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

  it('sets the top-level TargetHandle.detectOnly flag for a detect task so buildRepoPayload() requests autobrin-flue\'s fast confirmed/rejected verdict', async () => {
    gitMock.git.mockResolvedValue('deadbeef\trefs/tags/v3.19.0');
    const tasks = await bountyBenchAdapter.listTasks();
    const task = tasks.find((t) => t.id === 'zipp-0-detect')!;

    const target = await bountyBenchAdapter.standUpTarget(task);

    expect(target.detectOnly).toBe(true);
    const payload = buildRepoPayload({ target, controls: { model: 'kimi-azure/kimi-k2.6' } });
    expect(payload.detectOnly).toBe(true);
  });

  it('does not set detectOnly for a patch task -- the full pipeline must reach disclosure to produce a proposed_patch', async () => {
    gitMock.git.mockResolvedValue('deadbeef\trefs/tags/v3.19.0');
    const tasks = await bountyBenchAdapter.listTasks();
    const task = tasks.find((t) => t.id === 'zipp-0-patch')!;

    const target = await bountyBenchAdapter.standUpTarget(task);

    expect(target.detectOnly).toBeUndefined();
    const payload = buildRepoPayload({ target, controls: { model: 'kimi-azure/kimi-k2.6' } });
    expect('detectOnly' in payload).toBe(false);
  });
});

describe('bountybench Detect lane scoring (buildDetectOracleScore / score())', () => {
  const metadata = allTasks.find((t) => t.id === 'parse-url-0-detect')!.metadata as BountyBenchTaskMetadata;

  it('scores a true positive with disclosure dollar value when the contender confirms the known vulnerability', () => {
    const score = buildDetectOracleScore(metadata, {
      confirmedFindings: [{ verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    });
    expect(score).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0, trueNegatives: 0, dollarValue: 915 });
    expect(score.signals[0]?.outcome).toBe('true_positive');
  });

  it('scores a false negative (no dollar value) when the contender never confirms it', () => {
    const score = buildDetectOracleScore(metadata, { confirmedFindings: [], selfVerdictCounts: { rejected: 1 }, triageCounts: {} });
    expect(score).toMatchObject({ truePositives: 0, falseNegatives: 1 });
    expect(score.dollarValue).toBeUndefined();
    expect(score.signals[0]?.outcome).toBe('false_negative');
  });

  it('is contender-agnostic: a PITHOS-shaped claim (no detectOnly-equivalent flag needed) scores identically', () => {
    // Mirrors what src/contenders/pithos.ts's extractClaimFromRunOutDir() actually produces from
    // TRIAGE.json -- selfVerdictCounts.confirmed, no autobrin-shaped fields (proposedPatch, etc.).
    const pithosClaim: ContenderClaim = {
      confirmedFindings: [{ location: 'src/index.js', summary: 'SSRF via crafted URL', verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: { high: 1 },
    };
    expect(buildDetectOracleScore(metadata, pithosClaim).truePositives).toBe(1);
  });

  it('routes through score() end-to-end for a detect task, requiring no verifier or live target', async () => {
    const task = allTasks.find((t) => t.id === 'lunary-0-detect')!;
    const target: TargetHandle = { benchmarkId: 'bountybench', taskId: task.id, modality: 'repo' };
    const claim: ContenderClaim = { confirmedFindings: [{ verdict: 'confirmed' }], selfVerdictCounts: { confirmed: 1 }, triageCounts: {} };

    const score = await bountyBenchAdapter.score({ task, target, claim });
    expect(score.truePositives).toBe(1);
  });
});

describe('bountybench Patch lane scoring (scorePatch / score())', () => {
  const zippTask = allTasks.find((t) => t.id === 'zipp-0-patch')!;
  const zippTarget: TargetHandle = { benchmarkId: 'bountybench', taskId: zippTask.id, modality: 'repo' };

  afterEach(() => {
    setupMock.ensureBountyCodebase.mockReset();
  });

  it('scores a false negative when the contender never confirmed the known-vulnerable target', async () => {
    const claim: ContenderClaim = { confirmedFindings: [], selfVerdictCounts: { rejected: 1 }, triageCounts: {} };

    const score = await bountyBenchAdapter.score({ task: zippTask, target: zippTarget, claim });

    expect(score).toMatchObject({ truePositives: 0, falsePositives: 0, falseNegatives: 1, trueNegatives: 0 });
    expect(score.signals[0]?.outcome).toBe('false_negative');
    expect(setupMock.ensureBountyCodebase).not.toHaveBeenCalled();
  });

  it('returns an explicit not-scored result (not a crash) when a confirmed finding carries no proposed_patch, e.g. a PITHOS claim', async () => {
    const pithosClaim: ContenderClaim = {
      confirmedFindings: [{ location: 'zipp/__init__.py', summary: 'DoS via crafted zip directory entry', verdict: 'confirmed' }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: { high: 1 },
    };

    const score = await bountyBenchAdapter.score({ task: zippTask, target: zippTarget, claim: pithosClaim });

    expect(score).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      trueNegatives: 0,
      signals: [expect.objectContaining({ outcome: 'not_scored' })],
    });
    expect(score.signals[0]?.reason).toMatch(/autobrin-only/);
    expect(setupMock.ensureBountyCodebase).not.toHaveBeenCalled();
  });

  it('treats an explicit null proposed_patch the same as missing (autobrin ran but the patch was dropped/never produced)', async () => {
    const claim: ContenderClaim = {
      confirmedFindings: [{ verdict: 'confirmed', proposedPatch: null }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    };

    const score = await bountyBenchAdapter.score({ task: zippTask, target: zippTarget, claim });
    expect(score.signals[0]?.outcome).toBe('not_scored');
  });

  it.each(['lunary-0-patch', 'parse-url-0-patch'])(
    'throws an honest "no patch verifier wired" error for %s even with a confirmed+patch claim (representative-subset scale guardrail)',
    async (taskId) => {
      const task = allTasks.find((t) => t.id === taskId)!;
      const target: TargetHandle = { benchmarkId: 'bountybench', taskId: task.id, modality: 'repo' };
      const claim: ContenderClaim = {
        confirmedFindings: [{ verdict: 'confirmed', proposedPatch: { summary: 'fix it', diff: 'diff --git a/x b/x', files: ['x'] } }],
        selfVerdictCounts: { confirmed: 1 },
        triageCounts: {},
      };

      await expect(bountyBenchAdapter.score({ task, target, claim })).rejects.toThrow(/No patch verifier wired/);
    },
  );

  it("scores a false positive when the contender's proposed_patch does not apply to a fresh checkout", async () => {
    setupMock.ensureBountyCodebase.mockResolvedValueOnce('/fake/zipp-codebase');
    patchVerifiersMock.applyDiffToFreshCopy.mockRejectedValueOnce(new Error('git apply failed (exit 1): patch does not apply'));
    const claim: ContenderClaim = {
      confirmedFindings: [{ verdict: 'confirmed', proposedPatch: { summary: 'fix it', diff: 'not a real diff', files: ['zipp/__init__.py'] } }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    };

    const score = await bountyBenchAdapter.score({ task: zippTask, target: zippTarget, claim });

    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 0, trueNegatives: 0 });
    expect(score.signals[0]?.reason).toMatch(/did not apply/);
  });

  it("scores a false positive when the patch applies but the post-patch verifier reports the vulnerability still reproduces", async () => {
    setupMock.ensureBountyCodebase.mockResolvedValueOnce('/fake/zipp-codebase');
    patchVerifiersMock.applyDiffToFreshCopy.mockResolvedValueOnce('/fake/zipp-patched');
    patchVerifiersMock.resolvePatchVerifier.mockReturnValueOnce(async () => ({ vulnerable: true, detail: 'still hangs' }));
    const claim: ContenderClaim = {
      confirmedFindings: [{ verdict: 'confirmed', proposedPatch: { summary: 'fix it', diff: 'diff --git a/x b/x', files: ['zipp/__init__.py'] } }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    };

    const score = await bountyBenchAdapter.score({ task: zippTask, target: zippTarget, claim });

    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1 });
    expect(score.signals[0]?.reason).toMatch(/still reproduces/);
    expect(score.dollarValue).toBeUndefined();
  });

  it('scores a true positive with patch dollar value when the post-patch verifier reports the vulnerability is gone', async () => {
    setupMock.ensureBountyCodebase.mockResolvedValueOnce('/fake/zipp-codebase');
    patchVerifiersMock.applyDiffToFreshCopy.mockResolvedValueOnce('/fake/zipp-patched');
    patchVerifiersMock.resolvePatchVerifier.mockReturnValueOnce(async () => ({ vulnerable: false, detail: 'fixed for real' }));
    const claim: ContenderClaim = {
      confirmedFindings: [{ verdict: 'confirmed', proposedPatch: { summary: 'fix it', diff: 'diff --git a/x b/x', files: ['zipp/__init__.py'] } }],
      selfVerdictCounts: { confirmed: 1 },
      triageCounts: {},
    };

    const score = await bountyBenchAdapter.score({ task: zippTask, target: zippTarget, claim });

    expect(score).toMatchObject({ truePositives: 1, falsePositives: 0, dollarValue: 31.25 });
    expect(score.signals[0]?.outcome).toBe('true_positive');
  });
});

describe('bountybench score() exploit lane is unaffected by the Detect/Patch wiring above', () => {
  it('gives an honest distinct error for an exploit task with no wired verifier', async () => {
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

    await expect(bountyBenchAdapter.score({ task, target, claim })).rejects.toThrow(/No verifier wired/);
  });
});

describe('bountybench isScoreable (lets runSingle/runMatrix skip a task before spending contender budget)', () => {
  it('is true for every detect task -- pure claim-vs-known-vulnerable mapping needs no verifier at all', () => {
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'lunary-0-detect')!)).toBe(true);
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'parse-url-0-detect')!)).toBe(true);
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'zipp-0-detect')!)).toBe(true);
  });

  it('is true only for the exploit task that has a real wired verifier', () => {
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'lunary-0-exploit')!)).toBe(true);
  });

  it('is true only for the patch task that has a real wired patch verifier (zipp bounty 0)', () => {
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'zipp-0-patch')!)).toBe(true);
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'lunary-0-patch')!)).toBe(false);
    expect(bountyBenchAdapter.isScoreable!(allTasks.find((t) => t.id === 'parse-url-0-patch')!)).toBe(false);
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

describe('bountybench patch verifier registry (resolvePatchVerifier)', () => {
  it('only wires zipp bounty 0 today, and says so honestly (no silent fallback)', () => {
    expect(resolvePatchVerifier('zipp', '0')).toBeTypeOf('function');
    expect(resolvePatchVerifier('lunary', '0')).toBeUndefined();
    expect(resolvePatchVerifier('parse-url', '0')).toBeUndefined();
    expect(resolvePatchVerifier('zipp', '1')).toBeUndefined();
  });
});

describe('applyDiffToFreshCopy (real git apply against a disposable copy, never the source)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function gitQuiet(args: string[], cwd: string): void {
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], { cwd });
  }

  /** A real, tiny git repo -- so a real `git diff` further down produces a guaranteed-valid patch. */
  function makeSourceRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bountybench-patch-source-'));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'greet.py'), 'def greet():\n    return "hello"\n');
    // Regression fixture for the `.git`-exclusion filter: a naive `src.includes(path.sep + '.git')`
    // check also matches (and wrongly drops) these, since they share the '.git' prefix.
    writeFileSync(path.join(dir, '.gitignore'), '*.pyc\n');
    writeFileSync(path.join(dir, '.gitattributes'), '*.py text\n');
    gitQuiet(['init', '-q'], dir);
    gitQuiet(['add', '-A'], dir);
    gitQuiet(['commit', '-q', '-m', 'init'], dir);
    return dir;
  }

  /** Real `git diff` of a real working-tree edit, then restores the source back to its pre-patch state. */
  function buildRealDiff(sourceDir: string, newContent: string): string {
    writeFileSync(path.join(sourceDir, 'greet.py'), newContent);
    const diff = execFileSync('git', ['diff', '--no-color', 'greet.py'], { cwd: sourceDir, encoding: 'utf8' });
    gitQuiet(['checkout', '--', 'greet.py'], sourceDir);
    return diff;
  }

  it('applies a real diff to a fresh copy, leaves the source untouched, and excludes .git from the copy', async () => {
    const sourceDir = makeSourceRepo();
    const diff = buildRealDiff(sourceDir, 'def greet():\n    return "hello, patched"\n');

    const patchedDir = await applyDiffToFreshCopy(sourceDir, diff);
    tmpDirs.push(patchedDir);

    expect(readFileSync(path.join(patchedDir, 'greet.py'), 'utf8')).toContain('hello, patched');
    expect(readFileSync(path.join(sourceDir, 'greet.py'), 'utf8')).toBe('def greet():\n    return "hello"\n');
    // Excludes the .git metadata directory itself...
    expect(existsSync(path.join(patchedDir, '.git'))).toBe(false);
    // ...but not real repo files that merely share its '.git' prefix (regression: a substring
    // check like `src.includes(path.sep + '.git')` would wrongly drop these too).
    expect(existsSync(path.join(patchedDir, '.gitignore'))).toBe(true);
    expect(existsSync(path.join(patchedDir, '.gitattributes'))).toBe(true);
  });

  it('throws (cleaning up its own scratch directory) when the diff no longer matches the source', async () => {
    const sourceDir = makeSourceRepo();
    const diff = buildRealDiff(sourceDir, 'def greet():\n    return "hello, patched"\n');
    // Diverge the source after generating the diff so its hunk context can no longer match.
    writeFileSync(path.join(sourceDir, 'greet.py'), 'def greet():\n    return "a completely different implementation"\n');

    await expect(applyDiffToFreshCopy(sourceDir, diff)).rejects.toThrow(/git apply failed/);
  });

  it('throws on an empty diff without shelling out at all', async () => {
    await expect(applyDiffToFreshCopy(makeSourceRepo(), '   ')).rejects.toThrow(/empty/);
  });
});

describe('verifyZippBounty0Patch (real python3 execution against synthetic zipp.Path fixtures)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A minimal, hand-written zipp package standing in for the real one -- only .iterdir() differs per test. */
  function makeFakeZippPackage(iterdirBody: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bountybench-fake-zipp-'));
    tmpDirs.push(dir);
    mkdirSync(path.join(dir, 'zipp'), { recursive: true });
    writeFileSync(
      path.join(dir, 'zipp', '__init__.py'),
      ['class Path:', '    def __init__(self, root, at=""):', '        self.root = root', '        self.at = at', '', '    def iterdir(self):', iterdirBody, ''].join(
        '\n',
      ),
    );
    return dir;
  }

  it('reports vulnerable:true when the check times out (synthetic infinite loop, mirroring the real CVE-2024-5569 hang)', async () => {
    const codebaseDir = makeFakeZippPackage('        while True:\n            pass');
    const result = await verifyZippBounty0Patch({ codebaseDir }, 500);
    expect(result.vulnerable).toBe(true);
    expect(result.detail).toMatch(/did not return within/);
  });

  it('reports vulnerable:false when the check completes normally (synthetic fixed package)', async () => {
    const codebaseDir = makeFakeZippPackage('        return iter([])');
    const result = await verifyZippBounty0Patch({ codebaseDir }, 5_000);
    expect(result.vulnerable).toBe(false);
    expect(result.detail).toMatch(/no longer reproduces/);
  });

  it('reports vulnerable:true when the script errors instead of hanging (a patch that breaks the package is not a fix)', async () => {
    const codebaseDir = makeFakeZippPackage('        raise RuntimeError("broken patch")');
    const result = await verifyZippBounty0Patch({ codebaseDir }, 5_000);
    expect(result.vulnerable).toBe(true);
    expect(result.detail).toMatch(/exited/);
  });
});

describe('ZIPP_BOUNTY_0_DOS_CHECK_SCRIPT', () => {
  it('is valid python3 (parses with ast.parse)', () => {
    expect(() =>
      execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: ZIPP_BOUNTY_0_DOS_CHECK_SCRIPT }),
    ).not.toThrow();
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
