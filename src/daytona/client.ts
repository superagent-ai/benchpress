import { Daytona, type DaytonaConfig } from '@daytona/sdk';
import type { CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams } from '@daytona/sdk';

export type Env = Record<string, string | undefined>;

export type DaytonaClientConfig = DaytonaConfig;

function removeUndefinedValues<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function getDaytonaClientConfig(env: Env = process.env, targetOverride?: string): DaytonaClientConfig {
  const apiKey = env.DAYTONA_API_KEY;
  const jwtToken = env.DAYTONA_JWT_TOKEN;
  const organizationId = env.DAYTONA_ORGANIZATION_ID;

  if (!apiKey && !jwtToken) {
    throw new Error('Missing DAYTONA_API_KEY or DAYTONA_JWT_TOKEN');
  }
  if (jwtToken && !apiKey && !organizationId) {
    throw new Error('Missing DAYTONA_ORGANIZATION_ID');
  }

  return removeUndefinedValues({
    apiKey,
    jwtToken,
    organizationId,
    apiUrl: env.DAYTONA_API_URL,
    target: targetOverride ?? env.DAYTONA_TARGET,
  }) as DaytonaClientConfig;
}

export function createDaytonaClient(env: Env = process.env): Daytona {
  return new Daytona(getDaytonaClientConfig(env));
}

export type SandboxCreateInput =
  | ({ kind: 'image' } & CreateSandboxFromImageParams)
  | ({ kind: 'snapshot' } & CreateSandboxFromSnapshotParams);

export async function createSandbox(
  daytona: Daytona,
  params: SandboxCreateInput,
): Promise<Awaited<ReturnType<Daytona['create']>>> {
  const { kind, ...createParams } = params;
  void kind;
  return daytona.create(createParams, { timeout: 120 });
}

export async function deleteDaytonaSandbox(sandboxId: string, env: Env = process.env): Promise<void> {
  const daytona = createDaytonaClient(env);
  const sandbox = await daytona.get(sandboxId);
  await sandbox.delete(120);
}

/**
 * Auto-stop interval (minutes) applied as a safety net after sandbox creation.
 *
 * Every sandbox lifecycle in this repo already deletes its sandbox in a
 * `finally` block, so this is a backstop, not the primary cleanup path. It
 * must not be 0 (disabled): a disabled auto-stop means an ungracefully killed
 * process (e.g. `kill -9`, an OOM, a host crash) orphans the sandbox to run
 * -- and bill -- indefinitely, since nothing else will ever stop it. An hour
 * is long enough to never interrupt a legitimate engagement (`maxCycles`/
 * `maxEngagementCostUsd` guardrails bound those), but short enough to cap
 * the cost of a leaked sandbox if cleanup never runs.
 */
export const AUTO_STOP_SAFETY_NET_MINUTES = 60;

export async function applyAutoStopSafetyNet(
  sandbox: { setAutostopInterval: (interval: number) => Promise<void> },
): Promise<void> {
  await sandbox.setAutostopInterval(AUTO_STOP_SAFETY_NET_MINUTES);
}
