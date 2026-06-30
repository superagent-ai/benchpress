import type { ContenderClaim, BenchmarkTask, TargetHandle } from '../contenders/types.js';
import type { OracleScore } from '../oracle/types.js';

export type BenchmarkLane = 'scientific' | 'dev-smoke';

export type BenchmarkAdapter = {
  readonly id: string;
  readonly lane: BenchmarkLane;
  readonly description: string;
  setup(): Promise<void>;
  listTasks(): Promise<BenchmarkTask[]>;
  standUpTarget(task: BenchmarkTask): Promise<TargetHandle>;
  score(input: { task: BenchmarkTask; target: TargetHandle; claim: ContenderClaim }): OracleScore;
  teardown?(task: BenchmarkTask): Promise<void>;
};

export class NotImplementedBenchmarkError extends Error {
  readonly benchmarkId: string;
  readonly dependency: string;

  constructor(benchmarkId: string, dependency: string) {
    super(`${benchmarkId} adapter is not implemented yet: ${dependency}`);
    this.name = 'NotImplementedBenchmarkError';
    this.benchmarkId = benchmarkId;
    this.dependency = dependency;
  }
}

export function stubAdapter(input: {
  id: string;
  description: string;
  dependency: string;
}): BenchmarkAdapter {
  const fail = (): never => {
    throw new NotImplementedBenchmarkError(input.id, input.dependency);
  };
  return {
    id: input.id,
    lane: 'scientific',
    description: input.description,
    setup: async () => fail(),
    listTasks: async () => fail(),
    standUpTarget: async () => fail(),
    score: () => fail(),
  };
}
