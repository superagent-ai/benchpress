import path from 'node:path';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BenchmarkAdapter } from '../types.js';
import type { BenchmarkTask, ContenderClaim, TargetHandle } from '../../contenders/types.js';
import type { OracleScore } from '../../oracle/types.js';
import { readJsonRequired } from '../../lib/json.js';
import { git } from '../../lib/git.js';
import { repoRoot } from '../../lib/paths.js';
import { ensureBountyTasksVendor, ensureBountyCodebase, systemVendorDir } from './setup.js';
import { ensureSharedNetwork, composeUp, composeDown, waitForHttpReachable } from './docker.js';
import { resolveVerifier, type VerifierResult } from './verifiers.js';
import type { BountiesManifest, BountyBenchTaskMetadata, BountyBenchTaskType, BountySpec } from './types.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const TASK_TYPES: BountyBenchTaskType[] = ['detect', 'exploit', 'patch'];
const RAW_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export class BountyBenchScoreBlockedError extends Error {
  readonly taskType: BountyBenchTaskType;

  constructor(taskType: BountyBenchTaskType, taskId: string) {
    super(
      `BountyBench ${taskType} scoring for task "${taskId}" is blocked on autobrin-flue#182 ` +
        '(detect-only mode + proposed_patch disclosure output) -- not implemented. ' +
        'setup()/listTasks()/standUpTarget() work today for detect/patch tasks; score() intentionally ' +
        'throws here rather than faking a pass. See src/benchmarks/bountybench/README.md.',
    );
    this.name = 'BountyBenchScoreBlockedError';
    this.taskType = taskType;
  }
}

async function loadManifest(): Promise<BountiesManifest> {
  return readJsonRequired<BountiesManifest>(path.join(moduleDir, 'bounties.jsonc'));
}

function buildTaskId(system: string, bountyNumber: string, taskType: BountyBenchTaskType): string {
  return `${system}-${bountyNumber}-${taskType}`;
}

/**
 * BountyBench's `bounty_metadata.json` schema records `disclosure_bounty`
 * (paid for finding/reporting the vuln) and `patch_bounty` (paid for fixing
 * it). Detect and Exploit both represent "found/demonstrated the
 * vulnerability", so both are weighted by the disclosure award; Patch is
 * weighted by the patch award. See upstream `bounty_metadata_schema.json`.
 */
function dollarValueFor(bounty: BountySpec, taskType: BountyBenchTaskType): number {
  return taskType === 'patch' ? bounty.patchBountyUsd : bounty.disclosureBountyUsd;
}

function parseTargetHostPort(targetHost: string, context: string): number {
  const port = Number(targetHost.split(':')[1]);
  if (!Number.isFinite(port)) {
    throw new Error(`Cannot derive a port from target_host "${targetHost}" for ${context}`);
  }
  return port;
}

async function sanityCheckRepoRef(repo: string, ref: string): Promise<void> {
  // `git ls-remote` can confirm a branch/tag exists cheaply (no clone), but cannot resolve a raw
  // commit SHA without fetching it -- skip the check in that case rather than paying for a clone
  // just to validate a `standUpTarget()` call that AutoBrin's own repo-modality clone will
  // validate for real moments later anyway.
  if (RAW_SHA_PATTERN.test(ref)) return;
  await git(['ls-remote', '--exit-code', repo, ref], repoRoot());
}

async function standUpExploitTarget(task: BenchmarkTask, metadata: BountyBenchTaskMetadata): Promise<TargetHandle> {
  if (!metadata.targetHost) {
    throw new Error(`bountybench system "${metadata.system}" has no target_host; it cannot be an exploit (webapp) task`);
  }

  await ensureSharedNetwork();
  const vendorRoot = await ensureBountyTasksVendor();
  const systemDir = systemVendorDir(vendorRoot, metadata.system);
  const codebaseDir = await ensureBountyCodebase({
    systemId: metadata.system,
    repo: metadata.codebaseRepo,
    commit: metadata.vulnerableCommit,
  });

  // Mirrors upstream's own layout (`codebase` is a git submodule of the system directory) via a
  // plain copy rather than a symlink, so `docker compose build`'s tar-based build context always
  // sees real files regardless of the host's symlink-in-build-context support.
  const runtimeCodebaseDir = path.join(systemDir, 'codebase');
  await rm(runtimeCodebaseDir, { recursive: true, force: true });
  await cp(codebaseDir, runtimeCodebaseDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });

  await composeUp(systemDir);
  const port = parseTargetHostPort(metadata.targetHost, `${metadata.system} bounty ${metadata.bountyNumber}`);
  const url = `http://localhost:${port}`;
  await waitForHttpReachable(url, 180_000);

  const verifier = resolveVerifier(metadata.system, metadata.bountyNumber);
  if (verifier) {
    const baseline = await verifier({ runtimeDir: systemDir });
    if (baseline.exploited) {
      throw new Error(
        `${metadata.system} bounty ${metadata.bountyNumber} verifier reports an already-exploited state ` +
          `before any attack ran (${baseline.detail}); environment is not at the expected vulnerable baseline.`,
      );
    }
  }

  return buildExploitTargetHandle(task, metadata, url);
}

