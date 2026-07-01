import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentRunner,
  ConfirmedFinding,
  ContenderClaim,
  NormalizedResult,
  RunControls,
  TargetHandle,
} from './types.js';
import { runCommand } from '../lib/git.js';
import { readJson, slugify } from '../lib/json.js';
import { cacheRoot } from '../lib/paths.js';

export type PithosContenderConfig = {
  id?: string;
  type: 'pithos';
  /** Pi provider id (e.g. "azure-openai-responses", "deepseek"). Omitted: PITHOS_PROVIDER env or PITHOS's own default. */
  provider?: string;
  /**
   * PITHOS's own default ("docker") runs Pi at a pinned version inside PITHOS's agent image.
   * "local" trusts whatever `pi` CLI is on PATH (no Docker required) -- matching how this harness
   * already runs the autobrin contender directly, without containers. Default: "local". Operators
   * using "local" must have a Pi CLI on PATH compatible with the pin in PITHOS's agent_image.py
   * (observed working: @earendil-works/pi-coding-agent@0.78.1); see README for details.
   */
  sandboxMode?: 'docker' | 'local';
  /** Bounds candidate-finding breadth (PITHOS CLI default: 12). Lower for faster/cheaper smoke runs. */
  maxFindings?: number;
};

type PithosGithubAdvisory = {
  cve_id?: string | null;
  summary?: string;
};

type PithosFinding = {
  id?: string;
  title?: string;
  summary?: string;
  severity?: string;
  files?: string[];
  /** Present on TRIAGE.json entries once static triage has run. */
  verdict?: 'confirmed' | 'inconclusive' | 'false_positive';
  github_advisory?: PithosGithubAdvisory;
};

type PithosTriage = {
  findings?: PithosFinding[];
};

type PithosRuntimeVerdict = {
  finding_id: string;
  /** confirmed_runtime | not_reproduced | blocked | inconclusive_runtime */
  status?: string;
};

type PithosRuntimeSummary = {
  verdicts?: PithosRuntimeVerdict[];
};

function toRepoUrl(repo: string): string {
  return repo.includes('://') || repo.startsWith('git@') ? repo : `https://github.com/${repo}`;
}

/**
 * PITHOS writes artifacts under `<results-dir>/<safe-repo-name>/<timestamp>/`, choosing both
 * path segments itself. Callers allocate a fresh, empty results dir per run, so this normally
 * finds exactly one nested subdirectory at each level. Defensively (e.g. a leftover directory
 * from a prior run reusing the same allocation), prefer the most recently modified subdirectory
 * over `readdir`'s unspecified order, so a stray extra directory cannot silently make claim
 * extraction read from an arbitrary, unrelated run.
 */
