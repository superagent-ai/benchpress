import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPithosArgs, createPithosRunner, extractClaimFromRunOutDir, locateRunOutDir } from '../src/contenders/pithos.js';
import { contenderIdFromConfig, createContender } from '../src/contenders/registry.js';
import type { TargetHandle } from '../src/contenders/types.js';

const baseTarget: TargetHandle = {
  benchmarkId: 'repo-cve-smoke',
  taskId: 'sanitize-html-cve-2024-45801',
  modality: 'repo',
  repo: 'apostrophecms/sanitize-html',
  sha: '2.13.0',
};

describe('pithos contender: buildPithosArgs', () => {
  it('converts an owner/repo slug into a GitHub URL and forwards --ref/--model', () => {
    const args = buildPithosArgs({
      target: baseTarget,
      controls: { model: 'deepseek-chat' },
      config: { type: 'pithos' },
      resultsDir: '/tmp/results',
      repoCacheDir: '/tmp/cache',
    });

    expect(args[0]).toBe('run');
    expect(args[1]).toBe('https://github.com/apostrophecms/sanitize-html');
    expect(args).toEqual(
      expect.arrayContaining([
        '--model',
        'deepseek-chat',
        '--ref',
        '2.13.0',
        '--sandbox-mode',
        'local',
        '--results-dir',
        '/tmp/results',
        '--repo-cache-dir',
        '/tmp/cache',
        '--no-web',
      ]),
    );
  });

  it('passes an already-fully-qualified repo URL through unchanged', () => {
    const args = buildPithosArgs({
      target: { ...baseTarget, repo: 'https://github.com/apostrophecms/sanitize-html.git' },
      controls: { model: 'deepseek-chat' },
      config: { type: 'pithos' },
      resultsDir: '/tmp/results',
      repoCacheDir: '/tmp/cache',
    });

    expect(args[1]).toBe('https://github.com/apostrophecms/sanitize-html.git');
  });

  it('omits --ref when the target has no sha', () => {
    const args = buildPithosArgs({
      target: { ...baseTarget, sha: undefined },
      controls: { model: 'deepseek-chat' },
      config: { type: 'pithos' },
      resultsDir: '/tmp/results',
      repoCacheDir: '/tmp/cache',
    });

    expect(args).not.toContain('--ref');
  });

  it('forwards --provider and --max-findings only when configured', () => {
    const args = buildPithosArgs({
      target: baseTarget,
      controls: { model: 'kimi-k2.6' },
      config: { type: 'pithos', provider: 'azure-openai-responses', sandboxMode: 'docker', maxFindings: 3 },
      resultsDir: '/tmp/results',
      repoCacheDir: '/tmp/cache',
    });

    expect(args).toEqual(
      expect.arrayContaining(['--provider', 'azure-openai-responses', '--sandbox-mode', 'docker', '--max-findings', '3']),
    );
  });

  it('throws for non-repo targets instead of silently building a bogus command', () => {
    expect(() =>
      buildPithosArgs({
        target: { ...baseTarget, repo: undefined, modality: 'model' },
        controls: { model: 'deepseek-chat' },
        config: { type: 'pithos' },
        resultsDir: '/tmp/results',
        repoCacheDir: '/tmp/cache',
      }),
    ).toThrow(/requires a repo target/);
  });
});

describe('pithos contender: locateRunOutDir', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'benchpress-pithos-locate-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('finds <results-dir>/<repo-name>/<timestamp> in the normal single-subdir case', async () => {
    const resultsDir = makeTmpDir();
    const outDir = path.join(resultsDir, 'apostrophecms-sanitize-html', '20260701T101241Z');
    mkdirSync(outDir, { recursive: true });

    expect(await locateRunOutDir(resultsDir)).toBe(outDir);
  });

  it('returns undefined when the results dir is empty (PITHOS failed before writing any artifacts)', async () => {
    const resultsDir = makeTmpDir();
    expect(await locateRunOutDir(resultsDir)).toBeUndefined();
  });

  it('picks the most recently modified subdirectory, not readdir order, when more than one exists (Bugbot: arbitrary-pick regression)', async () => {
    const resultsDir = makeTmpDir();
    const repoDir = path.join(resultsDir, 'apostrophecms-sanitize-html');
    const older = path.join(repoDir, '20260101T000000Z');
    const newer = path.join(repoDir, '20260701T101241Z');
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    // Force mtimes so the "newest wins" comparison does not depend on directory-entry creation
    // order or filesystem timestamp resolution during the fast mkdirSync calls above.
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    utimesSync(newer, new Date('2026-07-01T10:12:41Z'), new Date('2026-07-01T10:12:41Z'));

    expect(await locateRunOutDir(resultsDir)).toBe(newer);
  });
});