/**
 * Pure construction of the exploit lane's `TargetHandle` once the live URL is known -- split out
 * from `standUpExploitTarget`'s Docker/network side effects so the nested `metadata.webapp` shape
 * (matching autobrin-flue's `WebappTargetSchema` via the canonical `buildWebappPayload()` /
 * `webappTargetMetadata()` in `src/contenders/{autobrin,types}.ts`) is unit-testable without
 * standing up a real target.
 *
 * `username`/`password` are intentionally omitted: BountyBench's own `bounty_metadata.json` has no
 * structured test-credential fields, and this curated manifest doesn't add any. Bounty 0's
 * `exploitInfo` prose *does* mention a "user_b" login for the contributor to discover on its own,
 * but that is unstructured recon-hint text, not a machine-readable credential -- parsing it into
 * `username`/`password` here would silently turn a black-box assessment into a pre-authenticated
 * one (see the "known limitation" note in README.md's real end-to-end run). Leave both undefined
 * rather than inventing a placeholder or scraping free text.
 */
export function buildExploitTargetHandle(task: BenchmarkTask, metadata: BountyBenchTaskMetadata, url: string): TargetHandle {
  return {
    benchmarkId: 'bountybench',
    taskId: task.id,
    modality: 'webapp',
    repo: metadata.codebaseRepo,
    sha: metadata.vulnerableCommit,
    metadata: {
      ...metadata,
      webapp: {
        url,
        repo: metadata.codebaseRepo,
        sha: metadata.vulnerableCommit,
        username: undefined,
        password: undefined,
      },
    },
  };
}

async function standUpRepoSnapshotTarget(task: BenchmarkTask, metadata: BountyBenchTaskMetadata): Promise<TargetHandle> {
  await sanityCheckRepoRef(metadata.codebaseRepo, metadata.vulnerableCommit);
  return {
    benchmarkId: 'bountybench',
    taskId: task.id,
    modality: 'repo',
    repo: metadata.codebaseRepo,
    sha: metadata.vulnerableCommit,
    metadata,
  };
}

/**
 * Pure grader-vs-self-verdict mapping (same TP/FP/FN pattern as
 * `repo-cve-smoke`'s `scoreFixCommitOverlap`): the per-vuln verifier is the
 * score, a self-verdict without a matching verifier result is a false
 * positive, and dollar value only accrues on a true positive. Exported and
 * unit-tested independently of the live DB query in `scoreExploit`/`verifiers.ts`.
 */
export function buildExploitOracleScore(
  metadata: BountyBenchTaskMetadata,
  result: VerifierResult,
  claim: ContenderClaim,
): OracleScore {
  const selfConfirmed = (claim.selfVerdictCounts.confirmed ?? 0) > 0;
  const signalMetadata = { system: metadata.system, bountyNumber: metadata.bountyNumber, cwe: metadata.cwe, cve: metadata.cve };

  if (result.exploited) {
    return {
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      trueNegatives: 0,
      dollarValue: metadata.dollarValue,
      signals: [{ outcome: 'true_positive', matched: true, reason: result.detail, metadata: signalMetadata }],
    };
  }

  if (selfConfirmed) {
    return {
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 0,
      trueNegatives: 0,
      signals: [
        {
          outcome: 'false_positive',
          matched: false,
          reason: `Contender self-verdict confirmed but per-vuln verifier disagreed: ${result.detail}`,
          metadata: signalMetadata,
        },
      ],
    };
  }

  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 1,
    trueNegatives: 0,
    signals: [{ outcome: 'false_negative', matched: false, reason: result.detail, metadata: signalMetadata }],
  };
}

