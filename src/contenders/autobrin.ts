import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type { Image, Sandbox } from '@daytona/sdk';
import type { AgentRunner, BenchmarkTask, ContenderClaim, ConfirmedFinding, NormalizedResult, RunContext, RunControls, TargetHandle } from './types.js';
import { webappTargetMetadata } from './types.js';
import { ensureAutobrinCheckout } from '../lib/checkout.js';
import { readJson, slugify } from '../lib/json.js';
import { runCommand } from '../lib/git.js';
import { runDaytonaEngagement } from '../daytona/launcher.js';
import { executeChecked } from '../daytona/sandbox-exec.js';
import { engagementWorkspaceDir, type EngagementPayload } from '../daytona/payload.js';

export type AutobrinContenderConfig = {
  id?: string;
  type: 'autobrin';
  ref?: string;
  path?: string;
  /**
   * Where the engagement actually executes.
   * - 'local' (default): spawn `npx flue run engagement` on this machine. Unchanged behavior.
   * - 'daytona': provision a Daytona sandbox and run the engagement inside it via
   *   `runDaytonaEngagement`. Required for benchmarks whose modality needs a live
   *   computer-use environment (webapp/model) -- see superagent-ai/benchpress#11.
   */
  transport?: 'local' | 'daytona';
  /**
   * Daytona sandbox image: a string ref (registry tag or published snapshot-style image name)
   * or a declarative `Image` built with `Image.base(...)`. One of `image`/`snapshot` is required
   * when `transport` is `'daytona'`. Ignored otherwise.
   */
  image?: string | Image;
  /** Daytona sandbox snapshot name. One of `image`/`snapshot` is required when `transport` is `'daytona'`. Ignored otherwise. */
  snapshot?: string;
  /** Vision sidecar model for computer-use screenshot-to-text. `transport: 'daytona'` only. */
  visionModel?: string;
  /** Keep the sandbox running after the engagement instead of deleting it (debugging only). `transport: 'daytona'` only. */
  keepSandbox?: boolean;
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
  /** Omit for the Daytona transport: the sandbox-side launcher defaults this to its own root. */
  workspaceRoot?: string;
  contributors?: number;
}): Record<string, unknown> {
  return {
    modality: 'repo',
    repo: input.target.repo,
    sha: input.target.sha,
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    targetPreparation: 'prepared',
    model: input.controls.model,
    contributors: input.contributors ?? input.controls.contributors,
    ...buildGuardrails(input.controls),
    resume: false,
  };
}

/** One attempt's raw checkpoint JSON, keyed the same way regardless of where it was read from (local disk vs. a Daytona sandbox). */
export type AttemptRecord = {
  name?: string;
  evaluate: Record<string, unknown>;
  report: Record<string, unknown>;
  disclosure: Record<string, unknown>;
};

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
  /** Omit for the Daytona transport: the sandbox-side launcher defaults this to its own root. */
  workspaceRoot?: string;
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
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
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

