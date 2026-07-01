import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkAdapter } from '../types.js';
import { NotImplementedBenchmarkError } from '../types.js';
import type { BenchmarkTask, TargetHandle } from '../../contenders/types.js';
import { readJsonRequired } from '../../lib/json.js';
import { cacheRoot } from '../../lib/paths.js';
import { ensureFileDownloaded } from '../../lib/http.js';
import { ensureDockerImage, type PulledDockerImage } from '../../lib/docker.js';
import { extractTarGz } from '../../lib/archive.js';
import { cyberGymDockerImageRef, cyberGymHfFileUrl, type CyberGymTaskSpec } from './types.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const CYBERGYM_DEPENDENCY =
  'Requires autobrin-flue PoC-generation contributor skill (superagent-ai/autobrin-flue#180) and ' +
  'differential patched-oracle confirmation primitive (superagent-ai/autobrin-flue#181). Both are open ' +
  'and unmerged into staging as of this adapter -- setup()/listTasks()/standUpTarget() are real ' +
  '(vendored task metadata, real pre-/post-patch Docker pulls); score() intentionally throws rather ' +
  'than fake a result.';

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
 * Deliberately omits `repo`/`sha`: ARVO/OSS-Fuzz benchmark instances are
 * frozen dockerized snapshots with no live-clonable git ref at the vulnerable
 * state. The generic autobrin contender (`src/contenders/autobrin.ts`)
 * git-clones `target.repo`@`target.sha` whenever both are set on a
 * `modality: 'repo'` target -- setting `repo` here would silently clone the
 * *live* HEAD of the upstream project (a different, unrelated codebase)
 * instead of the pinned vulnerable snapshot already extracted to
 * `metadata.sourceDir`. `metadata.projectMainRepo` still carries the
 * upstream URL for informational/provenance purposes.
 */
export function buildCyberGymTargetHandle(taskId: string, metadata: CyberGymTargetMetadata): TargetHandle {
  return {
    benchmarkId: 'cybergym',
    taskId,
    modality: 'repo',
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
    // future differential oracle (autobrin-flue#181) -- it must never reach a
    // contributor authoring a PoC against the vul image.
    const vulImage = await ensureDockerImage(cyberGymDockerImageRef(spec, 'vul'));
    const fixImage = await ensureDockerImage(cyberGymDockerImageRef(spec, 'fix'));

    const metadata: CyberGymTargetMetadata = { ...spec, sourceDir, descriptionPath, vulImage, fixImage };
    return buildCyberGymTargetHandle(task.id, metadata);
  },

  score() {
    throw new NotImplementedBenchmarkError('cybergym', CYBERGYM_DEPENDENCY);
  },
};
