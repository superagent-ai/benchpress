import type { Sandbox } from '@daytona/sdk';
import { DEFAULT_COMPUTER_USE_BASE_URL } from './constants.js';
import {
  createDaytonaClient,
  createSandbox,
  deleteDaytonaSandbox,
  disableSandboxAutoStop,
  type Env,
} from './client.js';
import { executeOptional } from './sandbox-exec.js';
import { shellQuote } from './shell.js';

export type DaytonaDoctorOptions = {
  image?: string;
  snapshot?: string;
  env?: Env;
  keepSandbox?: boolean;
};

export type DaytonaDoctorResult = {
  sandboxId: string;
  cuaDriverStatusOk: boolean;
  computerUseStatusOk: boolean;
  pass: boolean;
  keptSandbox: boolean;
  details: {
    cuaDriverOutput: string;
    computerUseOutput: string;
  };
};

export async function runDaytonaDoctor(options: DaytonaDoctorOptions): Promise<DaytonaDoctorResult> {
  if (!options.image && !options.snapshot) {
    throw new Error('daytona doctor requires --image or --snapshot');
  }

  const env = options.env ?? process.env;
  const daytona = createDaytonaClient(env);
  let sandbox: Sandbox | null = null;
  let keptSandbox = false;

  try {
    sandbox = await createSandbox(
      daytona,
      options.snapshot
        ? {
            kind: 'snapshot',
            snapshot: options.snapshot,
            autoStopInterval: 0,
          }
        : {
            kind: 'image',
            image: options.image!,
            autoStopInterval: 0,
          },
    );

    console.error(`Daytona doctor sandbox created: ${sandbox.id}`);
    await disableSandboxAutoStop(sandbox);

    const cuaDriver = await executeOptional(sandbox, 'cua-driver status', '/', 30);
    const computerUse = await executeOptional(
      sandbox,
      `curl -fsS ${shellQuote(`${DEFAULT_COMPUTER_USE_BASE_URL}/computeruse/status`)}`,
      '/',
      30,
    );

    const cuaDriverStatusOk = cuaDriver.exitCode === 0;
    const computerUseStatusOk = computerUse.exitCode === 0;
    const pass = cuaDriverStatusOk && computerUseStatusOk;

    if (options.keepSandbox) {
      keptSandbox = true;
      console.error(`Keeping doctor sandbox ${sandbox.id} (--keep-sandbox)`);
    }

    return {
      sandboxId: sandbox.id,
      cuaDriverStatusOk,
      computerUseStatusOk,
      pass,
      keptSandbox,
      details: {
        cuaDriverOutput: cuaDriver.result.trim(),
        computerUseOutput: computerUse.result.trim(),
      },
    };
  } finally {
    if (sandbox && !options.keepSandbox) {
      await deleteDaytonaSandbox(sandbox.id, env);
      console.error(`Daytona doctor sandbox deleted: ${sandbox.id}`);
    }
  }
}
