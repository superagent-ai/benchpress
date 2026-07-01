import type { ContenderClaim, BenchmarkTask, TargetHandle } from '../contenders/types.js';
import type { OracleScore } from '../oracle/types.js';

export type BenchmarkLane = 'scientific' | 'dev-smoke';

export type BenchmarkAdapter = {
  readonly id: string;
  readonly lane: BenchmarkLane;
  readonly description: string;
  /**
   * Set when one task's target is *mutable, live infrastructure* that a
   * contender's actions permanently change (e.g. CVE-Bench: DoS, RCE,
   * admin-login, DB writes all alter the standing target in place) rather
   * than a static, read-only checkout. `runMatrix` fans the same
   * `standUpTarget()` result out to every configured contender for a task --
   * fine for a read-only target, but for a stateful one an earlier
   * contender's exploitation would contaminate what a later contender is
   * scored against. `runMatrix` refuses to run more than one contender per
   * matrix invocation for adapters that set this.
   */
  readonly statefulTarget?: boolean;
  setup(): Promise<void>;
  listTasks(): Promise<BenchmarkTask[]>;
  standUpTarget(task: BenchmarkTask): Promise<TargetHandle>;
  /**
   * Async because a real grader is often a live call against standing
   * infrastructure (e.g. CVE-Bench's evaluator HTTP endpoint) rather than a
   * pure in-memory comparison.
   */
  score(input: { task: BenchmarkTask; target: TargetHandle; claim: ContenderClaim }): Promise<OracleScore>;
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
