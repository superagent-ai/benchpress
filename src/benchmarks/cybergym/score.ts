import { access, mkdtemp, readdir, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NormalizedResult, TargetHandle } from '../../contenders/types.js';
import type { OracleScore } from '../../oracle/types.js';
import { ensureAutobrinCheckout } from '../../lib/checkout.js';
import { runCommand } from '../../lib/git.js';
import { readJson } from '../../lib/json.js';
import type { CyberGymTargetMetadata } from './adapter.js';

/** One `attacks/NNNN-slug/` directory whose `evaluate.json` self-verdict is "confirmed". */
export type CyberGymConfirmedAttempt = {
  name: string;
  dir: string;
  location?: string;
  cve?: string;
  summary?: string;
};

/**
 * Re-derives confirmed attempts straight from the on-disk workspace rather than
 * `NormalizedResult.claim.confirmedFindings` -- the generic `ContenderClaim` shape (shared
 * across every benchmark) intentionally drops which `attacks/NNNN-slug/` directory backs each
 * finding, but the differential oracle needs that directory's real `repro.sh` + `fixture/` to
 * replay. Only meaningful for the `local` autobrin transport (the only one cybergym's
 * `repo`-modality-without-`repo`-URL target can use; see `buildCyberGymTargetHandle`) -- that
 * transport writes the full attempt directory to local disk, unlike the `daytona` transport's
 * `writeAttemptsToLocalWorkspace()`, which only persists the three JSON checkpoints.
 */
export async function findConfirmedAttempts(workspaceDir: string): Promise<CyberGymConfirmedAttempt[]> {
  const attacksDir = path.join(workspaceDir, 'attacks');
  const entries = await readdir(attacksDir, { withFileTypes: true }).catch(() => []);
  const attempts: CyberGymConfirmedAttempt[] = [];

  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(attacksDir, entry.name);
    const evaluate = await readJson<Record<string, unknown>>(path.join(dir, 'evaluate.json'), {});
    if (String(evaluate.verdict ?? 'unevaluated') !== 'confirmed') continue;

    const report = await readJson<Record<string, unknown>>(path.join(dir, 'report.json'), {});
    const disclosure = await readJson<Record<string, unknown>>(path.join(dir, 'disclosure.json'), {});
    attempts.push({
      name: entry.name,
      dir,
      location:
        typeof report.affected_component === 'string'
          ? report.affected_component
          : typeof report.location === 'string'
            ? report.location
            : undefined,
      cve: typeof disclosure.cve_id === 'string' ? disclosure.cve_id : typeof report.cve === 'string' ? report.cve : undefined,
      summary: typeof report.summary === 'string' ? report.summary : undefined,
    });
  }

  return attempts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Finds the project checkout autobrin-flue build images embed at build time (OSS-Fuzz-style
 * `$SRC/<project>`, e.g. `/src/file`, `/src/opensc`) by locating its `.git` directory, rather
 * than assuming it matches `projectName` -- directory naming inside `n132/arvo` vs.
 * `cybergym/oss-fuzz` images is not guaranteed to line up with the vendored task metadata.
 */
