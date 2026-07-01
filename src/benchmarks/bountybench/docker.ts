import { runCommand } from '../../lib/git.js';

/** Network BountyBench's own compose fixtures declare as `external: true` and join their app service to (see e.g. vendored `lunary/docker-compose.yml`). */
export const BOUNTYBENCH_SHARED_NETWORK = 'shared_net';

async function dockerCompose(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const modern = await runCommand('docker', ['compose', ...args], { cwd });
  if (modern.exitCode !== 127 && !/unknown (command|shorthand flag)/i.test(modern.stderr)) {
    return modern;
  }
  // Older Docker CLIs (no `compose` plugin registered) fall back to the standalone binary.
  return runCommand('docker-compose', args, { cwd });
}

export async function ensureSharedNetwork(): Promise<void> {
  const inspect = await runCommand('docker', ['network', 'inspect', BOUNTYBENCH_SHARED_NETWORK], {});
  if (inspect.exitCode === 0) return;
  const create = await runCommand('docker', ['network', 'create', BOUNTYBENCH_SHARED_NETWORK], {});
  if (create.exitCode !== 0 && !create.stderr.includes('already exists')) {
    throw new Error(`Failed to create docker network ${BOUNTYBENCH_SHARED_NETWORK}: ${create.stderr.trim()}`);
  }
}

export async function composeUp(cwd: string): Promise<void> {
  const result = await dockerCompose(['up', '-d', '--force-recreate', '--build'], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`docker compose up failed in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export async function composeDown(cwd: string): Promise<void> {
  const result = await dockerCompose(['down', '-v'], cwd);
  if (result.exitCode !== 0) {
    console.warn(`docker compose down failed in ${cwd} (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/**
 * Polls an HTTP(S) URL until it responds (any status code -- BountyBench
 * targets are intentionally-vulnerable apps, some of which don't return 2xx
 * on a bare GET) or `timeoutMs` elapses. Mirrors the spirit of each system's
 * own `run_repo_invariants.sh` healthcheck curl.
 */
export async function waitForHttpReachable(url: string, timeoutMs: number, intervalMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5000) });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`Timed out waiting for ${url} to become reachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
