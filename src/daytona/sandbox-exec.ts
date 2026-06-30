import type { Sandbox } from '@daytona/sdk';

export async function executeChecked(
  sandbox: Sandbox,
  command: string,
  cwd = '/',
  timeout = 30,
  env?: Record<string, string>,
): Promise<{ exitCode: number; result: string }> {
  const response = await sandbox.process.executeCommand(command, cwd, env, timeout);
  if (response.exitCode !== 0) {
    throw new Error(response.result || `Sandbox command failed with exit code ${response.exitCode}`);
  }
  return { exitCode: response.exitCode, result: response.result };
}

export async function executeOptional(
  sandbox: Sandbox,
  command: string,
  cwd = '/',
  timeout = 30,
  env?: Record<string, string>,
): Promise<{ exitCode: number; result: string }> {
  const response = await sandbox.process.executeCommand(command, cwd, env, timeout);
  return { exitCode: response.exitCode, result: response.result };
}