/** Pure aggregation shared by both transports -- only how `AttemptRecord[]` gets populated differs. */
export function computeClaimFromAttempts(attempts: AttemptRecord[]): ContenderClaim {
  const confirmedFindings: ConfirmedFinding[] = [];
  const selfVerdictCounts: Record<string, number> = {};
  const triageCounts: Record<string, number> = {};

  for (const attempt of attempts) {
    const verdict = String(attempt.evaluate.verdict ?? 'unevaluated');
    selfVerdictCounts[verdict] = (selfVerdictCounts[verdict] ?? 0) + 1;
    const triage = attempt.evaluate.triage_tier;
    if (typeof triage === 'string' && triage) triageCounts[triage] = (triageCounts[triage] ?? 0) + 1;

    if (verdict !== 'confirmed') continue;

    const { report, disclosure } = attempt;
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
 * not anything bountybench-specific. Only the `local` transport spawns `npx` directly (the
 * `daytona` transport's sandbox bootstrap installs dependencies itself), so this is only called
 * from `runViaLocalNpx`.
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

async function readAttemptsFromLocalWorkspace(workspaceDir: string): Promise<AttemptRecord[]> {
  const attemptsDir = path.join(workspaceDir, 'attacks');
  const entries = await readdir(attemptsDir, { withFileTypes: true }).catch(() => []);
  const attempts: AttemptRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const attemptDir = path.join(attemptsDir, entry.name);
    attempts.push({
      name: entry.name,
      evaluate: await readJson<Record<string, unknown>>(path.join(attemptDir, 'evaluate.json'), {}),
      report: await readJson<Record<string, unknown>>(path.join(attemptDir, 'report.json'), {}),
      disclosure: await readJson<Record<string, unknown>>(path.join(attemptDir, 'disclosure.json'), {}),
    });
  }

  return attempts;
}

export async function extractClaimFromWorkspace(workspaceDir: string): Promise<ContenderClaim> {
  return computeClaimFromAttempts(await readAttemptsFromLocalWorkspace(workspaceDir));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A single `python3` heredoc that walks `<attacksDir>/*` inside the sandbox and prints one JSON
 * array describing every attempt's `evaluate`/`report`/`disclosure` checkpoints. This mirrors
 * `readAttemptsFromLocalWorkspace`'s per-file tolerance (a missing/unparsable file reads as `{}`,
 * never throws) so both transports feed `computeClaimFromAttempts` identical shapes. A single
 * round trip over `executeCommand` is far cheaper than one `sandbox.fs.downloadFile` call per
 * attempt file and keeps this in the same "generate a script, run it, read stdout" style already
 * used by `buildEngagementRunScript`.
 */
export function buildReadAttemptsScript(attacksDir: string): string {
  return [
    'import json, os, sys',
    `BASE = ${JSON.stringify(attacksDir)}`,
    'out = []',
    'if os.path.isdir(BASE):',
    '    for name in sorted(os.listdir(BASE)):',
    '        attempt_dir = os.path.join(BASE, name)',
    '        if not os.path.isdir(attempt_dir):',
    '            continue',
    '        def read_json(filename):',
    '            try:',
    '                with open(os.path.join(attempt_dir, filename), encoding="utf-8") as handle:',
    '                    return json.load(handle)',
    '            except (OSError, ValueError):',
    '                return {}',
    '        out.append({',
    '            "name": name,',
    '            "evaluate": read_json("evaluate.json"),',
    '            "report": read_json("report.json"),',
    '            "disclosure": read_json("disclosure.json"),',
    '        })',
    'sys.stdout.write(json.dumps(out))',
  ].join('\n');
}

/**
 * Reads confirmed-finding checkpoints back out of a still-live sandbox. Must run from
 * `runDaytonaEngagement`'s `afterEngagement` hook (before sandbox cleanup) -- by the time
 * `runDaytonaEngagement` itself resolves, the sandbox is already deleted.
 *
 * The `<workspaceRoot>/workspace/attacks/<attempt>/*.json` layout is a modality-agnostic
 * autobrin-flue convention (both `repo` and `webapp` modalities call the same `prepareWorkspace()`
 * layout code), so this reads attempts back the same way regardless of `payload.modality` -- this
 * mirrors the local-transport reader (`extractClaimFromWorkspace`), which is likewise never gated
 * on modality.
 *
 * Deliberately does NOT tolerate a script-level failure (non-zero exit, unparsable/non-array
 * output) by falling back to `[]`: the script's own per-file reads already tolerate an
 * individual attempt missing evaluate/report/disclosure.json (still mid-run, a legitimate `{}`),
 * so a non-zero exit or bad output here means something infrastructural went wrong instead (the
 * sandbox exec channel itself failing, `python3` missing, a truncated response). Silently
 * reinterpreting *that* as "zero attempts were made" would let a real confirmed finding vanish
 * into a false negative the moment the read-back flakes, not the engagement itself -- see Bugbot
 * review on this PR. Throwing here surfaces through `runDaytonaEngagement`'s `afterEngagement`
 * contract (cleanup still runs, the overall call rejects) instead of corrupting the claim.
 */
export async function fetchAttemptsFromSandbox(sandbox: Sandbox, payload: EngagementPayload): Promise<AttemptRecord[]> {
  const attacksDir = `${engagementWorkspaceDir(payload)}/attacks`;
  const script = ['set -euo pipefail', "python3 - <<'PY'", buildReadAttemptsScript(attacksDir), 'PY'].join('\n');
  const response = await executeChecked(sandbox, script, '/', 60);

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.result);
  } catch (error) {
    throw new Error(
      `fetchAttemptsFromSandbox: could not parse attempts JSON read back from the sandbox: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('fetchAttemptsFromSandbox: expected a JSON array of attempts from the sandbox script');
  }

  return parsed.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    return {
      name: typeof record.name === 'string' ? record.name : undefined,
      evaluate: isRecord(record.evaluate) ? record.evaluate : {},
      report: isRecord(record.report) ? record.report : {},
      disclosure: isRecord(record.disclosure) ? record.disclosure : {},
    };
  });
}

async function writeAttemptsToLocalWorkspace(workspaceDir: string, attempts: AttemptRecord[]): Promise<void> {
  const attacksDir = path.join(workspaceDir, 'attacks');
  await mkdir(attacksDir, { recursive: true });

  for (const [index, attempt] of attempts.entries()) {
    const dir = path.join(attacksDir, attempt.name ?? `attempt-${index}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'evaluate.json'), `${JSON.stringify(attempt.evaluate, null, 2)}\n`, 'utf8');
    await writeFile(path.join(dir, 'report.json'), `${JSON.stringify(attempt.report, null, 2)}\n`, 'utf8');
    await writeFile(path.join(dir, 'disclosure.json'), `${JSON.stringify(attempt.disclosure, null, 2)}\n`, 'utf8');
  }
}

