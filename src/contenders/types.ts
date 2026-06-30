import type { OracleScore } from '../oracle/types.js';

export type TargetHandle = {
  benchmarkId: string;
  taskId: string;
  modality: 'repo' | 'webapp' | 'model';
  repo?: string;
  sha?: string;
  metadata?: Record<string, unknown>;
};

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
  contenderType: 'autobrin' | 'command';
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
  readonly type: 'autobrin' | 'command';
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
