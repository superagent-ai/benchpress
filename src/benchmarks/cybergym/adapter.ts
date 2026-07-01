import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkAdapter } from '../types.js';
import type { BenchmarkTask, TargetHandle } from '../../contenders/types.js';
import type { OracleScore } from '../../oracle/types.js';
import { readJsonRequired } from '../../lib/json.js';
import { cacheRoot } from '../../lib/paths.js';
import { ensureFileDownloaded } from '../../lib/http.js';
import { ensureDockerImage, type PulledDockerImage } from '../../lib/docker.js';
import { extractTarGz } from '../../lib/archive.js';
import { cyberGymDockerImageRef, cyberGymHfFileUrl, type CyberGymTaskSpec } from './types.js';
import { scoreCyberGymClaim } from './score.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export type CyberGymTargetMetadata = CyberGymTaskSpec & {
  /** Local extracted copy of `repo-vul.tar.gz` -- the only codebase a contributor may see (level1). */
  sourceDir: string;
  descriptionPath: string;
  /** Pre-patch build env. Fair game to hand to a future PoC-authoring contributor. */
  vulImage: PulledDockerImage;
  /** Post-patch build env, for the harness's own differential oracle only -- never expose to a contributor. */
  fixImage: PulledDockerImage;
};

async function loadTaskSpecs(): Promise<CyberGymTaskSpec[]> {
  const { tasks } = await readJsonRequired<{ tasks: CyberGymTaskSpec[] }>(path.join(moduleDir, 'tasks.jsonc'));
  return tasks;
}

/**
 * Pure TargetHandle builder, split out from standUpTarget() so its shape is
 * unit-testable without Docker/network.
 *
 * `repo` is set to the local, already-extracted, sha256-verified
 * `metadata.sourceDir` -- deliberately NOT `metadata.projectMainRepo` (the
 * live upstream GitHub URL). The generic autobrin contender
 * (`src/contenders/autobrin.ts`) materializes `target.repo`@`target.sha`
 * into the engagement workspace via autobrin-flue's `prepareWorkspace()`
 * whenever `repo` is set on a `modality: 'repo'` target; if `repo` were the
 * upstream URL, that would silently clone the *live* HEAD of an unrelated
 * codebase instead of the pinned vulnerable snapshot. Because `sourceDir`
 * resolves to a local, non-git directory, autobrin-flue's own
 * `cloneOrCopyTarget()` takes its plain-copy branch (no git involved) and
 * the contributor gets the real vulnerable source under `workspace/target`.
 * `sha` stays unset -- there is no commit to pin a plain directory copy to,
 * and autobrin-flue's `targetPreparation: "prepared"` re-check only
 * enforces a matching `HEAD` when `sha` is present. `metadata.sourceDir`
 * and `metadata.projectMainRepo` still carry both values directly for
 * anything (e.g. `score()`) that needs to tell them apart.
 */
export function buildCyberGymTargetHandle(taskId: string, metadata: CyberGymTargetMetadata): TargetHandle {
  return {
    benchmarkId: 'cybergym',
    taskId,
    modality: 'repo',
    repo: metadata.sourceDir,
    metadata,
  };
}

export const cyberGymAdapter: BenchmarkAdapter = {
  id: 'cybergym',
  lane: 'scientific',
  description: 'CyberGym: dockerized memory-safety tasks with sanitizer verification.',

  async setup() {
    // Tasks are a vendored, curated subset (tasks.jsonc) of upstream's 1,507 --
    // the full corpus is ~240GB, so there is no single global vendor clone to
    // do here (contrast cve-bench's single-repo vendor.lock.json). Per-task
    // source tarballs and Docker images are pulled lazily in standUpTarget().
  },

  async listTasks(): Promise<BenchmarkTask[]> {
    const specs = await loadTaskSpecs();
    return specs.map((spec) => ({
      id: spec.taskId,
      benchmarkId: 'cybergym',
      metadata: spec,
    }));
  },

  async standUpTarget(task: BenchmarkTask): Promise<TargetHandle> {
    const spec = task.metadata as CyberGymTaskSpec;
    const taskCacheDir = path.join(cacheRoot(), 'vendor', 'cybergym', spec.taskId.replace(':', '_'));
    await mkdir(taskCacheDir, { recursive: true });

    // Level1 ("one-day-with-source"): vulnerable codebase + text description
    // only. Never fetch repo-fix.tar.gz / error.txt / patch.diff here -- those
    // back harder difficulty levels and would leak the fix/crash trace.
    const tarballPath = await ensureFileDownloaded(
      cyberGymHfFileUrl(spec, 'repo-vul.tar.gz'),
      path.join(taskCacheDir, 'repo-vul.tar.gz'),
      { expectedSha256: spec.repoVulSha256 },
    );
    const descriptionPath = await ensureFileDownloaded(
      cyberGymHfFileUrl(spec, 'description.txt'),
      path.join(taskCacheDir, 'description.txt'),
    );
    // Keyed on the verified sha256, not just "destDir is non-empty" -- so a
    // future tasks.jsonc checksum update can't silently leave a stale tree.
    const sourceDir = await extractTarGz(tarballPath, path.join(taskCacheDir, 'repo-vul'), spec.repoVulSha256);

    // Pull both pre-/post-patch dockerized build envs up front (once per task,
    // fairness invariant: benchpress stands up ONE target and fans it out to
    // every contender). The fix image exists solely for the harness's own
    // differential oracle (score.ts, autobrin-flue#181) -- it must never reach a
    // contributor authoring a PoC against the vul image.
    const vulImage = await ensureDockerImage(cyberGymDockerImageRef(spec, 'vul'));
    const fixImage = await ensureDockerImage(cyberGymDockerImageRef(spec, 'fix'));

    const metadata: CyberGymTargetMetadata = { ...spec, sourceDir, descriptionPath, vulImage, fixImage };
    return buildCyberGymTargetHandle(task.id, metadata);
  },

  /**
   * Real for `autobrin` contenders: replays the confirmed attempt's `repro.sh` via
   * autobrin-flue's differential-oracle CLI (superagent-ai/autobrin-flue#181) against the
   * pulled `fixImage`, using the PoC-generation contributor skill's output (autobrin-flue#180)
   * as the attempt to replay. Both capabilities merged into `staging` (see issue #28) -- see
   * `score.ts` for the exact mechanism and README.md for the non-autobrin (e.g. PITHOS) scoping
   * decision.
   */
  async score(input): Promise<OracleScore> {
    return scoreCyberGymClaim({ target: input.target, result: input.result });
  },
};
