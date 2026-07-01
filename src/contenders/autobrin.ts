import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AgentRunner, BenchmarkTask, ContenderClaim, ConfirmedFinding, NormalizedResult, RunContext, RunControls, TargetHandle } from './types.js';
import { webappTargetMetadata } from './types.js';
import { ensureAutobrinCheckout } from '../lib/checkout.js';
import { readJson, slugify } from '../lib/json.js';
import { runCommand } from '../lib/git.js';

export type AutobrinContenderConfig = {
  id?: string;
  type: 'autobrin';
  ref?: string;
  path?: string;
};

export type AutobrinRunOptions = {
  config: AutobrinContenderConfig;
  contributors?: number;
};

function collect(proc: ReturnType<typeof spawn>): Promise<[string, string, number]> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve([stdout, stderr, code ?? -1]));
  });
}

function buildGuardrails(controls: RunControls): Record<string, unknown> {
  if (controls.maxEngagementCostUsd === undefined && controls.maxCycles === undefined) return {};
  return {
    guardrails: {
      ...(controls.maxEngagementCostUsd !== undefined ? { maxEngagementCostUsd: controls.maxEngagementCostUsd } : {}),
      ...(controls.maxCycles !== undefined ? { maxCycles: controls.maxCycles } : {}),
    },
  };
}

export function buildRepoPayload(input: {
  target: TargetHandle;
  controls: RunControls;
  workspaceRoot: string;
  contributors?: number;
}): Record<string, unknown> {
  return {
    modality: 'repo',
    repo: input.target.repo,
    sha: input.target.sha,
    workspaceRoot: input.workspaceRoot,
    targetPreparation: 'prepared',
    model: input.controls.model,
    contributors: input.contributors ?? input.controls.contributors,
    ...buildGuardrails(input.controls),
    resume: false,
  };
}

/**
 * Builds a `modality: "webapp"` engagement payload from a benchmark-agnostic
 * `TargetHandle`. Any webapp-based benchmark adapter (CVE-Bench, BountyBench)
 * populates `target.metadata.webapp` with the canonical field names from
 * autobrin-flue's `WebappTargetSchema` (see `docs/modalities.md` on
 * `staging`); this function never references a specific benchmark.
 */
export function buildWebappPayload(input: {
  target: TargetHandle;
  controls: RunControls;
  workspaceRoot: string;
  contributors?: number;
}): Record<string, unknown> {
  const webapp = webappTargetMetadata(input.target);
  if (!webapp) {
    throw new Error(
      `webapp target ${input.target.benchmarkId}/${input.target.taskId} is missing metadata.webapp.url`,
    );
  }
  return {
    modality: 'webapp',
    target: {
      url: webapp.url,
      repo: webapp.repo,
      sha: webapp.sha,
      username: webapp.username,
      password: webapp.password,
      role: webapp.role,
      outboundServiceUrl: webapp.outboundServiceUrl,
      proofUploadingUrl: webapp.proofUploadingUrl,
      secret: webapp.secret,
      secretUploadingUrl: webapp.secretUploadingUrl,
    },
    workspaceRoot: input.workspaceRoot,
    model: input.controls.model,
    contributors: input.contributors ?? input.controls.contributors,
    ...buildGuardrails(input.controls),
    resume: false,
  };
}

/**
 * Flue's CLI renamed `flue run`'s payload flag from `--payload` to `--input`
 * (see `npx flue run --help`) -- this was silently broken for every autobrin
 * contender run until surfaced while verifying the cve-bench adapter against
 * a real `staging` engagement. Kept as its own function so the exact flag
 * name is covered by a fast, spawn-free unit test.
 */
export function buildFlueRunArgs(workflowName: string, payload: Record<string, unknown>): string[] {
  return ['flue', 'run', workflowName, '--target', 'node', '--input', JSON.stringify(payload)];
}

export async function extractClaimFromWorkspace(workspaceDir: string): Promise<ContenderClaim> {
  const attemptsDir = path.join(workspaceDir, 'attacks');
  const attempts = await readdir(attemptsDir, { withFileTypes: true }).catch(() => []);
  const confirmedFindings: ConfirmedFinding[] = [];
  const selfVerdictCounts: Record<string, number> = {};
  const triageCounts: Record<string, number> = {};

  for (const entry of attempts) {
    if (!entry.isDirectory()) continue;
    const attemptDir = path.join(attemptsDir, entry.name);
    const evaluate = await readJson<Record<string, unknown>>(path.join(attemptDir, 'evaluate.json'), {});
    const verdict = String(evaluate.verdict ?? 'unevaluated');
    selfVerdictCounts[verdict] = (selfVerdictCounts[verdict] ?? 0) + 1;
    const triage = evaluate.triage_tier;
    if (typeof triage === 'string' && triage) triageCounts[triage] = (triageCounts[triage] ?? 0) + 1;

    if (verdict !== 'confirmed') continue;

    const report = await readJson<Record<string, unknown>>(path.join(attemptDir, 'report.json'), {});
    const disclosure = await readJson<Record<string, unknown>>(path.join(attemptDir, 'disclosure.json'), {});
    const location =
      typeof report.affected_component === 'string'
        ? report.affected_component
        : typeof report.location === 'string'
          ? report.location
          : undefined;
    const cve =
      typeof disclosure.cve_id === 'string'
        ? disclosure.cve_id
        : typeof report.cve === 'string'
          ? report.cve
          : undefined;
    const summary = typeof report.summary === 'string' ? report.summary : undefined;
    confirmedFindings.push({ location, cve, summary, verdict });
  }

  return { confirmedFindings, selfVerdictCounts, triageCounts };
}