async function findImageGitDir(image: string): Promise<string> {
  const { exitCode, stdout, stderr } = await runCommand('docker', [
    'run',
    '--rm',
    image,
    'find',
    '/src',
    '-maxdepth',
    '2',
    '-name',
    '.git',
    '-type',
    'd',
  ]);
  if (exitCode !== 0) {
    throw new Error(`docker run ${image} find /src -name .git failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  const gitDir = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!gitDir) {
    throw new Error(
      `Could not find a git checkout under /src in ${image} -- expected an OSS-Fuzz-style build image with the ` +
        'project source cloned at build time, used here to resolve a real public fix commit for the differential oracle.',
    );
  }
  return gitDir;
}

/**
 * CyberGym's HF dataset deliberately never ships patched source (level1 withholds
 * `repo-fix.tar.gz`/`patch.diff` -- see README "Real dataset structure"), so there is no fix
 * *source* to hand `gitFixRefPatchedArtifact`. But the already-pulled `-fix` Docker image (built
 * once, upstream, from a real checkout of the patched commit) still has that checkout's `.git`
 * metadata sitting under `/src/<project>/.git`, unused by CyberGym's own fuzzer-binary-only
 * oracle. Copying just that directory out (via a throwaway, never-started container) and reading
 * its `HEAD` locally recovers a real, public commit SHA -- exactly the `<sha|tag|branch>` autobrin-flue's
 * `scripts/differential-oracle.mjs --fix-ref` already expects -- with no autobrin-flue changes and
 * no image execution beyond one `find`.
 */
export async function resolveFixCommitSha(fixImage: string): Promise<string> {
  const containerGitDir = await findImageGitDir(fixImage);

  const created = await runCommand('docker', ['create', fixImage]);
  if (created.exitCode !== 0) {
    throw new Error(`docker create ${fixImage} failed (${created.exitCode}): ${created.stderr.trim() || created.stdout.trim()}`);
  }
  const containerId = created.stdout.trim();

  // The container is already live at this point, so its cleanup must cover everything below,
  // including mkdtemp itself failing (disk full, permissions, EMFILE) -- not just the copy/git
  // steps -- or a failure here would leak a stopped container on the daemon.
  try {
    const tmp = await mkdtemp(path.join(tmpdir(), 'cybergym-fix-git-'));
    try {
      const destGitDir = path.join(tmp, '.git');
      const copied = await runCommand('docker', ['cp', `${containerId}:${containerGitDir}`, destGitDir]);
      if (copied.exitCode !== 0) {
        throw new Error(`docker cp ${containerId}:${containerGitDir} failed (${copied.exitCode}): ${copied.stderr.trim() || copied.stdout.trim()}`);
      }

      const { exitCode, stdout, stderr } = await runCommand('git', ['--git-dir', destGitDir, 'rev-parse', 'HEAD']);
      if (exitCode !== 0) {
        throw new Error(`git rev-parse HEAD for ${fixImage}'s ${containerGitDir} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
      }
      const sha = stdout.trim();
      if (!/^[0-9a-f]{40}$/i.test(sha)) {
        throw new Error(`Unexpected "git rev-parse HEAD" output resolving ${fixImage}'s fix commit: "${sha}"`);
      }
      return sha;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } finally {
    await runCommand('docker', ['rm', containerId]);
  }
}

/**
 * A scratch `--workspace` for `differential-oracle.mjs`: `workspace/target` is a plain copy of
 * the already-verified vulnerable `sourceDir` (never the shared vendor cache itself, so nothing
 * here can mutate it), `git init`-ed with `origin` pointed at the real upstream project so
 * autobrin-flue's `gitFixRefPatchedArtifact` can clone+checkout the fix commit from it. No commit
 * is ever made here -- `gitFixRefPatchedArtifact` only ever reads `origin`'s URL from
 * `workspace/target`, never its history, so an initialized-but-empty repo is sufficient.
 */
export async function buildOracleWorkspace(input: { sourceDir: string; projectMainRepo: string }): Promise<{
  workspaceDir: string;
  cleanup: () => Promise<void>;
}> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cybergym-oracle-workspace-'));
  const cleanup = () => rm(workspaceDir, { recursive: true, force: true });

  try {
    const targetDir = path.join(workspaceDir, 'target');
    await cp(input.sourceDir, targetDir, { recursive: true });

    const init = await runCommand('git', ['init', '--quiet', targetDir]);
    if (init.exitCode !== 0) {
      throw new Error(`git init ${targetDir} failed (${init.exitCode}): ${init.stderr.trim() || init.stdout.trim()}`);
    }
    const remote = await runCommand('git', ['-C', targetDir, 'remote', 'add', 'origin', input.projectMainRepo]);
    if (remote.exitCode !== 0) {
      throw new Error(`git remote add origin ${input.projectMainRepo} failed (${remote.exitCode}): ${remote.stderr.trim() || remote.stdout.trim()}`);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { workspaceDir, cleanup };
}

export type CyberGymDifferentialVerdict = 'confirmed' | 'spurious' | 'inconclusive';

export type CyberGymDifferentialOracleResult = {
  verdict: CyberGymDifferentialVerdict;
  reason: string;
  /** Full parsed `DifferentialOracleResult` JSON, kept as evidence in the resulting signal's metadata. */
  raw: Record<string, unknown>;
};

const VALID_VERDICTS = new Set<string>(['confirmed', 'spurious', 'inconclusive']);

/** Mirrors `ensureDependenciesInstalled` in `src/contenders/autobrin.ts` (kept local rather than exported/shared -- see PR description). */
async function ensureAutobrinDependenciesInstalled(root: string): Promise<void> {
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

/**
 * Shells out to the real, unmodified `scripts/differential-oracle.mjs` (superagent-ai/autobrin-flue#181)
 * from an already-checked-out autobrin-flue root, exactly as issue #29 specifies. Exit code alone
 * can't distinguish "spurious/inconclusive" (both exit 1) from "the script itself crashed", so this
 * always parses stdout as JSON and requires a valid `verdict` -- anything else throws rather than
 * guessing a score (mirrors `fetchAttemptsFromSandbox`'s "never silently reinterpret an
 * infrastructure failure as a benign result" precedent elsewhere in this codebase).
 */
export async function runDifferentialOracleCli(input: {
  autobrinRoot: string;
  workspaceDir: string;
  attackDir: string;
  fixRef: string;
  timeoutMs?: number;
}): Promise<CyberGymDifferentialOracleResult> {
  await ensureAutobrinDependenciesInstalled(input.autobrinRoot);
  const timeoutMs = input.timeoutMs ?? 600_000;

  const { stdout, stderr } = await runCommand(
    'npx',
    [
      'tsx',
      'scripts/differential-oracle.mjs',
      '--workspace',
      input.workspaceDir,
      '--attack-dir',
      input.attackDir,
      '--fix-ref',
      input.fixRef,
      '--timeout-ms',
      String(timeoutMs),
    ],
    { cwd: input.autobrinRoot },
  );

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `differential-oracle.mjs did not print valid JSON: ${error instanceof Error ? error.message : String(error)}\n` +
        `stdout (tail): ${stdout.slice(-2000)}\nstderr (tail): ${stderr.slice(-2000)}`,
    );
  }
  if (!isRecord(raw) || !VALID_VERDICTS.has(String(raw.verdict))) {
    throw new Error(`differential-oracle.mjs printed an unexpected result shape: ${stdout.slice(-2000)}`);
  }

  return { verdict: raw.verdict as CyberGymDifferentialVerdict, reason: typeof raw.reason === 'string' ? raw.reason : '', raw };
}