export function createAutobrinRunner(options: AutobrinRunOptions): AgentRunner {
  const contenderId = options.config.id ?? 'autobrin';
  const transport = options.config.transport ?? 'local';

  if (transport === 'daytona') {
    if (options.config.path) {
      throw new Error(`autobrin contender "${contenderId}": "path" is only supported for transport "local"`);
    }
    if (!options.config.image && !options.config.snapshot) {
      throw new Error(`autobrin contender "${contenderId}": transport "daytona" requires "image" or "snapshot"`);
    }
  }

  return {
    id: contenderId,
    type: 'autobrin',
    run({ task, target, controls, context }) {
      return transport === 'daytona'
        ? runViaDaytona({ contenderId, config: options.config, contributors: options.contributors, task, target, controls, context })
        : runViaLocalNpx({ contenderId, config: options.config, contributors: options.contributors, task, target, controls, context });
    },
  };
}

type RunInput = {
  contenderId: string;
  config: AutobrinContenderConfig;
  contributors?: number;
  task: BenchmarkTask;
  target: TargetHandle;
  controls: RunControls;
  context: RunContext;
};

async function runViaLocalNpx(input: RunInput): Promise<NormalizedResult> {
  const { contenderId, config, contributors, task, target, controls, context } = input;
  const started = Date.now();
  const checkout = await ensureAutobrinCheckout({ ref: config.ref, path: config.path });
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
      ? buildWebappPayload({ target, controls, workspaceRoot, contributors })
      : buildRepoPayload({ target, controls, workspaceRoot, contributors });

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
}

