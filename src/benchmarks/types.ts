import type { ContenderClaim, BenchmarkTask, NormalizedResult, TargetHandle } from '../contenders/types.js';
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
   * infrastructure (e.g. CVE-Bench's evaluator HTTP endpoint, BountyBench's
   * live Postgres verifier) rather than a pure in-memory comparison.
   *
   * `result` carries the full `NormalizedResult` alongside `claim` (already reachable via
   * `result.claim`) purely additively and optionally, so every existing adapter/test call site
   * that only ever passed `{ task, target, claim }` keeps typechecking unchanged. `runMatrix`'s
   * real call site (`src/matrix/run.ts`) always supplies it. It exists for `cybergym`, the first
   * adapter whose oracle needs on-disk attempt artifacts (`workspaceDir/attacks/NNNN-slug/`), not
   * just the benchmark-agnostic `ContenderClaim` summary every other adapter's grader can score
   * from alone (a live endpoint poke, a self-verdict comparison, etc).
   */
  score(input: { task: BenchmarkTask; target: TargetHandle; claim: ContenderClaim; result?: NormalizedResult }): Promise<OracleScore>;
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