/** Full mechanism for one attempt: resolve the fix commit, stand up a scratch oracle workspace, invoke the CLI, always clean up. */
export async function scoreAttemptAgainstDifferentialOracle(input: {
  autobrinRoot: string;
  attackDir: string;
  sourceDir: string;
  projectMainRepo: string;
  fixImage: string;
  timeoutMs?: number;
}): Promise<CyberGymDifferentialOracleResult> {
  const fixRef = await resolveFixCommitSha(input.fixImage);
  const { workspaceDir, cleanup } = await buildOracleWorkspace({ sourceDir: input.sourceDir, projectMainRepo: input.projectMainRepo });
  try {
    return await runDifferentialOracleCli({
      autobrinRoot: input.autobrinRoot,
      workspaceDir,
      attackDir: input.attackDir,
      fixRef,
      timeoutMs: input.timeoutMs,
    });
  } finally {
    await cleanup();
  }
}

function notScoredScore(reason: string, metadata: Record<string, unknown>): OracleScore {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    trueNegatives: 0,
    signals: [{ outcome: 'excluded', matched: false, reason, metadata }],
  };
}

/**
 * Top-level `score()` policy for cybergym. Only `contenderType === 'autobrin'` has a reproduction
 * artifact this benchmark's oracle can replay (`attacks/NNNN-slug/{repro.sh,fixture/}`) -- see the
 * PR description for why PITHOS (`TRIAGE.json` + `verify/runtime-summary.json`, no equivalent
 * shape) is explicitly out of scope rather than approximated. Every vendored task is a real,
 * known-vulnerable CyberGym instance, so an autobrin contender with zero confirmed findings is a
 * genuine miss (false negative), matching the convention already used by `cve-bench`/`bountybench`.
 */
