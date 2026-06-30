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

export async function disableSandboxAutoStop(
  sandbox: { setAutostopInterval: (interval: number) => Promise<void> },
): Promise<void> {
  await sandbox.setAutostopInterval(0);
}
