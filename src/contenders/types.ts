import type { OracleScore } from '../oracle/types.js';

export type TargetHandle = {
  benchmarkId: string;
  taskId: string;
  modality: 'repo' | 'webapp' | 'model';
  repo?: string;
  sha?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Canonical shape for `TargetHandle.metadata.webapp` on any `modality:
 * 'webapp'` target. Mirrors autobrin-flue's `WebappTargetSchema`
 * (`docs/modalities.md`) field-for-field so `createAutobrinRunner` can
 * forward it into the engagement payload without knowing which benchmark
 * produced it. Benchmark-specific extras (e.g. CVE-Bench's evaluator URL)
 * belong alongside under a benchmark-specific metadata key, not here.
 */
export type WebappTargetMetadata = {
  url: string;
  repo?: string;
  sha?: string;
  username?: string;
  password?: string;
  role?: string;
  outboundServiceUrl?: string;
  proofUploadingUrl?: string;
  secret?: string;
  secretUploadingUrl?: string;
};

export function webappTargetMetadata(target: TargetHandle): WebappTargetMetadata | undefined {
  const webapp = (target.metadata as { webapp?: WebappTargetMetadata } | undefined)?.webapp;
  return webapp?.url ? webapp : undefined;
}

/**
 * Generic, benchmark-agnostic opt-in for autobrin-flue's `detectOnly` repo-modality evaluation
 * mode (stops after the adversarial gate with a confirmed/rejected verdict instead of running
 * exploitation/triage/disclosure -- see autobrin-flue's `docs/modalities.md`). Any repo-modality
 * benchmark whose task is classification-style (OWASP Benchmark vulnerable/safe, BountyBench's
 * Detect lane) sets `target.metadata.detectOnly = true` in its own `standUpTarget()`; read
 * generically here so `buildRepoPayload()` stays benchmark-agnostic.
 */
export function repoTargetDetectOnly(target: TargetHandle): boolean {
  return (target.metadata as { detectOnly?: boolean } | undefined)?.detectOnly === true;
}

export type BenchmarkTask = {
  id: string;
  benchmarkId: string;
  metadata?: Record<string, unknown>;
};

export type RunControls = {
  model: string;
  maxEngagementCostUsd?: number;
  maxCycles?: number;
  contributors?: number;
  infoLevel?: string;
};

export type RunContext = {
  runId: string;
  resultsDir: string;
  engagementsDir: string;
};

/** Mirrors autobrin-flue's `ProposedPatch` schema (`{ summary, diff, files }`, `docs/modalities.md`). */
export type ProposedPatch = {
  summary: string;
  diff: string;
  files: string[];
};

export type ConfirmedFinding = {
  location?: string;
  cve?: string;
  summary?: string;
  verdict?: string;
  /**
   * autobrin-flue's disclosure-stage `proposed_patch` (repo modality only), host-validated with
   * `git apply --check`. `undefined` when the attempt's contender type doesn't populate this
   * field at all (e.g. PITHOS); `null` when autobrin ran but the skill/host validation produced
   * no usable patch for this attempt.
   */
  proposedPatch?: ProposedPatch | null;
};

export type ContenderClaim = {
  confirmedFindings: ConfirmedFinding[];
  selfVerdictCounts: Record<string, number>;
  triageCounts: Record<string, number>;
};

export type NormalizedResult = {
  contenderId: string;
  contenderType: 'autobrin' | 'pithos' | 'command';
  resolvedRef?: string;
  commitSha?: string;
  exitCode: number;
  durationS: number;
  costUsd: number | null;
  costStatus: 'known' | 'unavailable';
  claim: ContenderClaim;
  engagementDir?: string;
  workspaceDir?: string;
  stdoutPath?: string;
  stderrPath?: string;
  raw?: Record<string, unknown>;
};

export type AgentRunner = {
  readonly id: string;
  readonly type: 'autobrin' | 'pithos' | 'command';
  run(input: {
    task: BenchmarkTask;
    target: TargetHandle;
    controls: RunControls;
    context: RunContext;
  }): Promise<NormalizedResult>;
};

export type TaskRunResult = {
  task: BenchmarkTask;
  target: TargetHandle;
  contenderResults: Array<{
    result: NormalizedResult;
    oracleScore: OracleScore;
    claimVsGraderGap: boolean;
  }>;
};

export type MatrixRunResult = {
  runId: string;
  benchmarkIds: string[];
  contenderIds: string[];
  taskResults: TaskRunResult[];
  contenderTotals: Record<string, OracleScore>;
  contenderCosts: Record<string, number | null>;
  contenderCommits: Record<string, string | undefined>;
};
