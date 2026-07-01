/**
 * Real upstream shape: sunblaze-ucb/cybergym (arXiv:2506.02548), task metadata
 * vendored from https://huggingface.co/datasets/sunblaze-ucb/cybergym `tasks.json`.
 *
 * `taskType` mirrors upstream's `TaskType` enum (`src/cybergym/task/types.py`):
 * benchmark instances are sourced either from the ARVO corpus (`n132/arvo`
 * Docker Hub images) or directly from OSS-Fuzz (`cybergym/oss-fuzz` images).
 * `oss-fuzz-latest` (open-ended zero-day discovery mode, not a scored task) is
 * intentionally out of scope here.
 */
export type CyberGymTaskType = 'arvo' | 'oss-fuzz';

/** Upstream difficulty ladder (`TaskDifficulty` in `src/cybergym/task/types.py`). */
export type CyberGymDifficulty = 'level0' | 'level1' | 'level2' | 'level3';

export type CyberGymTaskSpec = {
  /** `<taskType>:<upstreamId>`, e.g. "arvo:1065" -- matches upstream `task_id`. */
  taskId: string;
  taskType: CyberGymTaskType;
  upstreamId: string;
  projectName: string;
  projectMainRepo: string;
  projectLanguage: string;
  /** Upstream `vulnerability_description` (GPT-4.1-rephrased commit message). */
  vulnerabilityDescription: string;
  /** Sanitizer + crash type parsed from this task's `error.txt` `SUMMARY:` line (not a tasks.json field -- CyberGym's 28 crash types are only reported there). */
  sanitizer: string;
  crashType: string;
  /**
   * Difficulty pinned to level1 ("one-day-with-source": repo-vul.tar.gz +
   * description.txt) for every vendored task -- issue #16's fair-comparison
   * lane, since AutoBrin is source-first and a zero-day/codebase-only lane
   * (level0) would disadvantage it relative to fuzzing-first baselines.
   */
  difficulty: Extract<CyberGymDifficulty, 'level1'>;
  /** Base path for this task's files in the sunblaze-ucb/cybergym HF dataset, e.g. "data/arvo/1065". */
  hfDataDir: string;
  /** sha256 of `repo-vul.tar.gz` at `hfDataDir`, pinned for download integrity verification. */
  repoVulSha256: string;
  /** Docker Hub repo hosting this task's pre-/post-patch build envs (`n132/arvo` or `cybergym/oss-fuzz`). */
  dockerRepo: string;
  vulImageTag: string;
  fixImageTag: string;
  /**
   * Name of the libFuzzer/AFL binary under `/out/` in both images that this
   * specific task's vulnerability lives behind, parsed from `error.txt`'s
   * `Running: /tmp/poc` banner (OSS-Fuzz-sourced images in particular can
   * ship dozens of unrelated fuzz targets in one `/out/`, so "pick any
   * executable" is not reliable -- this must be pinned per task).
   */
  fuzzerBinary: string;
};

const CYBERGYM_HF_DATASET_BASE_URL = 'https://huggingface.co/datasets/sunblaze-ucb/cybergym/resolve/main';

export function cyberGymHfFileUrl(spec: CyberGymTaskSpec, fileName: string): string {
  return `${CYBERGYM_HF_DATASET_BASE_URL}/${spec.hfDataDir}/${fileName}`;
}

/** `n132/arvo:1065-vul` / `cybergym/oss-fuzz:42535468-fix`, etc. */
export function cyberGymDockerImageRef(spec: CyberGymTaskSpec, variant: 'vul' | 'fix'): string {
  const tag = variant === 'vul' ? spec.vulImageTag : spec.fixImageTag;
  return `${spec.dockerRepo}:${tag}`;
}
