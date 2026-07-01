import { exec, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@daytona/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReadAttemptsScript,
  buildRepoPayload,
  computeClaimFromAttempts,
  createAutobrinRunner,
  extractClaimFromWorkspace,
  fetchAttemptsFromSandbox,
  materializeTarget,
  type AttemptRecord,
} from '../src/contenders/autobrin.js';
import type { EngagementPayload } from '../src/daytona/payload.js';
import { runCommand } from '../src/lib/git.js';

vi.mock('../src/lib/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/git.js')>();
  return { ...actual, runCommand: vi.fn() };
});

describe('computeClaimFromAttempts', () => {
  it('counts self-verdicts and triage tiers across all attempts', () => {
    const attempts: AttemptRecord[] = [
      { evaluate: { verdict: 'confirmed', triage_tier: 'report' }, report: { location: 'lib/a.js' }, disclosure: {} },
      { evaluate: { verdict: 'rejected' }, report: {}, disclosure: {} },
      { evaluate: {}, report: {}, disclosure: {} },
    ];

    const claim = computeClaimFromAttempts(attempts);

    expect(claim.selfVerdictCounts).toEqual({ confirmed: 1, rejected: 1, unevaluated: 1 });
    expect(claim.triageCounts).toEqual({ report: 1 });
  });

  it('extracts confirmed findings with location/cve/summary fallbacks', () => {
    const attempts: AttemptRecord[] = [
      {
        evaluate: { verdict: 'confirmed' },
        report: { affected_component: 'lib/parser.js:42', summary: 'buffer overflow' },
        disclosure: { cve_id: 'CVE-2024-0001' },
      },
      {
        evaluate: { verdict: 'confirmed' },
        report: { location: 'lib/other.js', cve: 'CVE-2024-0002' },
        disclosure: {},
      },
    ];

    const claim = computeClaimFromAttempts(attempts);

    expect(claim.confirmedFindings).toEqual([
      { location: 'lib/parser.js:42', cve: 'CVE-2024-0001', summary: 'buffer overflow', verdict: 'confirmed' },
      { location: 'lib/other.js', cve: 'CVE-2024-0002', summary: undefined, verdict: 'confirmed' },
    ]);
  });

  it('does not record a confirmed finding for a non-confirmed verdict', () => {
    const claim = computeClaimFromAttempts([{ evaluate: { verdict: 'unevaluated' }, report: {}, disclosure: {} }]);
    expect(claim.confirmedFindings).toEqual([]);
  });

  it('ignores a non-string triage_tier instead of throwing', () => {
    const claim = computeClaimFromAttempts([{ evaluate: { verdict: 'confirmed', triage_tier: 7 }, report: {}, disclosure: {} }]);
    expect(claim.triageCounts).toEqual({});
  });
});

describe('extractClaimFromWorkspace (regression: local-disk reader after refactor)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeWorkspace(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'benchpress-workspace-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('reads confirmed findings from attacks/<attempt>/*.json on disk', async () => {
    const workspaceDir = makeWorkspace();
    const attemptDir = path.join(workspaceDir, 'attacks', 'attempt-1');
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(path.join(attemptDir, 'evaluate.json'), JSON.stringify({ verdict: 'confirmed', triage_tier: 'report' }));
    writeFileSync(path.join(attemptDir, 'report.json'), JSON.stringify({ location: 'lib/x.js', summary: 'xss' }));
    writeFileSync(path.join(attemptDir, 'disclosure.json'), JSON.stringify({ cve_id: 'CVE-2024-9999' }));

    const claim = await extractClaimFromWorkspace(workspaceDir);

    expect(claim.confirmedFindings).toEqual([
      { location: 'lib/x.js', cve: 'CVE-2024-9999', summary: 'xss', verdict: 'confirmed' },
    ]);
    expect(claim.selfVerdictCounts).toEqual({ confirmed: 1 });
  });

  it('tolerates a missing attacks directory entirely (no attempts made)', async () => {
    const claim = await extractClaimFromWorkspace(makeWorkspace());
    expect(claim).toEqual({ confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} });
  });

  it('tolerates an attempt directory with no evaluate.json yet (mid-run)', async () => {
    const workspaceDir = makeWorkspace();
    mkdirSync(path.join(workspaceDir, 'attacks', 'attempt-in-progress'), { recursive: true });

    const claim = await extractClaimFromWorkspace(workspaceDir);
    expect(claim.selfVerdictCounts).toEqual({ unevaluated: 1 });
  });
});

