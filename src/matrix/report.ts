import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MatrixRunResult } from '../contenders/types.js';
import { youdenIndex } from '../oracle/types.js';
import { resultsRoot } from '../lib/paths.js';

export async function writeScorecard(result: MatrixRunResult): Promise<string> {
  const outDir = path.join(resultsRoot(), result.runId);
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'scorecard.md');

  const lines = [
    '# benchpress scorecard',
    '',
    `- Run: ${result.runId}`,
    `- Benchmarks: ${result.benchmarkIds.join(', ')}`,
    `- Contenders: ${result.contenderIds.join(', ')}`,
    '',
    '## Head-to-head',
    '',
    '| Contender | Commit | TP | FP | FN | Youden | Cost USD | Gap tasks |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];

  for (const contenderId of result.contenderIds) {
    const totals = result.contenderTotals[contenderId]!;
    const gapCount = result.taskResults.reduce((count, task) => {
      const entry = task.contenderResults.find((row) => row.result.contenderId === contenderId);
      return count + (entry?.claimVsGraderGap ? 1 : 0);
    }, 0);
    lines.push(
      `| ${contenderId} | ${result.contenderCommits[contenderId] ?? 'n/a'} | ${totals.truePositives} | ${totals.falsePositives} | ${totals.falseNegatives} | ${youdenIndex(totals).toFixed(3)} | ${result.contenderCosts[contenderId] ?? 'n/a'} | ${gapCount} |`,
    );
  }

  lines.push('', '## Per task', '');
  for (const taskResult of result.taskResults) {
    lines.push(`### ${taskResult.task.benchmarkId} / ${taskResult.task.id}`, '');
    lines.push('| Contender | Grader | Self confirmed | Gap | Cost |');
    lines.push('|---|---|---:|---:|---:|');
    for (const entry of taskResult.contenderResults) {
      const grader = entry.oracleScore.signals[0]?.outcome ?? 'n/a';
      const self = (entry.result.claim.selfVerdictCounts.confirmed ?? 0) > 0 ? 'yes' : 'no';
      lines.push(
        `| ${entry.result.contenderId} | ${grader} | ${self} | ${entry.claimVsGraderGap ? 'yes' : 'no'} | ${entry.result.costUsd ?? 'n/a'} |`,
      );
    }
    lines.push('');
  }

  await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
  return reportPath;
}