async function scoreExploit(metadata: BountyBenchTaskMetadata, claim: ContenderClaim): Promise<OracleScore> {
  const verifier = resolveVerifier(metadata.system, metadata.bountyNumber);
  if (!verifier) {
    throw new Error(
      `No verifier wired for ${metadata.system} bounty ${metadata.bountyNumber} -- this representative subset ` +
        'only ports the real verify_state.py logic for lunary bounty 0 today (see README.md "Coverage").',
    );
  }

  const vendorRoot = await ensureBountyTasksVendor();
  const runtimeDir = systemVendorDir(vendorRoot, metadata.system);
  const result = await verifier({ runtimeDir });
  return buildExploitOracleScore(metadata, result, claim);
}

export const bountyBenchAdapter: BenchmarkAdapter = {
  id: 'bountybench',
  lane: 'scientific',
  description:
    'BountyBench: real bug-bounty systems (25 systems, 40 bounties, $10-$30,485) scored by per-vuln verifiers ' +
    'across Detect/Exploit/Patch task types. Partially implemented -- see README.md for exact coverage.',

  async setup() {
    // Cheap, offline sanity check that the curated manifest is well-formed. Heavier vendoring
    // (git clones, docker) is deferred to standUpTarget() for the one task that needs it.
    const manifest = await loadManifest();
    if (manifest.systems.length === 0) throw new Error('bountybench manifest has no systems configured');
  },

  async listTasks(): Promise<BenchmarkTask[]> {
    const manifest = await loadManifest();
    const tasks: BenchmarkTask[] = [];
    for (const system of manifest.systems) {
      for (const bounty of system.bounties) {
        // A library-only system (empty target_host, e.g. parse-url/zipp) has no live network
        // service to attack: BountyBench's own Exploit task type only makes sense against a
        // running system. Advertising an "exploit" task here that standUpTarget() can never stand
        // up would be dishonest, not just unimplemented -- see README.md "Coverage".
        const taskTypesForSystem = system.targetHost ? TASK_TYPES : TASK_TYPES.filter((t) => t !== 'exploit');
        for (const taskType of taskTypesForSystem) {
          const metadata: BountyBenchTaskMetadata = {
            system: system.id,
            bountyNumber: bounty.number,
            taskType,
            codebaseRepo: system.codebaseRepo,
            targetHost: system.targetHost,
            vulnerableCommit: bounty.vulnerableCommit,
            cwe: bounty.cwe,
            cve: bounty.cve,
            severity: bounty.severity,
            dollarValue: dollarValueFor(bounty, taskType),
            exploitInfo: bounty.exploitInfo,
          };
          tasks.push({ id: buildTaskId(system.id, bounty.number, taskType), benchmarkId: 'bountybench', metadata });
        }
      }
    }
    return tasks;
  },

  async standUpTarget(task: BenchmarkTask): Promise<TargetHandle> {
    const metadata = task.metadata as BountyBenchTaskMetadata;
    return metadata.taskType === 'exploit'
      ? standUpExploitTarget(task, metadata)
      : standUpRepoSnapshotTarget(task, metadata);
  },

  async score(input: { task: BenchmarkTask; target: TargetHandle; claim: ContenderClaim }): Promise<OracleScore> {
    const metadata = input.task.metadata as BountyBenchTaskMetadata;
    if (metadata.taskType !== 'exploit') {
      throw new BountyBenchScoreBlockedError(metadata.taskType, input.task.id);
    }
    return scoreExploit(metadata, input.claim);
  },

  isScoreable(task: BenchmarkTask): boolean {
    const metadata = task.metadata as BountyBenchTaskMetadata;
    // Mirrors score()'s own gating: detect/patch always throw (blocked on autobrin-flue#182), and
    // exploit only actually scores where a verifier is wired (see verifiers.ts "Coverage").
    return metadata.taskType === 'exploit' && resolveVerifier(metadata.system, metadata.bountyNumber) !== undefined;
  },

  async teardown(task: BenchmarkTask): Promise<void> {
    const metadata = task.metadata as BountyBenchTaskMetadata;
    if (metadata.taskType !== 'exploit') return;
    const vendorRoot = await ensureBountyTasksVendor().catch(() => undefined);
    if (!vendorRoot) return;
    await composeDown(systemVendorDir(vendorRoot, metadata.system)).catch(() => undefined);
  },
};
