#!/usr/bin/env tsx
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonRequired } from '../src/lib/json.js';
import { runMatrix, runSingle, type MatrixConfig } from '../src/matrix/run.js';
import { writeScorecard } from '../src/matrix/report.js';
import { createContender, type ContenderConfig } from '../src/contenders/registry.js';
import { listBenchmarks } from '../src/benchmarks/registry.js';
import { runDaytonaDoctor } from '../src/daytona/doctor.js';
import { runDaytonaEngagement } from '../src/daytona/launcher.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'list') {
    for (const benchmark of listBenchmarks()) {
      console.log(`${benchmark.id}\t${benchmark.lane}\t${benchmark.description}`);
    }
    return;
  }

  if (command === 'matrix') {
    const configPath = readFlag(args, '--config');
    if (!configPath) throw new Error('Usage: bench matrix --config <path.jsonc>');
    const config = await readJsonRequired<MatrixConfig>(path.resolve(configPath));
    const result = await runMatrix(config);
    const reportPath = await writeScorecard(result);
    console.log(`Scorecard: ${reportPath}`);
    return;
  }

  if (command === 'daytona') {
    await handleDaytonaCommand(args);
    return;
  }

  if (command === 'run') {
    const benchmarkId = args[0];
    if (!benchmarkId) throw new Error('Usage: bench run <benchmark> --contender <id> --model <id> [--flue-ref staging]');
    const contenderId = readFlag(args, '--contender');
    const model = readFlag(args, '--model');
    const flueRef = readFlag(args, '--flue-ref');
    const taskId = readFlag(args, '--task');
    const maxCost = readFlag(args, '--max-engagement-cost-usd');
    if (!contenderId || !model) throw new Error('bench run requires --contender and --model');

    const contenderConfig: ContenderConfig =
      contenderId.startsWith('autobrin@') || contenderId === 'autobrin'
        ? {
            id: contenderId,
            type: 'autobrin',
            ref: flueRef ?? (contenderId.startsWith('autobrin@') ? contenderId.replace(/^autobrin@/, '') : undefined),
          }
        : { id: contenderId, type: 'command', command: readFlag(args, '--command') ?? '<your-tool> run {repo} --model {model}' };

    const result = await runSingle({
      benchmarkId,
      contender: createContender(contenderConfig),
      taskId,
      controls: {
        model,
        maxEngagementCostUsd: maxCost ? Number(maxCost) : undefined,
      },
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printUsage();
}

async function handleDaytonaCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (subcommand === 'doctor') {
    const result = await runDaytonaDoctor({
      image: readFlag(subArgs, '--image'),
      snapshot: readFlag(subArgs, '--snapshot'),
      keepSandbox: hasFlag(subArgs, '--keep-sandbox'),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) process.exitCode = 1;
    return;
  }

  if (subcommand === 'run') {
    const payloadRaw = readFlag(subArgs, '--payload');
    if (!payloadRaw) {
      throw new Error(
        'Usage: bench daytona run --ref staging --image <image-or-snapshot> --vision-model <model> --payload \'<json>\' [--snapshot <name>] [--keep-sandbox]',
      );
    }

    const payload = JSON.parse(payloadRaw) as unknown;
    const result = await runDaytonaEngagement({
      ref: readFlag(subArgs, '--ref'),
      image: readFlag(subArgs, '--image'),
      snapshot: readFlag(subArgs, '--snapshot'),
      visionModel: readFlag(subArgs, '--vision-model'),
      payload,
      keepSandbox: hasFlag(subArgs, '--keep-sandbox'),
      onChunk: (chunk, stream) => {
        if (stream === 'stderr') process.stderr.write(chunk);
        else process.stdout.write(chunk);
      },
    });
    console.error(JSON.stringify(result, null, 2));
    if (result.engagement.exitCode !== 0) process.exitCode = result.engagement.exitCode;
    return;
  }

  throw new Error('Usage: bench daytona <run|doctor> ...');
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1]) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function printUsage(): void {
  console.log(`benchpress CLI

Usage:
  bench list
  bench run <benchmark> --contender <id> --model <id> [--flue-ref staging] [--task <id>]
  bench matrix --config <path.jsonc>
  bench daytona run --ref staging --image <image> --vision-model <model> --payload '<json>' [--snapshot <name>] [--keep-sandbox]
  bench daytona doctor [--image <image>] [--snapshot <name>] [--keep-sandbox]
`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
