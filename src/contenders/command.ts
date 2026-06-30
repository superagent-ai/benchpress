import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRunner, BenchmarkTask, ContenderClaim, NormalizedResult, RunContext, RunControls, TargetHandle } from './types.js';
import { runCommand } from '../lib/git.js';
import { slugify } from '../lib/json.js';

export type CommandContenderConfig = {
  id: string;
  type: 'command';
  command: string;
  cwd?: string;
  env?: Record<string, string>;
};

type TemplateVars = {
  target: TargetHandle;
  task: BenchmarkTask;
  controls: RunControls;
};

function renderTemplate(template: string, vars: TemplateVars): string {
  return template
    .replaceAll('{repo}', vars.target.repo ?? '')
    .replaceAll('{sha}', vars.target.sha ?? '')
    .replaceAll('{model}', vars.controls.model)
    .replaceAll('{taskId}', vars.task.id)
    .replaceAll('{benchmarkId}', vars.task.benchmarkId);
}

function parseClaimFromStdout(stdout: string): ContenderClaim {
  try {
    const parsed = JSON.parse(stdout) as Partial<ContenderClaim>;
    if (parsed.confirmedFindings && Array.isArray(parsed.confirmedFindings)) {
      return {
        confirmedFindings: parsed.confirmedFindings,
        selfVerdictCounts: parsed.selfVerdictCounts ?? {},
        triageCounts: parsed.triageCounts ?? {},
      };
    }
  } catch {
    // fall through
  }
  return { confirmedFindings: [], selfVerdictCounts: {}, triageCounts: {} };
}

export function createCommandRunner(config: CommandContenderConfig): AgentRunner {
  return {
    id: config.id,
    type: 'command',
    async run({ task, target, controls, context }) {
      const started = Date.now();
      const command = renderTemplate(config.command, { target, task, controls });
      const stdoutPath = path.join(context.resultsDir, `${slugify(config.id)}_${slugify(task.id)}.stdout.log`);
      const stderrPath = path.join(context.resultsDir, `${slugify(config.id)}_${slugify(task.id)}.stderr.log`);
      await mkdir(context.resultsDir, { recursive: true });

      const { stdout, stderr, exitCode } = await runCommand('bash', ['-lc', command], {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
      });
      await writeFile(stdoutPath, stdout, 'utf8');
      await writeFile(stderrPath, stderr, 'utf8');

      const claim = parseClaimFromStdout(stdout.trim());
      return {
        contenderId: config.id,
        contenderType: 'command',
        exitCode,
        durationS: Math.round((Date.now() - started) / 1000),
        costUsd: null,
        costStatus: 'unavailable',
        claim,
        stdoutPath,
        stderrPath,
      } satisfies NormalizedResult;
    },
  };
}
