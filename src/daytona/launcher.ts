import type { Image, Sandbox } from '@daytona/sdk';
import { ensureComputerUseAssets } from './assets.js';
import { bootstrapAutobrinFlue, prepareRepoTarget, prepareWebappTarget } from './bootstrap.js';
import {
  applyAutoStopSafetyNet,
  AUTO_STOP_SAFETY_NET_MINUTES,
  createDaytonaClient,
  createSandbox,
  deleteDaytonaSandbox,
  type Env,
} from './client.js';
import { buildSandboxEnv } from './env.js';
import { runEngagementViaHttp, type EngagementRunResult } from './engagement.js';
import { normalizeEngagementPayload, type EngagementPayload } from './payload.js';

export type DaytonaRunOptions = {
  ref?: string;
  /** String image ref (registry tag) or a declarative `Image` built with `Image.base(...)`. */
  image?: string | Image;
  snapshot?: string;
  visionModel?: string;
  payload: EngagementPayload | unknown;
  keepSandbox?: boolean;
  env?: Env;
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /**
   * Runs after the engagement finishes but before the sandbox is torn down (or kept, per
   * `keepSandbox`). Callers needing sandbox-side state that only exists while the sandbox is
   * still alive -- e.g. reading engagement workspace files -- must do so here: by the time
   * `runDaytonaEngagement` resolves, the sandbox has already been deleted (unless `keepSandbox`).
   * A thrown error here still runs cleanup (via `finally`) and rejects the overall call.
   */
  afterEngagement?: (sandbox: Sandbox, payload: EngagementPayload, engagement: EngagementRunResult) => Promise<void>;
};

export type DaytonaRunResult = {
  sandboxId: string;
  engagement: EngagementRunResult;
  computerUse: Awaited<ReturnType<typeof ensureComputerUseAssets>>;
  keptSandbox: boolean;
};

export async function runDaytonaEngagement(options: DaytonaRunOptions): Promise<DaytonaRunResult> {
  const env = options.env ?? process.env;
  const payload = normalizeEngagementPayload(options.payload);
  const sandboxEnv = buildSandboxEnv({
    env,
    ref: options.ref,
    visionModel: options.visionModel,
    workspaceRoot: payload.workspaceRoot,
  });

  if (!options.image && !options.snapshot) {
    throw new Error('daytona run requires --image or --snapshot');
  }

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
            envVars: sandboxEnv,
            autoStopInterval: AUTO_STOP_SAFETY_NET_MINUTES,
          }
        : {
            kind: 'image',
            image: options.image!,
            envVars: sandboxEnv,
            autoStopInterval: AUTO_STOP_SAFETY_NET_MINUTES,
          },
    );

    console.error(`Daytona sandbox created: ${sandbox.id}`);
    await applyAutoStopSafetyNet(sandbox);

    await bootstrapAutobrinFlue(sandbox, {
      ref: sandboxEnv.AUTOBRIN_FLUE_REF,
      repository: sandboxEnv.AUTOBRIN_FLUE_REPOSITORY,
      githubToken: sandboxEnv.AUTOBRIN_FLUE_GITHUB_TOKEN,
    });

    const computerUse = await ensureComputerUseAssets(sandbox);

    if (payload.modality === 'repo') {
      await prepareRepoTarget(sandbox, payload, sandboxEnv.AUTOBRIN_FLUE_GITHUB_TOKEN);
    } else {
      await prepareWebappTarget(sandbox, payload);
    }

    const engagement = await runEngagementViaHttp(sandbox, payload, options.onChunk);

    if (options.afterEngagement) {
      await options.afterEngagement(sandbox, payload, engagement);
    }

    if (options.keepSandbox) {
      keptSandbox = true;
      console.error(`Keeping sandbox ${sandbox.id} (--keep-sandbox)`);
    }

    return {
      sandboxId: sandbox.id,
      engagement,
      computerUse,
      keptSandbox,
    };
  } finally {
    if (sandbox && !options.keepSandbox) {
      try {
        await deleteDaytonaSandbox(sandbox.id, env);
        console.error(`Daytona sandbox deleted: ${sandbox.id}`);
      } catch (error) {
        console.error(
          `Warning: failed to delete Daytona sandbox ${sandbox.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
