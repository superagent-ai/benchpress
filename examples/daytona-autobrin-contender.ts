#!/usr/bin/env tsx
/**
 * Runs the `repo-cve-smoke` dev-smoke benchmark through an `autobrin` contender configured with
 * `transport: "daytona"` (superagent-ai/benchpress#11) against a real Daytona sandbox, using the
 * declarative node:22-bookworm computer-use image from `node22-bookworm-computer-use-image.ts`.
 *
 * Why build the image inline instead of passing `--image <name>`: as that file's own docstring
 * explains, there is no published Daytona snapshot with this exact combination (Node 22 +
 * XFCE/Xvfb desktop + `cua-driver`), and a contender config's `image` field accepts a declarative
 * `Image` object precisely so callers can do this (see `AutobrinContenderConfig` in
 * `src/contenders/autobrin.ts`) -- something a JSON/JSONC config file can never express, since an
 * `Image` isn't serializable.
 *
 * Usage:
 *   dotenvx run -f ~/.config/secrets/global.env -- npx tsx examples/daytona-autobrin-contender.ts
 *
 * Requires DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID), GH_TOKEN (or
 * AUTOBRIN_FLUE_GITHUB_TOKEN) with read access to the private superagent-ai/autobrin-flue repo,
 * and a model provider key (AZURE_OPENAI_API_KEY/AZURE_OPENAI_BASE_URL by default). Guardrails
 * below cap the engagement to a single cycle / a single contributor / a few dollars. The sandbox
 * this creates is always deleted afterward unless it errors before creation completes -- see
 * `runDaytonaEngagement`'s cleanup contract in `src/daytona/launcher.ts`.
 */
import { fileURLToPath } from 'node:url';
import { createContender } from '../src/contenders/registry.js';
import { runSingle } from '../src/matrix/run.js';
import { buildNode22BookwormComputerUseImage } from './node22-bookworm-computer-use-image.js';

async function main(): Promise<void> {
  const contender = createContender({
    id: 'autobrin@staging-daytona-example',
    type: 'autobrin',
    ref: 'staging',
    transport: 'daytona',
    image: buildNode22BookwormComputerUseImage(),
    visionModel: process.env.CUA_SCREENSHOT_VISION_MODEL || 'kimi-k2.6',
  });

  const result = await runSingle({
    benchmarkId: 'repo-cve-smoke',
    contender,
    controls: {
      model: process.env.AUTOBRIN_FLUE_MODEL || 'kimi-azure/kimi-k2.6',
      maxCycles: 1,
      maxEngagementCostUsd: 5,
      contributors: 1,
    },
  });

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