describe('pithos contender: extractClaimFromRunOutDir', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRunOutDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'benchpress-pithos-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  function writeTriage(outDir: string, findings: unknown[]): void {
    writeFileSync(path.join(outDir, 'TRIAGE.json'), JSON.stringify({ findings }));
  }

  function writeRuntimeSummary(outDir: string, verdicts: unknown[]): void {
    mkdirSync(path.join(outDir, 'verify'), { recursive: true });
    writeFileSync(path.join(outDir, 'verify', 'runtime-summary.json'), JSON.stringify({ verdicts }));
  }

  it('promotes a runtime confirmed_runtime verdict to "confirmed" even when static triage was inconclusive', async () => {
    const outDir = makeRunOutDir();
    writeTriage(outDir, [
      {
        id: 'F001',
        title: 'escapeHtml() entity-encoding bypass',
        // PITHOS backfills top-level `summary` from `github_advisory.summary` when scanning
        // (see `_normalize_finding`) and preserves it through triage merge, so real TRIAGE.json
        // findings always carry both; the fixture mirrors that instead of only nesting it.
        summary: 'Incomplete sanitization',
        verdict: 'inconclusive',
        severity: 'high',
        files: ['index.js'],
        github_advisory: { cve_id: 'CVE-2024-45801', summary: 'Incomplete sanitization' },
      },
    ]);
    writeRuntimeSummary(outDir, [{ finding_id: 'F001', status: 'confirmed_runtime' }]);

    const claim = await extractClaimFromRunOutDir(outDir);

    expect(claim.confirmedFindings).toEqual([
      { location: 'index.js', cve: 'CVE-2024-45801', summary: 'Incomplete sanitization', verdict: 'confirmed' },
    ]);
    expect(claim.selfVerdictCounts).toEqual({ confirmed: 1 });
    expect(claim.triageCounts).toEqual({ high: 1 });
  });

  it('demotes a statically-confirmed finding to false_positive when live evidence does not reproduce it', async () => {
    const outDir = makeRunOutDir();
    writeTriage(outDir, [{ id: 'F001', title: 'Maybe XSS', verdict: 'confirmed', severity: 'medium', files: ['a.js'] }]);
    writeRuntimeSummary(outDir, [{ finding_id: 'F001', status: 'not_reproduced' }]);

    const claim = await extractClaimFromRunOutDir(outDir);

    expect(claim.confirmedFindings).toHaveLength(0);
    expect(claim.selfVerdictCounts).toEqual({ false_positive: 1 });
  });

  it('falls back to the static triage verdict when the runtime plugin is blocked (default, non--execute-app runs)', async () => {
    const outDir = makeRunOutDir();
    writeTriage(outDir, [
      { id: 'F001', title: 'Confirmed statically', verdict: 'confirmed', severity: 'critical', files: ['lib/parser.js'] },
      { id: 'F002', title: 'Rejected statically', verdict: 'false_positive', severity: 'low', files: ['lib/other.js'] },
    ]);
    writeRuntimeSummary(outDir, [
      { finding_id: 'F001', status: 'blocked' },
      { finding_id: 'F002', status: 'blocked' },
    ]);

    const claim = await extractClaimFromRunOutDir(outDir);

    expect(claim.confirmedFindings).toEqual([
      { location: 'lib/parser.js', cve: undefined, summary: 'Confirmed statically', verdict: 'confirmed' },
    ]);
    expect(claim.selfVerdictCounts).toEqual({ confirmed: 1, false_positive: 1 });
  });

  it('treats a missing verify/runtime-summary.json as no runtime evidence rather than throwing', async () => {
    const outDir = makeRunOutDir();
    writeTriage(outDir, [{ id: 'F001', title: 'Statically confirmed only', verdict: 'confirmed', severity: 'high', files: ['x.js'] }]);

    const claim = await extractClaimFromRunOutDir(outDir);

    expect(claim.confirmedFindings).toHaveLength(1);
    expect(claim.selfVerdictCounts).toEqual({ confirmed: 1 });
  });

  it('returns an empty (not fake) claim when TRIAGE.json has no findings', async () => {
    const outDir = makeRunOutDir();
    writeTriage(outDir, []);

    const claim = await extractClaimFromRunOutDir(outDir);

    expect(claim).toEqual({ confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} });
  });
});

describe('pithos contender: registry wiring', () => {
  it('defaults the contender id to "pithos"', () => {
    expect(contenderIdFromConfig({ type: 'pithos' })).toBe('pithos');
  });

  it('creates a pithos runner with type "pithos"', () => {
    const runner = createContender({ id: 'pithos', type: 'pithos', provider: 'deepseek' });
    expect(runner.type).toBe('pithos');
    expect(runner.id).toBe('pithos');
  });

  it('createPithosRunner honors a custom id', () => {
    const runner = createPithosRunner({ id: 'pithos@custom', type: 'pithos' });
    expect(runner.id).toBe('pithos@custom');
  });
});
