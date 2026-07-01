import type { Sandbox } from '@daytona/sdk';
import { checkComputerUseScreenshot } from './assets.js';
import { DEFAULT_COMPUTER_USE_BASE_URL } from './constants.js';
import {
  applyAutoStopSafetyNet,
  AUTO_STOP_SAFETY_NET_MINUTES,
  createDaytonaClient,
  createSandbox,
  deleteDaytonaSandbox,
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
  /** Toolbox loopback `/computeruse/status` reachable (curl -f exits 0). Required for `pass`. */
  computerUseStatusOk: boolean;
  /** Toolbox loopback `/computeruse/screenshot` returned a non-empty image. Required for `pass`. */
  computerUseScreenshotOk: boolean;
  /** Informational only: `cua-driver` CLI present on the image. Not required for `pass`. */
  cuaDriverAvailable: boolean;
  /** Informational only: `cua-driver status` exited 0. Not required for `pass` — see superagent-ai/benchpress#4. */
  cuaDriverStatusOk: boolean;
  pass: boolean;
  keptSandbox: boolean;
  details: {
    cuaDriverOutput: string;
    computerUseStatusOutput: string;
    computerUseScreenshotBytes: number;
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
            autoStopInterval: AUTO_STOP_SAFETY_NET_MINUTES,
          }
        : {
            kind: 'image',
            image: options.image!,
            autoStopInterval: AUTO_STOP_SAFETY_NET_MINUTES,
          },
    );

    console.error(`Daytona doctor sandbox created: ${sandbox.id}`);
    await applyAutoStopSafetyNet(sandbox);

    // cua-driver presence/daemon status is informational only (superagent-ai/benchpress#4): some
    // app-parity images install the CLI without a running daemon or a `start` subcommand, and some
    // images (e.g. generic daytona-large) don't install it at all — yet Toolbox loopback CU works
    // in both cases. The real pass/fail signal is Toolbox reachability + screenshot capture.
    const cuaDriverAvailableCheck = await executeOptional(sandbox, 'command -v cua-driver >/dev/null 2>&1', '/', 15);
    const cuaDriver = await executeOptional(sandbox, 'cua-driver status', '/', 30);
    const computerUse = await executeOptional(
      sandbox,
      `curl -fsS ${shellQuote(`${DEFAULT_COMPUTER_USE_BASE_URL}/computeruse/status`)}`,
      '/',
      30,
    );
    const screenshot = await checkComputerUseScreenshot(sandbox);

    const cuaDriverAvailable = cuaDriverAvailableCheck.exitCode === 0;
    const cuaDriverStatusOk = cuaDriver.exitCode === 0;
    const computerUseStatusOk = computerUse.exitCode === 0;
    const computerUseScreenshotOk = screenshot.ok;
    const pass = computerUseStatusOk && computerUseScreenshotOk;

    if (!cuaDriverStatusOk) {
      console.error(
        `Note: cua-driver daemon check did not pass (informational only, not required when Toolbox loopback works — see superagent-ai/benchpress#4): ${
          cuaDriver.result.trim() || 'no output'
        }`,
      );
    }

    if (options.keepSandbox) {
      keptSandbox = true;
      console.error(`Keeping doctor sandbox ${sandbox.id} (--keep-sandbox)`);
    }

    return {
      sandboxId: sandbox.id,
      computerUseStatusOk,
      computerUseScreenshotOk,
      cuaDriverAvailable,
      cuaDriverStatusOk,
      pass,
      keptSandbox,
      details: {
        cuaDriverOutput: cuaDriver.result.trim(),
        computerUseStatusOutput: computerUse.result.trim(),
        computerUseScreenshotBytes: screenshot.bytes,
      },
    };
  } finally {
    if (sandbox && !options.keepSandbox) {
      await deleteDaytonaSandbox(sandbox.id, env);
      console.error(`Daytona doctor sandbox deleted: ${sandbox.id}`);
    }
  }
}
