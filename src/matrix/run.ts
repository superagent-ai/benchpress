import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRunner, MatrixRunResult, RunContext, RunControls, TaskRunResult } from '../contenders/types.js';
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
    await adapter.setup();
    let tasks = await adapter.listTasks();
    if (config.taskFilter?.length) {
      tasks = tasks.filter((task) => config.taskFilter!.includes(task.id));
    }

    for (const task of tasks) {
      if (adapter.isScoreable && !adapter.isScoreable(task)) {
        console.warn(`Skipping task "${task.id}" (${benchmarkId}): adapter.isScoreable() reports it cannot be scored yet.`);
        continue;
      }

      const target = await adapter.standUpTarget(task);
      const controls = config.controls;
      const contenderResults: TaskRunResult['contenderResults'] = [];

      try {
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
      } finally {
        if (adapter.teardown) await adapter.teardown(task);
      }

      taskResults.push({ task, target, contenderResults });
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
  if (adapter.isScoreable && !adapter.isScoreable(task)) {
    throw new Error(
      `Task "${task.id}" (${input.benchmarkId}) cannot be scored yet (adapter.isScoreable() returned false) -- ` +
        'refusing to spend contender budget on an engagement whose result can never be scored. Pass --task to pick a different task.',
    );
  }

  const target = await adapter.standUpTarget(task);
  const context: RunContext = { runId, resultsDir, engagementsDir };

  try {
    const result = await input.contender.run({ task, target, controls: input.controls, context });
    const oracleScore = await adapter.score({ task, target, claim: result.claim });
    const selfConfirmed = (result.claim.selfVerdictCounts.confirmed ?? 0) > 0;
    const graderMatched = oracleScore.truePositives > 0;

    return {
      task,
      target,
      contenderResults: [
        {
          result,
          oracleScore,
          claimVsGraderGap: selfConfirmed !== graderMatched,
        },
      ],
    };
  } finally {
    if (adapter.teardown) await adapter.teardown(task);
  }
}
