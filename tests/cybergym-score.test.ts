import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedResult, TargetHandle } from '../src/contenders/types.js';
import { runCommand } from '../src/lib/git.js';
import type { CyberGymTargetMetadata } from '../src/benchmarks/cybergym/adapter.js';
import type { CyberGymTaskSpec } from '../src/benchmarks/cybergym/types.js';

vi.mock('../src/lib/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/git.js')>();
  return { ...actual, runCommand: vi.fn() };
});

vi.mock('../src/lib/checkout.js', () => ({
  ensureAutobrinCheckout: vi.fn(async () => ({ root: '/fake/autobrin-root', ref: 'staging', commitSha: 'deadbeef' })),
}));

const {
  findConfirmedAttempts,
  resolveFixCommitSha,
  runDifferentialOracleCli,
  scoreCyberGymClaim,
} = await import('../src/benchmarks/cybergym/score.js');

const mockedRunCommand = vi.mocked(runCommand);

/** Real 40-char hex SHAs so resolveFixCommitSha's own shape validation passes. */
const FIX_SHA = 'a'.repeat(40);

/** Dispatches by (command, first-few-args) so call order inside score.ts can change without breaking every test. */
function fakeSubprocess(oracleStdout: string) {
  return async (command: string, args: string[] = []) => {
    if (command === 'docker' && args[0] === 'run' && args.includes('find')) {
      return { exitCode: 0, stdout: '/src/file/.git\n', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'create') {
      return { exitCode: 0, stdout: 'fake-container-id\n', stderr: '' };
    }
    if (command === 'docker' && (args[0] === 'cp' || args[0] === 'rm')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args.includes('rev-parse')) {
      return { exitCode: 0, stdout: `${FIX_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && (args.includes('init') || args.includes('remote'))) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'npm' && args[0] === 'install') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'npx') {
      return { exitCode: oracleStdout.includes('"confirmed"') ? 0 : 1, stdout: oracleStdout, stderr: '' };
    }
    throw new Error(`Unexpected runCommand(${command}, ${JSON.stringify(args)}) in test`);
  };
}

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  mockedRunCommand.mockReset();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeAttempt(
  workspaceDir: string,
  name: string,
  input: { verdict?: string; location?: string; cve?: string; summary?: string } = {},
): void {
  const dir = path.join(workspaceDir, 'attacks', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'evaluate.json'), JSON.stringify({ verdict: input.verdict ?? 'confirmed' }));
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ location: input.location, summary: input.summary }));
  writeFileSync(path.join(dir, 'disclosure.json'), JSON.stringify({ cve_id: input.cve }));
}

describe('findConfirmedAttempts', () => {
  it('returns only confirmed attempts, sorted, with report/disclosure fields merged in', async () => {
    const workspaceDir = makeTmpDir('cybergym-workspace-');
    writeAttempt(workspaceDir, '0002-second', { location: 'src/b.c', cve: 'CVE-2024-2' });
    writeAttempt(workspaceDir, '0001-first', { location: 'src/a.c', summary: 'heap overflow' });
    writeAttempt(workspaceDir, '0003-rejected', { verdict: 'rejected' });

    const attempts = await findConfirmedAttempts(workspaceDir);

    expect(attempts.map((a) => a.name)).toEqual(['0001-first', '0002-second']);
    expect(attempts[0]).toMatchObject({ location: 'src/a.c', summary: 'heap overflow' });
    expect(attempts[1]).toMatchObject({ location: 'src/b.c', cve: 'CVE-2024-2' });
  });

  it('returns an empty array when there is no attacks directory', async () => {
    const workspaceDir = makeTmpDir('cybergym-workspace-empty-');
    expect(await findConfirmedAttempts(workspaceDir)).toEqual([]);
  });
});

describe('resolveFixCommitSha', () => {
  it('extracts the fix commit HEAD via a throwaway container + host git, never running the image', async () => {
    mockedRunCommand.mockImplementation(fakeSubprocess('{}'));
    const sha = await resolveFixCommitSha('n132/arvo:1065-fix');
    expect(sha).toBe(FIX_SHA);

    const dockerCalls = mockedRunCommand.mock.calls.filter(([command]) => command === 'docker');
    expect(dockerCalls.map(([, args]) => args?.[0])).toEqual(['run', 'create', 'cp', 'rm']);
  });

  it('throws a clear error when no /src/*/.git is found in the image', async () => {
    mockedRunCommand.mockImplementation(async (command: string, args: string[] = []) => {
      if (command === 'docker' && args[0] === 'run') return { exitCode: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected call ${command} ${args.join(' ')}`);
    });
    await expect(resolveFixCommitSha('some/image:fix')).rejects.toThrow(/Could not find a git checkout/);
  });

  it('throws when the resolved HEAD does not look like a real commit sha, but still removes the throwaway container', async () => {
    mockedRunCommand.mockImplementation(async (command: string, args: string[] = []) => {
      if (command === 'docker' && args[0] === 'run' && args.includes('find')) return { exitCode: 0, stdout: '/src/file/.git\n', stderr: '' };
      if (command === 'docker' && args[0] === 'create') return { exitCode: 0, stdout: 'cid\n', stderr: '' };
      if (command === 'docker' && (args[0] === 'cp' || args[0] === 'rm')) return { exitCode: 0, stdout: '', stderr: '' };
      if (command === 'git') return { exitCode: 0, stdout: 'not-a-sha\n', stderr: '' };
      throw new Error(`unexpected call ${command} ${args.join(' ')}`);
    });
    await expect(resolveFixCommitSha('some/image:fix')).rejects.toThrow(/Unexpected "git rev-parse HEAD" output/);
    expect(mockedRunCommand).toHaveBeenCalledWith('docker', ['rm', 'cid']);
  });

  // Regression: the container is created before mkdtemp() runs, so its cleanup must be scoped
  // around mkdtemp() too, not just the copy/git steps that follow it.
  it('still removes the throwaway container if a step between docker create and cleanup throws', async () => {
    mockedRunCommand.mockImplementation(async (command: string, args: string[] = []) => {
      if (command === 'docker' && args[0] === 'run' && args.includes('find')) return { exitCode: 0, stdout: '/src/file/.git\n', stderr: '' };
      if (command === 'docker' && args[0] === 'create') return { exitCode: 0, stdout: 'cid-2\n', stderr: '' };
      if (command === 'docker' && args[0] === 'cp') return { exitCode: 1, stdout: '', stderr: 'no such file' };
      if (command === 'docker' && args[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected call ${command} ${args.join(' ')}`);
    });
    await expect(resolveFixCommitSha('some/image:fix')).rejects.toThrow(/docker cp cid-2/);
    expect(mockedRunCommand).toHaveBeenCalledWith('docker', ['rm', 'cid-2']);
  });
});

describe('runDifferentialOracleCli', () => {
  it('parses a confirmed verdict from the CLI JSON stdout', async () => {
    mockedRunCommand.mockImplementation(fakeSubprocess(JSON.stringify({ verdict: 'confirmed', reason: 'causal dependence confirmed' })));
    const result = await runDifferentialOracleCli({
      autobrinRoot: '/fake/autobrin-root',
      workspaceDir: '/fake/workspace',
      attackDir: '/fake/workspace/attacks/0001-x',
      fixRef: FIX_SHA,
    });
    expect(result).toEqual({
      verdict: 'confirmed',
      reason: 'causal dependence confirmed',
      raw: { verdict: 'confirmed', reason: 'causal dependence confirmed' },
    });
    const npxCall = mockedRunCommand.mock.calls.find(([command]) => command === 'npx')!;
    expect(npxCall[1]).toEqual([
      'tsx',
      'scripts/differential-oracle.mjs',
      '--workspace',
      '/fake/workspace',
      '--attack-dir',
      '/fake/workspace/attacks/0001-x',
      '--fix-ref',
      FIX_SHA,
      '--timeout-ms',
      '600000',
    ]);
    expect(npxCall[2]).toMatchObject({ cwd: '/fake/autobrin-root' });
  });

  it('throws instead of guessing a verdict when stdout is not valid JSON', async () => {
    mockedRunCommand.mockImplementation(fakeSubprocess('not json'));
    await expect(
      runDifferentialOracleCli({ autobrinRoot: '/fake/autobrin-root', workspaceDir: '/w', attackDir: '/w/attacks/0001-x', fixRef: FIX_SHA }),
    ).rejects.toThrow(/did not print valid JSON/);
  });

  it('throws instead of guessing a verdict when the JSON has no recognized verdict field', async () => {
    mockedRunCommand.mockImplementation(fakeSubprocess(JSON.stringify({ verdict: 'maybe' })));
    await expect(
      runDifferentialOracleCli({ autobrinRoot: '/fake/autobrin-root', workspaceDir: '/w', attackDir: '/w/attacks/0001-x', fixRef: FIX_SHA }),
    ).rejects.toThrow(/unexpected result shape/);
  });
});

function makeMetadata(overrides: Partial<CyberGymTargetMetadata> = {}, sourceDir: string): CyberGymTargetMetadata {
  const spec: CyberGymTaskSpec = {
    taskId: 'arvo:1065',
    taskType: 'arvo',
    upstreamId: '1065',
    projectName: 'file',
    projectMainRepo: 'https://github.com/file/file.git',
    projectLanguage: 'c++',
    vulnerabilityDescription: 'test',
    sanitizer: 'MemorySanitizer',
    crashType: 'use-of-uninitialized-value',
    difficulty: 'level1',
    hfDataDir: 'data/arvo/1065',
    repoVulSha256: 'a'.repeat(64),
    dockerRepo: 'n132/arvo',
    vulImageTag: '1065-vul',
    fixImageTag: '1065-fix',
    fuzzerBinary: 'magic_fuzzer',
  };
  return {
    ...spec,
    sourceDir,
    descriptionPath: path.join(sourceDir, '..', 'description.txt'),
    vulImage: { image: 'n132/arvo:1065-vul', imageId: 'sha256:vul' },
    fixImage: { image: 'n132/arvo:1065-fix', imageId: 'sha256:fix' },
    ...overrides,
  };
}

function makeTarget(metadata: CyberGymTargetMetadata): TargetHandle {
  return { benchmarkId: 'cybergym', taskId: metadata.taskId, modality: 'repo', repo: metadata.sourceDir, metadata };
}

function makeResult(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    contenderId: 'autobrin@staging',
    contenderType: 'autobrin',
    resolvedRef: 'staging',
    exitCode: 0,
    durationS: 1,
    costUsd: 0.1,
    costStatus: 'known',
    claim: { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} },
    ...overrides,
  };
}

describe('scoreCyberGymClaim', () => {
  it('returns an explicit excluded/not-scored result for a non-autobrin contender, never a crash or a fake pass/fail', async () => {
    const sourceDir = makeTmpDir('cybergym-source-');
    const target = makeTarget(makeMetadata({}, sourceDir));
    const result = makeResult({ contenderType: 'pithos', contenderId: 'pithos', workspaceDir: undefined });

    const score = await scoreCyberGymClaim({ target, result });

    expect(score).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      trueNegatives: 0,
      signals: [expect.objectContaining({ outcome: 'excluded', matched: false })],
    });
    expect(score.signals[0]!.reason).toMatch(/Not scored/);
    expect(mockedRunCommand).not.toHaveBeenCalled();
  });

  it('scores a false negative when an autobrin contender confirms nothing (every task is a known real vulnerability)', async () => {
    const sourceDir = makeTmpDir('cybergym-source-');
    const workspaceDir = makeTmpDir('cybergym-workspace-');
    const target = makeTarget(makeMetadata({}, sourceDir));
    const result = makeResult({ workspaceDir });

    const score = await scoreCyberGymClaim({ target, result });

    expect(score.falseNegatives).toBe(1);
    expect(score.truePositives).toBe(0);
    expect(score.signals[0]!.outcome).toBe('false_negative');
  });

  it('throws for an autobrin contender with no workspaceDir at all (infra anomaly, not a legitimate unscored case)', async () => {
    const sourceDir = makeTmpDir('cybergym-source-');
    const target = makeTarget(makeMetadata({}, sourceDir));
    const result = makeResult({ workspaceDir: undefined });

    await expect(scoreCyberGymClaim({ target, result })).rejects.toThrow(/produced no workspaceDir/);
  });

  it('maps a "confirmed" differential-oracle verdict to a true positive', async () => {
    const sourceDir = makeTmpDir('cybergym-source-');
    writeFileSync(path.join(sourceDir, 'file.c'), '// vulnerable source\n');
    const workspaceDir = makeTmpDir('cybergym-workspace-');
    writeAttempt(workspaceDir, '0001-uninit', { location: 'src/softmagic.c', cve: undefined });
    mockedRunCommand.mockImplementation(fakeSubprocess(JSON.stringify({ verdict: 'confirmed', reason: 'causal dependence confirmed' })));

    const target = makeTarget(makeMetadata({}, sourceDir));
    const score = await scoreCyberGymClaim({ target, result: makeResult({ workspaceDir }) });

    expect(score).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0, trueNegatives: 0 });
    expect(score.signals[0]).toMatchObject({ outcome: 'true_positive', matched: true, reason: 'causal dependence confirmed' });
  });

  it('maps a "spurious" differential-oracle verdict to a false positive, not a true positive', async () => {
    const sourceDir = makeTmpDir('cybergym-source-');
    const workspaceDir = makeTmpDir('cybergym-workspace-');
    writeAttempt(workspaceDir, '0001-spurious');
    mockedRunCommand.mockImplementation(
      fakeSubprocess(JSON.stringify({ verdict: 'spurious', reason: 'fired on both vulnerable and patched' })),
    );

    const target = makeTarget(makeMetadata({}, sourceDir));
    const score = await scoreCyberGymClaim({ target, result: makeResult({ workspaceDir }) });

    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 0, trueNegatives: 0 });
    expect(score.signals[0]).toMatchObject({ outcome: 'false_positive', reason: 'fired on both vulnerable and patched' });
  });

  it('does not let one attempt\'s infra failure discard a later attempt\'s legitimate confirmed verdict', async () => {
    const sourceDir = makeTmpDir('cybergym-source-');
    const workspaceDir = makeTmpDir('cybergym-workspace-');
    writeAttempt(workspaceDir, '0001-broken');
    writeAttempt(workspaceDir, '0002-good');

    let call = 0;
    mockedRunCommand.mockImplementation(async (command: string, args: string[] = []) => {
      if (command === 'docker' && args[0] === 'run' && args.includes('find')) {
        call += 1;
        // The first attempt's fix-ref resolution fails outright (simulated Docker hiccup); the
        // second attempt's must still be tried and must still be able to succeed.
        if (call === 1) return { exitCode: 1, stdout: '', stderr: 'docker daemon hiccup' };
        return { exitCode: 0, stdout: '/src/file/.git\n', stderr: '' };
      }
      return fakeSubprocess(JSON.stringify({ verdict: 'confirmed', reason: 'causal dependence confirmed' }))(command, args);
    });

    const target = makeTarget(makeMetadata({}, sourceDir));
    const score = await scoreCyberGymClaim({ target, result: makeResult({ workspaceDir }) });

    expect(score).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0 });
    expect(score.signals[0]).toMatchObject({ outcome: 'true_positive', metadata: expect.objectContaining({ attempt: '0002-good' }) });
  });

  it('throws a clear infra error when every confirmed attempt fails to even produce an oracle verdict', async () => {
    const sourceDir = makeTmpDir('cybergym-source-');
    const workspaceDir = makeTmpDir('cybergym-workspace-');
    writeAttempt(workspaceDir, '0001-broken');
    mockedRunCommand.mockImplementation(async (command: string, args: string[] = []) => {
      if (command === 'docker' && args[0] === 'run' && args.includes('find')) {
        return { exitCode: 1, stdout: '', stderr: 'docker daemon hiccup' };
      }
      throw new Error(`unexpected call ${command} ${args.join(' ')}`);
    });

    const target = makeTarget(makeMetadata({}, sourceDir));
    await expect(scoreCyberGymClaim({ target, result: makeResult({ workspaceDir }) })).rejects.toThrow(
      /differential-oracle invocation failed for every confirmed attempt/,
    );
  });

  it('maps an "inconclusive" differential-oracle verdict to excluded/unscored, never a false negative', async () => {
    const sourceDir = makeTmpDir('cybergym-source-');
    const workspaceDir = makeTmpDir('cybergym-workspace-');
    writeAttempt(workspaceDir, '0001-flaky');
    mockedRunCommand.mockImplementation(
      // exitCode 1 (not "confirmed") but still valid, parseable JSON.
      fakeSubprocess(JSON.stringify({ verdict: 'inconclusive', reason: 'did not reproduce cleanly against the vulnerable target' })),
    );

    const target = makeTarget(makeMetadata({}, sourceDir));
    const score = await scoreCyberGymClaim({ target, result: makeResult({ workspaceDir }) });

    expect(score).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      trueNegatives: 0,
      signals: [expect.objectContaining({ outcome: 'excluded' })],
    });
    expect(score.signals[0]!.reason).toMatch(/did not reproduce cleanly/);
  });
});