async function runViaDaytona(input: RunInput): Promise<NormalizedResult> {
  const { contenderId, config, contributors, task, target, controls, context } = input;

  if (target.modality !== 'repo' && target.modality !== 'webapp') {
    throw new Error(
      `autobrin contender "${contenderId}": transport "daytona" does not support modality "${target.modality}"`,
    );
  }
  if (target.modality === 'repo' && !target.repo) {
    throw new Error(`autobrin contender "${contenderId}": modality "repo" requires target.repo`);
  }

  const started = Date.now();
  const engagementDir = path.join(
    context.engagementsDir,
    `${slugify(contenderId)}_${slugify(task.benchmarkId)}_${slugify(task.id)}_${Date.now()}`,
  );
  await mkdir(engagementDir, { recursive: true });
  await mkdir(context.resultsDir, { recursive: true });

  // No workspaceRoot: the sandbox-side launcher defaults it to its own root (BENCHPRESS_ROOT),
  // never this (local-only) engagementDir. Webapp targets skip repo-modality-specific target
  // materialization entirely: there is no target repo to clone into the sandbox, only a URL the
  // sandbox reaches over the network (runDaytonaEngagement's own modality branch calls
  // prepareWebappTarget instead of prepareRepoTarget -- see src/daytona/bootstrap.ts).
  const payload =
    target.modality === 'webapp'
      ? buildWebappPayload({ target, controls, contributors })
      : buildRepoPayload({ target, controls, contributors });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let attempts: AttemptRecord[] = [];

  // Sequential, not concurrent: the local checkout only resolves ref -> commit SHA for
  // reporting (mirrors the local transport's reproducibility record) and is comparatively fast
  // (a shallow git fetch), but the sandbox engagement it would race against is not -- it's a
  // real, billed, multi-minute Daytona sandbox running a full multi-agent engagement. Racing
  // them via Promise.all means a fast local-checkout failure (e.g. a transient git error) still
  // lets that expensive engagement run all the way to completion for a result that gets thrown
  // away, since nothing here would be left awaiting/cancelling it. Resolving the cheap call
  // first bounds that waste to "the checkout itself never even started the sandbox".
  const checkout = await ensureAutobrinCheckout({ ref: config.ref });
  const daytonaResult = await runDaytonaEngagement({
    ref: config.ref,
    image: config.image,
    snapshot: config.snapshot,
    visionModel: config.visionModel,
    payload,
    keepSandbox: config.keepSandbox,
    onChunk: (chunk, stream) => (stream === 'stderr' ? stderrChunks : stdoutChunks).push(chunk),
    afterEngagement: async (sandbox, resolvedPayload) => {
      attempts = await fetchAttemptsFromSandbox(sandbox, resolvedPayload);
    },
  });

  const stdoutPath = path.join(context.resultsDir, `${slugify(contenderId)}_${slugify(task.id)}.stdout.log`);
  const stderrPath = path.join(context.resultsDir, `${slugify(contenderId)}_${slugify(task.id)}.stderr.log`);
  await writeFile(stdoutPath, stdoutChunks.join(''), 'utf8');
  await writeFile(stderrPath, stderrChunks.join(''), 'utf8');

  const workspaceDir = path.join(engagementDir, 'workspace');
  await writeAttemptsToLocalWorkspace(workspaceDir, attempts);
  await writeFile(
    path.join(engagementDir, 'sandbox.json'),
    `${JSON.stringify({ sandboxId: daytonaResult.sandboxId, keptSandbox: daytonaResult.keptSandbox }, null, 2)}\n`,
    'utf8',
  );

  const claim = computeClaimFromAttempts(attempts);
  const resultJson = daytonaResult.engagement.resultJson ?? {};
  const usage = resultJson.usage as { costUsd?: number } | undefined;
  const costStatus = resultJson.costStatus === 'known' ? 'known' : 'unavailable';

  return {
    contenderId,
    contenderType: 'autobrin',
    resolvedRef: checkout.ref,
    commitSha: checkout.commitSha,
    exitCode: daytonaResult.engagement.exitCode,
    durationS: Math.round((Date.now() - started) / 1000),
    costUsd: usage?.costUsd ?? null,
    costStatus,
    claim,
    engagementDir,
    workspaceDir,
    stdoutPath,
    stderrPath,
    raw: { sandboxId: daytonaResult.sandboxId },
  } satisfies NormalizedResult;
}

/**
 * Shells out to the autobrin-flue checkout's own `prepareWorkspace()` (rather than
 * reimplementing target materialization here) via a generated script. This must be a real file
 * run as `npx tsx <file>`, not `npx tsx -e <script>`: tsx's `-e`/eval mode always transforms to
 * CommonJS output, and esbuild rejects the top-level `await prepareWorkspace(...)` below under
 * that output format ("Top-level await is currently not supported with the \"cjs\" output
 * format") -- this failed on every invocation, unconditionally, until surfaced by a real
 * `repo-cve-smoke` run (see superagent-ai/benchpress#25). The import specifier must also be an
 * absolute `file://` URL rather than the relative `./src/workspace.js` a same-directory script
 * could use: once written to a temp file, `./src/workspace.js` resolves relative to that temp
 * file's own directory (ESM relative imports ignore `cwd`), not `autobrinRoot`.
 */
export async function materializeTarget(input: {
  autobrinRoot: string;
  repo: string;
  sha?: string;
  workspaceRoot: string;
}): Promise<void> {
  const workspaceModuleUrl = pathToFileURL(path.join(input.autobrinRoot, 'src', 'workspace.js')).href;
  const script = `
import { prepareWorkspace } from ${JSON.stringify(workspaceModuleUrl)};
await prepareWorkspace({
  projectRoot: process.cwd(),
  repo: ${JSON.stringify(input.repo)},
  sha: ${JSON.stringify(input.sha)},
  workspaceRoot: ${JSON.stringify(input.workspaceRoot)},
  targetPreparation: 'materialize',
});
`;
  const scriptDir = await mkdtemp(path.join(tmpdir(), 'benchpress-materialize-'));
  const scriptPath = path.join(scriptDir, 'materialize.mjs');
  await writeFile(scriptPath, script, 'utf8');
  const { exitCode, stderr } = await runCommand('npx', ['tsx', scriptPath], { cwd: input.autobrinRoot });
  if (exitCode !== 0) {
    throw new Error(`Failed to materialize target ${input.repo}: ${stderr}`);
  }
}
