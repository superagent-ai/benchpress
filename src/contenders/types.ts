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

export type ConfirmedFinding = {
  location?: string;
  cve?: string;
  summary?: string;
  verdict?: string;
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
