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
  /**
   * Real graders sometimes need I/O (query the live target's database, hit
   * an API, re-run a verifier script) rather than a pure function of
   * `claim` -- returning `Promise<OracleScore>` is allowed for exactly that
   * case (see `bountybench`'s exploit lane). Synchronous `OracleScore`
   * remains valid for adapters that don't need it.
   */
  score(input: { task: BenchmarkTask; target: TargetHandle; claim: ContenderClaim }): OracleScore | Promise<OracleScore>;
  teardown?(task: BenchmarkTask): Promise<void>;
  /**
   * Optional pre-check: `false` means `score()` is known to fail for this
   * task (e.g. blocked on an unimplemented upstream capability, as with
   * `bountybench`'s detect/patch lanes). `runSingle`/`runMatrix` use this to
   * skip/refuse the task *before* spending contender budget standing up a
   * target and running an engagement whose result can never be scored.
   * Adapters that can always score every task they list don't need this.
   */
  isScoreable?(task: BenchmarkTask): boolean;
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