/**
 * A checkout with no installed dependencies has no local `flue` binary, so a bare `npx flue ...`
 * silently falls through to installing and running an unrelated, long-abandoned public npm
 * package also named `flue` (a ~2015 Firebase/ES sync daemon) instead of failing loudly --
 * producing a fast, wrong "the contender did nothing" result rather than an error. Discovered via
 * a real end-to-end run against superagent-ai/benchpress#15's live BountyBench target; affects
 * every fresh `ensureAutobrinCheckout()` clone (the common case, since `.cache/` is gitignored),
 * not anything bountybench-specific.
 */
async function ensureDependenciesInstalled(root: string): Promise<void> {
  const installed = await access(path.join(root, 'node_modules')).then(
    () => true,
    () => false,
  );
  if (installed) return;
  const { exitCode, stderr, stdout } = await runCommand('npm', ['install'], { cwd: root });
  if (exitCode !== 0) {
    throw new Error(`npm install failed in ${root} (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
}

export function createAutobrinRunner(options: AutobrinRunOptions): AgentRunner {
  const contenderId = options.config.id ?? 'autobrin';
  return {
    id: contenderId,
    type: 'autobrin',
    async run({ task, target, controls, context }) {
      const started = Date.now();
      const checkout = await ensureAutobrinCheckout({ ref: options.config.ref, path: options.config.path });
      await ensureDependenciesInstalled(checkout.root);
      const engagementDir = path.join(
        context.engagementsDir,
        `${slugify(contenderId)}_${slugify(task.benchmarkId)}_${slugify(task.id)}_${Date.now()}`,
      );
      const workspaceRoot = engagementDir;
      await mkdir(path.dirname(engagementDir), { recursive: true });

      if (target.modality === 'repo' && target.repo) {
        await materializeTarget({
          autobrinRoot: checkout.root,
          repo: target.repo,
          sha: target.sha,
          workspaceRoot,
        });
      }

      const payload =
        target.modality === 'webapp'
          ? buildWebappPayload({ target, controls, workspaceRoot, contributors: options.contributors })
          : buildRepoPayload({ target, controls, workspaceRoot, contributors: options.contributors });

      const stdoutPath = path.join(context.resultsDir, `${slugify(contenderId)}_${slugify(task.id)}.stdout.log`);
      const stderrPath = path.join(context.resultsDir, `${slugify(contenderId)}_${slugify(task.id)}.stderr.log`);
      await mkdir(context.resultsDir, { recursive: true });

      const args = buildFlueRunArgs('engagement', payload);
      const proc = spawn('npx', args, { cwd: checkout.root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const [stdout, stderr, exitCode] = await collect(proc);
      await writeFile(stdoutPath, stdout, 'utf8');
      await writeFile(stderrPath, stderr, 'utf8');

      const workspaceDir = path.join(workspaceRoot, 'workspace');
      const claim = await extractClaimFromWorkspace(workspaceDir);
      const resultJson = await readJson<Record<string, unknown>>(path.join(workspaceRoot, 'result.json'), {});
      const usage = resultJson.usage as { costUsd?: number } | undefined;
      const costStatus = resultJson.costStatus === 'known' ? 'known' : 'unavailable';

      return {
        contenderId,
        contenderType: 'autobrin',
        resolvedRef: checkout.ref,
        commitSha: checkout.commitSha,
        exitCode,
        durationS: Math.round((Date.now() - started) / 1000),
        costUsd: usage?.costUsd ?? null,
        costStatus,
        claim,
        engagementDir,
        workspaceDir,
        stdoutPath,
        stderrPath,
      } satisfies NormalizedResult;
    },
  };
}

async function materializeTarget(input: {
  autobrinRoot: string;
  repo: string;
  sha?: string;
  workspaceRoot: string;
}): Promise<void> {
  const script = `
import { prepareWorkspace } from './src/workspace.js';
await prepareWorkspace({
  projectRoot: process.cwd(),
  repo: ${JSON.stringify(input.repo)},
  sha: ${JSON.stringify(input.sha)},
  workspaceRoot: ${JSON.stringify(input.workspaceRoot)},
  targetPreparation: 'materialize',
});
`;
  const { exitCode, stderr } = await runCommand('npx', ['tsx', '-e', script], { cwd: input.autobrinRoot });
  if (exitCode !== 0) {
    throw new Error(`Failed to materialize target ${input.repo}: ${stderr}`);
  }
}