async function newestSubdir(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (dirNames.length === 0) return undefined;
  if (dirNames.length === 1) return path.join(dir, dirNames[0]!);

  const withMtime = await Promise.all(
    dirNames.map(async (name) => ({ name, mtimeMs: (await stat(path.join(dir, name))).mtimeMs })),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return path.join(dir, withMtime[0]!.name);
}

export async function locateRunOutDir(resultsDir: string): Promise<string | undefined> {
  const repoDir = await newestSubdir(resultsDir);
  return repoDir ? newestSubdir(repoDir) : undefined;
}

/**
 * Merge PITHOS's static triage verdict with its (source-oracle or live) runtime verdict.
 * Runtime evidence overrides static triage when available: a live/source-oracle confirmation
 * or refutation is stronger evidence than the static-only pass. Absent runtime evidence
 * (the common case without `--execute-app`, where most findings are "blocked"), fall back to
 * the static triage verdict, since that is PITHOS's own considered self-verdict.
 */
function normalizeVerdict(
  staticVerdict: string | undefined,
  runtimeStatus: string | undefined,
): 'confirmed' | 'false_positive' | 'inconclusive' {
  if (runtimeStatus === 'confirmed_runtime') return 'confirmed';
  if (runtimeStatus === 'not_reproduced') return 'false_positive';
  if (staticVerdict === 'confirmed' || staticVerdict === 'false_positive' || staticVerdict === 'inconclusive') {
    return staticVerdict;
  }
  return 'inconclusive';
}

export async function extractClaimFromRunOutDir(outDir: string): Promise<ContenderClaim> {
  const triage = await readJson<PithosTriage>(path.join(outDir, 'TRIAGE.json'), {});
  const runtimeSummary = await readJson<PithosRuntimeSummary>(path.join(outDir, 'verify', 'runtime-summary.json'), {});
  const runtimeByFindingId = new Map((runtimeSummary.verdicts ?? []).map((verdict) => [verdict.finding_id, verdict.status]));

  const confirmedFindings: ConfirmedFinding[] = [];
  const selfVerdictCounts: Record<string, number> = {};
  const triageCounts: Record<string, number> = {};

  for (const finding of triage.findings ?? []) {
    const verdict = normalizeVerdict(finding.verdict, finding.id ? runtimeByFindingId.get(finding.id) : undefined);
    selfVerdictCounts[verdict] = (selfVerdictCounts[verdict] ?? 0) + 1;
    if (finding.severity) triageCounts[finding.severity] = (triageCounts[finding.severity] ?? 0) + 1;

    if (verdict !== 'confirmed') continue;
    confirmedFindings.push({
      location: finding.files?.length ? finding.files.join(', ') : undefined,
      cve: finding.github_advisory?.cve_id ?? undefined,
      summary: finding.summary ?? finding.title,
      verdict,
    });
  }

  return { confirmedFindings, selfVerdictCounts, triageCounts };
}

export function buildPithosArgs(input: {
  target: TargetHandle;
  controls: RunControls;
  config: PithosContenderConfig;
  resultsDir: string;
  repoCacheDir: string;
}): string[] {
  if (!input.target.repo) {
    throw new Error(`pithos contender requires a repo target (got modality "${input.target.modality}")`);
  }
  const args = [
    'run',
    toRepoUrl(input.target.repo),
    '--model',
    input.controls.model,
    '--sandbox-mode',
    input.config.sandboxMode ?? 'local',
    '--results-dir',
    input.resultsDir,
    '--repo-cache-dir',
    input.repoCacheDir,
    // Deterministic across operator environments: web search would otherwise silently
    // enable itself whenever FIRECRAWL_API_KEY happens to be set (see PITHOS's own
    // _resolve_web_flag), which breaks reproducibility of a fairness-controlled matrix run.
    '--no-web',
  ];
  if (input.target.sha) args.push('--ref', input.target.sha);
  if (input.config.provider) args.push('--provider', input.config.provider);
  if (input.config.maxFindings !== undefined) args.push('--max-findings', String(input.config.maxFindings));
  return args;
}

export function createPithosRunner(config: PithosContenderConfig): AgentRunner {
  const contenderId = config.id ?? 'pithos';
  return {
    id: contenderId,
    type: 'pithos',
    async run({ task, target, controls, context }) {
      const started = Date.now();
      const runResultsDir = path.join(context.engagementsDir, `${slugify(contenderId)}_${slugify(task.id)}_${Date.now()}`);
      const repoCacheDir = path.join(cacheRoot(), 'pithos-repos');
      await mkdir(runResultsDir, { recursive: true });
      await mkdir(context.resultsDir, { recursive: true });

      const args = buildPithosArgs({ target, controls, config, resultsDir: runResultsDir, repoCacheDir });
      const stdoutPath = path.join(context.resultsDir, `${slugify(contenderId)}_${slugify(task.id)}.stdout.log`);
      const stderrPath = path.join(context.resultsDir, `${slugify(contenderId)}_${slugify(task.id)}.stderr.log`);

      const { stdout, stderr, exitCode } = await runCommand('pithos', args, {});
      await writeFile(stdoutPath, stdout, 'utf8');
      await writeFile(stderrPath, stderr, 'utf8');

      const outDir = await locateRunOutDir(runResultsDir);
      const claim = outDir
        ? await extractClaimFromRunOutDir(outDir)
        : { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} };
      const runSummary = outDir ? await readJson<{ status?: string }>(path.join(outDir, 'run-summary.json'), {}) : {};

      return {
        contenderId,
        contenderType: 'pithos',
        exitCode,
        durationS: Math.round((Date.now() - started) / 1000),
        costUsd: null,
        costStatus: 'unavailable',
        claim,
        engagementDir: outDir,
        stdoutPath,
        stderrPath,
        raw: outDir ? { status: runSummary.status, outDir } : undefined,
      } satisfies NormalizedResult;
    },
  };
}
