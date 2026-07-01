import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRunner, BenchmarkTask, MatrixRunResult, RunContext, RunControls, TaskRunResult } from '../contenders/types.js';
import type { BenchmarkAdapter } from '../benchmarks/types.js';
import { resolveBenchmark } from '../benchmarks/registry.js';
import { createContenders, type ContenderConfig } from '../contenders/registry.js';
import { aggregateOracleScores } from '../oracle/types.js';
import { engagementsRoot, resultsRoot, runsRoot } from '../lib/paths.js';
import { slugify } from '../lib/json.js';

export type MatrixConfig = {
  contenders: ContenderConfig[];
  benchmarks: string[];
  controls: RunControls;
  taskFilter?: string[];
};

/**
 * `runMatrix` fans one task's `standUpTarget()` result out to every
 * configured contender. That's fine for a read-only target (a git checkout,
 * unaffected by what a contender does to it) but not for a `statefulTarget`
 * adapter (e.g. CVE-Bench): an earlier contender's own exploitation (DoS,
 * RCE, admin login, DB writes, ...) permanently changes the live target a
 * later contender would then be scored against. Exported standalone so it's
 * covered by a fast unit test without needing to spin up real infra.
 */
export function assertSingleContenderForStatefulTarget(
  adapter: Pick<BenchmarkAdapter, 'id' | 'statefulTarget'>,
  contenders: readonly AgentRunner[],
): void {
  if (!adapter.statefulTarget || contenders.length <= 1) return;
  throw new Error(
    `${adapter.id} stands up one live, mutable target per task shared across every contender in this matrix run. ` +
      `Running ${contenders.length} contenders (${contenders.map((c) => c.id).join(', ')}) against it would let an ` +
      `earlier contender's exploitation (DoS, RCE, admin login, etc.) contaminate the state a later contender is ` +
      `scored against. Run one contender per ${adapter.id} matrix invocation instead.`,
  );
}

/**
 * Stands up one task's target, runs every contender against it, scores each,
 * and always tears the target down -- including when `standUpTarget` itself
 * succeeded but a contender run or `score()` threw afterward, so a real
 * Docker stack (cve-bench) can never leak past this call. Exported
 * standalone (accepts an already-resolved adapter/contenders rather than
 * reading the registries itself) so it's covered by a fast unit test with
 * fake adapter/contender doubles instead of real infra.
 */
export async function runTaskAcrossContenders(input: {
  adapter: BenchmarkAdapter;
  task: BenchmarkTask;
  contenders: readonly AgentRunner[];
  controls: RunControls;
  context: RunContext;
}): Promise<TaskRunResult> {
  const { adapter, task, contenders, controls, context } = input;
  const target = await adapter.standUpTarget(task);
  try {
    const contenderResults: TaskRunResult['contenderResults'] = [];
    for (const contender of contenders) {
      const result = await contender.run({ task, target, controls, context });
      const oracleScore = await adapter.score({ task, target, claim: result.claim });
      const selfConfirmed = (result.claim.selfVerdictCounts.confirmed ?? 0) > 0;
      const graderMatched = oracleScore.truePositives > 0;
      contenderResults.push({
        result,
        oracleScore,
        claimVsGraderGap: selfConfirmed !== graderMatched,
      });
    }
    return { task, target, contenderResults };
  } finally {
    if (adapter.teardown) await adapter.teardown(task);
  }
}

export async function runMatrix(config: MatrixConfig): Promise<MatrixRunResult> {
  const runId = `matrix_${Date.now()}`;
  const runDir = path.join(runsRoot(), runId);
  const resultsDir = path.join(resultsRoot(), runId);
  const engagementsDir = path.join(engagementsRoot(), runId);
  await mkdir(runDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await mkdir(engagementsDir, { recursive: true });

  const context: RunContext = { runId, resultsDir, engagementsDir };
  const contenders = createContenders(config.contenders);
  const taskResults: TaskRunResult[] = [];

  for (const benchmarkId of config.benchmarks) {
    const adapter = resolveBenchmark(benchmarkId);
    assertSingleContenderForStatefulTarget(adapter, contenders);
    await adapter.setup();
    let tasks = await adapter.listTasks();
    if (config.taskFilter?.length) {
      tasks = tasks.filter((task) => config.taskFilter!.includes(task.id));
    }

    for (const task of tasks) {
      taskResults.push(await runTaskAcrossContenders({ adapter, task, contenders, controls: config.controls, context }));
    }
  }

  const matrixResult = buildMatrixResult(runId, config, contenders, taskResults);
  await writeFile(path.join(runDir, 'matrix.json'), `${JSON.stringify(matrixResult, null, 2)}\n`, 'utf8');
  return matrixResult;
}

function buildMatrixResult(
  runId: string,
  config: MatrixConfig,
  contenders: AgentRunner[],
  taskResults: TaskRunResult[],
): MatrixRunResult {
  const contenderTotals: MatrixRunResult['contenderTotals'] = {};
  const contenderCosts: MatrixRunResult['contenderCosts'] = {};
  const contenderCommits: MatrixRunResult['contenderCommits'] = {};

  for (const contender of contenders) {
    contenderTotals[contender.id] = aggregateOracleScores([]);
    contenderCosts[contender.id] = null;
    contenderCommits[contender.id] = undefined;
  }

  for (const taskResult of taskResults) {
    for (const entry of taskResult.contenderResults) {
      const id = entry.result.contenderId;
      contenderTotals[id] = aggregateOracleScores([contenderTotals[id]!, entry.oracleScore]);
      if (entry.result.costUsd !== null) {
        contenderCosts[id] = (contenderCosts[id] ?? 0) + entry.result.costUsd;
      }
      if (entry.result.commitSha) contenderCommits[id] = entry.result.commitSha;
    }
  }

  return {
    runId,
    benchmarkIds: config.benchmarks,
    contenderIds: contenders.map((c) => c.id),
    taskResults,
    contenderTotals,
    contenderCosts,
    contenderCommits,
  };
}

export async function runSingle(input: {
  benchmarkId: string;
  contender: AgentRunner;
  controls: RunControls;
  taskId?: string;
}): Promise<TaskRunResult> {
  const runId = `run_${slugify(input.benchmarkId)}_${slugify(input.contender.id)}_${Date.now()}`;
  const resultsDir = path.join(resultsRoot(), runId);
  const engagementsDir = path.join(engagementsRoot(), runId);
  await mkdir(resultsDir, { recursive: true });
  await mkdir(engagementsDir, { recursive: true });

  const adapter = resolveBenchmark(input.benchmarkId);
  await adapter.setup();
  let tasks = await adapter.listTasks();
  if (input.taskId) {
    tasks = tasks.filter((task) => task.id === input.taskId);
    if (tasks.length === 0) throw new Error(`Task not found: ${input.taskId}`);
  }

  const task = tasks[0]!;
  const context: RunContext = { runId, resultsDir, engagementsDir };
  return runTaskAcrossContenders({ adapter, task, contenders: [input.contender], controls: input.controls, context });
}