describe('buildRepoPayload', () => {
  const target = { benchmarkId: 'repo-cve-smoke', taskId: 't1', modality: 'repo' as const, repo: 'owner/repo', sha: 'abc123' };
  const controls = { model: 'kimi-azure/kimi-k2.6', maxCycles: 1, maxEngagementCostUsd: 5 };

  it('includes workspaceRoot when provided (local transport)', () => {
    const payload = buildRepoPayload({ target, controls, workspaceRoot: '/tmp/engagement-1' });
    expect(payload.workspaceRoot).toBe('/tmp/engagement-1');
  });

  it('omits workspaceRoot entirely when not provided (daytona transport defaults sandbox-side)', () => {
    const payload = buildRepoPayload({ target, controls });
    expect('workspaceRoot' in payload).toBe(false);
  });

  it('still carries guardrails and contributors through either way', () => {
    const payload = buildRepoPayload({ target, controls, contributors: 2 });
    expect(payload.guardrails).toEqual({ maxEngagementCostUsd: 5, maxCycles: 1 });
    expect(payload.contributors).toBe(2);
  });

  it('omits detectOnly entirely when the target does not request it (unchanged default behavior)', () => {
    const payload = buildRepoPayload({ target, controls });
    expect('detectOnly' in payload).toBe(false);
  });

  it('forwards target.detectOnly into the payload for classification benchmarks (e.g. owasp)', () => {
    const payload = buildRepoPayload({ target: { ...target, detectOnly: true }, controls });
    expect(payload.detectOnly).toBe(true);
  });
});

describe('buildReadAttemptsScript', () => {
  it('is valid python3 (parses with ast.parse)', () => {
    const script = buildReadAttemptsScript('/home/daytona/benchpress/workspace/attacks');
    expect(() =>
      execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: script }),
    ).not.toThrow();
  });
});

describe('fetchAttemptsFromSandbox (real python3 execution over a fake, real-shell sandbox)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** fetchAttemptsFromSandbox derives "<workspaceRoot>/workspace/attacks"; build that layout under a fresh temp root. */
  function makeSandboxRoot(): { root: string; attacksDir: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'benchpress-sandbox-root-'));
    tmpDirs.push(root);
    const attacksDir = path.join(root, 'workspace', 'attacks');
    mkdirSync(attacksDir, { recursive: true });
    return { root, attacksDir };
  }

  /** Executes commands via real bash so the generated python3 heredoc is actually exercised, mirroring tests/daytona-doctor.test.ts's realShellSandbox. */
  function realShellSandbox(): Sandbox {
    const executeCommand = (command: string) =>
      new Promise<{ exitCode: number; result: string }>((resolve) => {
        exec(command, { shell: '/bin/bash' }, (error, stdout) => {
          const code = (error as (Error & { code?: number | string }) | null)?.code;
          const exitCode = error ? (typeof code === 'number' ? code : 1) : 0;
          resolve({ exitCode, result: stdout.toString() });
        });
      });
    return { id: 'fake-sandbox', process: { executeCommand } } as unknown as Sandbox;
  }

  const repoPayload = (workspaceRoot: string): EngagementPayload =>
    ({ modality: 'repo', repo: 'owner/repo', workspaceRoot, targetPreparation: 'prepared', resume: false }) as EngagementPayload;

  it('returns one record per attempt directory, tolerating missing files', async () => {
    const { root, attacksDir } = makeSandboxRoot();
    const confirmedDir = path.join(attacksDir, 'attempt-confirmed');
    mkdirSync(confirmedDir, { recursive: true });
    writeFileSync(path.join(confirmedDir, 'evaluate.json'), JSON.stringify({ verdict: 'confirmed' }));
    writeFileSync(path.join(confirmedDir, 'report.json'), JSON.stringify({ location: 'lib/y.js' }));
    writeFileSync(path.join(confirmedDir, 'disclosure.json'), JSON.stringify({ cve_id: 'CVE-2024-1' }));
    // No evaluate.json here yet -- must read back as {} rather than fail the whole call.
    mkdirSync(path.join(attacksDir, 'attempt-incomplete'), { recursive: true });
    // A stray file alongside the attempt directories must be skipped, not treated as an attempt.
    writeFileSync(path.join(attacksDir, 'not-an-attempt.txt'), 'noise');

    const attempts = await fetchAttemptsFromSandbox(realShellSandbox(), repoPayload(root));

    expect(attempts).toHaveLength(2);
    const confirmed = attempts.find((a) => a.name === 'attempt-confirmed');
    expect(confirmed?.evaluate).toEqual({ verdict: 'confirmed' });
    expect(confirmed?.report).toEqual({ location: 'lib/y.js' });
    expect(confirmed?.disclosure).toEqual({ cve_id: 'CVE-2024-1' });
    const incomplete = attempts.find((a) => a.name === 'attempt-incomplete');
    expect(incomplete?.evaluate).toEqual({});

    expect(computeClaimFromAttempts(attempts).confirmedFindings).toEqual([
      { location: 'lib/y.js', cve: 'CVE-2024-1', summary: undefined, verdict: 'confirmed' },
    ]);
  });

  it('returns an empty array when the attacks directory does not exist at all', async () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'benchpress-sandbox-empty-'));
    tmpDirs.push(emptyRoot);
    const attempts = await fetchAttemptsFromSandbox(realShellSandbox(), repoPayload(emptyRoot));
    expect(attempts).toEqual([]);
  });

  it('returns an empty array for non-repo modalities without attempting a fetch', async () => {
    const attempts = await fetchAttemptsFromSandbox(realShellSandbox(), {
      modality: 'webapp',
      target: { url: 'http://127.0.0.1:8080' },
      workspaceRoot: '/home/daytona/benchpress',
      resume: false,
    } as EngagementPayload);
    expect(attempts).toEqual([]);
  });

  // Regression (Bugbot): a script-level failure (exec channel down, python3 missing, etc.) must
  // never be silently reinterpreted as "zero attempts were made" -- that would let a real
  // confirmed finding vanish into a false negative the moment the *read-back* flakes, not the
  // engagement itself. Only a legitimately empty attacks directory (previous test) may return [].
  it('throws instead of returning an empty array when the sandbox command itself fails', async () => {
    const failingSandbox = {
      id: 'failing-sandbox',
      process: { executeCommand: async () => ({ exitCode: 127, result: 'bash: python3: command not found' }) },
    } as unknown as Sandbox;

    await expect(fetchAttemptsFromSandbox(failingSandbox, repoPayload('/home/daytona/benchpress'))).rejects.toThrow();
  });

  it('throws instead of returning an empty array when the sandbox returns unparsable output', async () => {
    const brokenOutputSandbox = {
      id: 'broken-output-sandbox',
      process: { executeCommand: async () => ({ exitCode: 0, result: 'not json' }) },
    } as unknown as Sandbox;

    await expect(
      fetchAttemptsFromSandbox(brokenOutputSandbox, repoPayload('/home/daytona/benchpress')),
    ).rejects.toThrow(/could not parse attempts JSON/);
  });
});