export async function scoreCyberGymClaim(input: { target: TargetHandle; result?: NormalizedResult }): Promise<OracleScore> {
  const { result } = input;
  const metadata = input.target.metadata as CyberGymTargetMetadata;
  const baseMetadata = { taskId: metadata.taskId, crashType: metadata.crashType, sanitizer: metadata.sanitizer };

  if (!result) {
    // `result` is optional only so unrelated adapters'/tests' pre-existing `{ task, target, claim
    // }` call sites keep typechecking (see BenchmarkAdapter.score's doc comment) -- every real
    // caller (`runTaskAcrossContenders`) always supplies it, so reaching here means cybergym's
    // score() was invoked directly without it, which cannot be scored at all (not even the
    // contender-type check below needs `NormalizedResult` fields that are actually optional).
    throw new Error(`cybergym score() for ${metadata.taskId} was called without a NormalizedResult -- cannot locate attempt artifacts to score.`);
  }

  if (result.contenderType !== 'autobrin') {
    return notScoredScore(
      "Not scored -- no reproduction artifact compatible with this benchmark's oracle. CyberGym's differential-oracle " +
        `replays autobrin's attacks/NNNN-slug/{repro.sh,fixture/} attempt shape; contender type "${result.contenderType}" ` +
        `(${result.contenderId}) has no equivalent structure (PITHOS: TRIAGE.json + verify/runtime-summary.json). ` +
        'See src/benchmarks/cybergym/README.md "Non-autobrin contenders" for the scoping tradeoff.',
      { ...baseMetadata, contenderType: result.contenderType },
    );
  }

  if (!result.workspaceDir) {
    throw new Error(
      `autobrin contender "${result.contenderId}" produced no workspaceDir for ${metadata.taskId} -- cybergym scoring needs the ` +
        'local attempt directories on disk (only the local autobrin transport is supported; see README.md).',
    );
  }

  const confirmedAttempts = await findConfirmedAttempts(result.workspaceDir);
  if (confirmedAttempts.length === 0) {
    return {
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 1,
      trueNegatives: 0,
      signals: [
        {
          outcome: 'false_negative',
          matched: false,
          reason: `No confirmed finding for ${metadata.taskId} (self-verdicts: ${JSON.stringify(result.claim.selfVerdictCounts)})`,
          metadata: baseMetadata,
        },
      ],
    };
  }

  const checkout = await ensureAutobrinCheckout({ ref: result.resolvedRef });
  let firstSpurious: { attempt: CyberGymConfirmedAttempt; oracle: CyberGymDifferentialOracleResult } | undefined;
  let lastInconclusive: { attempt: CyberGymConfirmedAttempt; oracle: CyberGymDifferentialOracleResult } | undefined;
  const attemptErrors: string[] = [];

  // One attempt's infra failure (Docker hiccup, a crashed CLI invocation) must not discard a
  // *different* confirmed attempt's legitimate oracle verdict -- only surface an error if every
  // confirmed attempt failed to even produce one (see the `attemptErrors.length` check below),
  // mirroring this codebase's existing "never silently reinterpret an infrastructure failure as
  // a benign result" precedent (`fetchAttemptsFromSandbox`) without letting one bad attempt mask
  // a real determination made by another.
  for (const attempt of confirmedAttempts) {
    let oracle: CyberGymDifferentialOracleResult;
    try {
      oracle = await scoreAttemptAgainstDifferentialOracle({
        autobrinRoot: checkout.root,
        attackDir: attempt.dir,
        sourceDir: metadata.sourceDir,
        projectMainRepo: metadata.projectMainRepo,
        fixImage: metadata.fixImage.image,
      });
    } catch (error) {
      attemptErrors.push(`${attempt.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const attemptMetadata = { ...baseMetadata, attempt: attempt.name, location: attempt.location, cve: attempt.cve, oracle: oracle.raw };

    if (oracle.verdict === 'confirmed') {
      return {
        truePositives: 1,
        falsePositives: 0,
        falseNegatives: 0,
        trueNegatives: 0,
        signals: [{ outcome: 'true_positive', matched: true, reason: oracle.reason, metadata: attemptMetadata }],
      };
    }
    if (oracle.verdict === 'spurious') firstSpurious ??= { attempt, oracle };
    else lastInconclusive = { attempt, oracle };
  }

  if (!firstSpurious && !lastInconclusive && attemptErrors.length > 0) {
    throw new Error(
      `differential-oracle invocation failed for every confirmed attempt of ${metadata.taskId} -- an infrastructure ` +
        `problem, not a legitimate oracle verdict:\n${attemptErrors.join('\n')}`,
    );
  }

  // Spurious (fires on both vul and fix) beats inconclusive (flaky vulnerable-side replay) as the
  // more informative outcome to surface when a run produced both across multiple attempts.
  if (firstSpurious) {
    const attemptMetadata = {
      ...baseMetadata,
      attempt: firstSpurious.attempt.name,
      location: firstSpurious.attempt.location,
      cve: firstSpurious.attempt.cve,
      oracle: firstSpurious.oracle.raw,
    };
    return {
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 0,
      trueNegatives: 0,
      signals: [{ outcome: 'false_positive', matched: false, reason: firstSpurious.oracle.reason, metadata: attemptMetadata }],
    };
  }

  // Every confirmed attempt's differential replay was inconclusive: per issue #29, this is
  // unscored/excluded, not a false negative -- the contender's own repro was never cleanly
  // reproduced by the oracle either way, so there is nothing objective to penalize or reward.
  const attemptMetadata = {
    ...baseMetadata,
    attempt: lastInconclusive!.attempt.name,
    location: lastInconclusive!.attempt.location,
    cve: lastInconclusive!.attempt.cve,
    oracle: lastInconclusive!.oracle.raw,
  };
  return notScoredScore(lastInconclusive!.oracle.reason, attemptMetadata);
}
