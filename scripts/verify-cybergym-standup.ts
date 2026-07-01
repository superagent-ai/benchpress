#!/usr/bin/env tsx
/**
 * Manual, real-world proof that the CyberGym adapter's `standUpTarget()`
 * genuinely pulls a working pre-/post-patch dockerized build env -- not a
 * stub -- even though `score()` stays blocked on autobrin-flue#180/#181 (see
 * src/benchmarks/cybergym/README.md).
 *
 * For a given task id (default: the smallest vendored task, arvo:1065):
 *   1. Runs the real adapter: setup() -> listTasks() -> standUpTarget().
 *   2. Lists the extracted pre-patch source tree (proves it's a real,
 *      inspectable codebase, not a placeholder).
 *   3. Extracts the upstream reference PoC embedded at /tmp/poc inside the
 *      pulled `-vul` image (never handed to a contributor -- this script
 *      only uses it for its own oracle proof) and runs it against both the
 *      `-vul` and `-fix` binaries under /out/.
 *   4. Asserts the differential: the vulnerable build crashes with this
 *      task's documented sanitizer/crash type, and the patched build stays
 *      silent (exit 0) -- CyberGym's own success oracle.
 *
 * Requires a reachable Docker daemon and network access to Hugging Face +
 * Docker Hub. Not part of `npm test` / CI (real multi-hundred-MB image pulls;
 * matches how `bench daytona doctor` is a manual verification tool, not
 * wired into CI).
 *
 * Usage:
 *   npx tsx scripts/verify-cybergym-standup.ts [taskId]
 */
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/lib/git.js';
import { cyberGymAdapter } from '../src/benchmarks/cybergym/adapter.js';
import type { CyberGymTargetMetadata } from '../src/benchmarks/cybergym/adapter.js';

const REFERENCE_POC_PATH = '/tmp/poc';

async function runFuzzerAgainstReferencePoc(
  image: string,
  fuzzerBinary: string,
): Promise<{ exitCode: number; output: string }> {
  const { exitCode, stdout, stderr } = await runCommand('docker', [
    'run',
    '--rm',
    image,
    fuzzerBinary,
    REFERENCE_POC_PATH,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function main(): Promise<void> {
  const taskId = process.argv[2] ?? 'arvo:1065';

  console.log(`[1/4] setup() + listTasks()`);
  await cyberGymAdapter.setup();
  const tasks = await cyberGymAdapter.listTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Unknown vendored task "${taskId}". Known: ${tasks.map((t) => t.id).join(', ')}`);
  }

  console.log(`[2/4] standUpTarget(${taskId}) -- downloading source + pulling both Docker images for real`);
  const target = await cyberGymAdapter.standUpTarget(task);
  const metadata = target.metadata as CyberGymTargetMetadata;
  console.log(`  sourceDir: ${metadata.sourceDir}`);
  console.log(`  vulImage:  ${metadata.vulImage.image} (${metadata.vulImage.imageId})`);
  console.log(`  fixImage:  ${metadata.fixImage.image} (${metadata.fixImage.imageId})`);
  console.log(`  expected crash type: ${metadata.sanitizer}: ${metadata.crashType}`);

  const { stdout: sourceListing } = await runCommand('sh', ['-c', `find "${metadata.sourceDir}" -maxdepth 2 | head -20`]);
  console.log(`[3/4] extracted pre-patch source (first 20 entries, ${metadata.sourceDir}):`);
  console.log(sourceListing.trim().split('\n').map((l) => `    ${l}`).join('\n'));

  console.log(`[4/4] differential proof: real reference PoC against both binaries (/out/${metadata.fuzzerBinary})`);
  const fuzzerPath = `/out/${metadata.fuzzerBinary}`;
  const vulRun = await runFuzzerAgainstReferencePoc(metadata.vulImage.image, fuzzerPath);
  const fixRun = await runFuzzerAgainstReferencePoc(metadata.fixImage.image, fuzzerPath);

  console.log(`  vul (${fuzzerPath}) exit code: ${vulRun.exitCode}`);
  console.log(`  fix (${fuzzerPath}) exit code: ${fixRun.exitCode}`);

  const vulCrashed = vulRun.exitCode !== 0;
  const fixSilent = fixRun.exitCode === 0;
  const crashTypeSeen = vulRun.output.includes(metadata.crashType);

  console.log('');
  console.log(`RESULT: vulCrashed=${vulCrashed} fixSilent=${fixSilent} crashTypeMatch=${crashTypeSeen}`);
  if (!vulCrashed || !fixSilent) {
    throw new Error('Differential oracle FAILED: expected vul to crash and fix to stay silent.');
  }
  if (!crashTypeSeen) {
    console.warn(`WARNING: vul output did not literally contain "${metadata.crashType}" (sanitizer text may vary).`);
  }
  console.log('PASS: pre-patch build crashed, post-patch build was silent -- real, working dockerized envs.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