describe('createAutobrinRunner transport validation', () => {
  it('defaults to the local transport unchanged', () => {
    const runner = createAutobrinRunner({ config: { id: 'autobrin@staging', type: 'autobrin', ref: 'staging' } });
    expect(runner.id).toBe('autobrin@staging');
    expect(runner.type).toBe('autobrin');
  });

  it('rejects transport "daytona" combined with a local "path" override', () => {
    expect(() =>
      createAutobrinRunner({
        config: { id: 'x', type: 'autobrin', transport: 'daytona', path: '/local/checkout', image: 'some-image' },
      }),
    ).toThrow(/"path" is only supported for transport "local"/);
  });

  it('rejects transport "daytona" without an image or snapshot', () => {
    expect(() => createAutobrinRunner({ config: { id: 'x', type: 'autobrin', transport: 'daytona' } })).toThrow(
      /requires "image" or "snapshot"/,
    );
  });

  it('accepts transport "daytona" with only a snapshot', () => {
    const runner = createAutobrinRunner({ config: { id: 'x', type: 'autobrin', transport: 'daytona', snapshot: 'daytona-large' } });
    expect(runner.id).toBe('x');
  });
});

describe('materializeTarget', () => {
  const mockedRunCommand = vi.mocked(runCommand);

  afterEach(() => {
    mockedRunCommand.mockReset();
  });

  it('runs the generated script as a real tsx file, not "tsx -e" (regression for benchpress#25)', async () => {
    mockedRunCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await materializeTarget({
      autobrinRoot: '/fake/autobrin-root',
      repo: 'apostrophecms/sanitize-html',
      sha: 'v2.13.0',
      workspaceRoot: '/fake/workspace',
    });

    expect(mockedRunCommand).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockedRunCommand.mock.calls[0]!;
    expect(command).toBe('npx');
    expect(args[0]).toBe('tsx');
    // Bug 1: `tsx -e <script>` always transforms to CJS, which rejects the top-level `await`
    // prepareWorkspace() call below -- must be a real file path, never the literal '-e'.
    expect(args[1]).not.toBe('-e');
    const scriptPath = args[1]!;
    expect(scriptPath).toMatch(/\.mjs$/);
    expect(options?.cwd).toBe('/fake/autobrin-root');

    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('await prepareWorkspace(');
    // Bug 2: a relative './src/workspace.js' specifier resolves against the temp script file's
    // own directory once written to disk, not `autobrinRoot` -- must be an absolute file:// URL.
    expect(script).toContain(`from "file:///fake/autobrin-root/src/workspace.js"`);
    expect(script).not.toContain("from './src/workspace.js'");
  });

  it('throws a descriptive error when the script fails', async () => {
    mockedRunCommand.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' });

    await expect(
      materializeTarget({ autobrinRoot: '/fake/autobrin-root', repo: 'owner/repo', workspaceRoot: '/fake/workspace' }),
    ).rejects.toThrow(/Failed to materialize target owner\/repo.*boom/s);
  });
});
