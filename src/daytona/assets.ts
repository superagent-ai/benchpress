import type { Sandbox } from '@daytona/sdk';
import {
  AUTOBRIN_BUNDLED_COMPUTER_USE_SKILL,
  AUTOBRIN_FLUE_DIR,
  BENCHPRESS_ROOT,
  DEFAULT_COMPUTER_USE_BASE_URL,
} from './constants.js';
import { executeChecked, executeOptional } from './sandbox-exec.js';
import { shellQuote } from './shell.js';

export type ComputerUseAssetStatus = {
  bundledSkillPresent: boolean;
  cuaDriverAvailable: boolean;
  computerUseStatusOk: boolean;
  visionHelperPresent: boolean;
  usedFallback: boolean;
};

export async function ensureComputerUseAssets(sandbox: Sandbox): Promise<ComputerUseAssetStatus> {
  const bundledSkillPath = `${AUTOBRIN_FLUE_DIR}/${AUTOBRIN_BUNDLED_COMPUTER_USE_SKILL}`;
  const bundledCheck = await executeOptional(
    sandbox,
    `test -d ${shellQuote(bundledSkillPath)}`,
    '/',
    15,
  );
  const bundledSkillPresent = bundledCheck.exitCode === 0;

  const cuaDriverCheck = await executeOptional(sandbox, 'command -v cua-driver >/dev/null 2>&1', '/', 15);
  const cuaDriverAvailable = cuaDriverCheck.exitCode === 0;

  const computerUseStatus = await executeOptional(
    sandbox,
    `curl -fsS ${shellQuote(`${DEFAULT_COMPUTER_USE_BASE_URL}/computeruse/status`)} >/dev/null`,
    '/',
    20,
  );
  const computerUseStatusOk = computerUseStatus.exitCode === 0;

  let visionHelperPresent = false;
  let usedFallback = false;

  if (bundledSkillPresent) {
    const visionCheck = await executeOptional(
      sandbox,
      `test -x ${shellQuote(`${AUTOBRIN_FLUE_DIR}/bin/read-screenshot`)} || test -f ${shellQuote(`${AUTOBRIN_FLUE_DIR}/bin/read-screenshot.cjs`)}`,
      '/',
      15,
    );
    visionHelperPresent = visionCheck.exitCode === 0;
  } else {
    usedFallback = true;
    await ensureFallbackComputerUseAssets(sandbox);
    const fallbackVisionCheck = await executeOptional(
      sandbox,
      `test -x ${shellQuote(`${BENCHPRESS_ROOT}/bin/read-screenshot`)} || test -f ${shellQuote(`${BENCHPRESS_ROOT}/bin/read-screenshot.cjs`)}`,
      '/',
      15,
    );
    visionHelperPresent = fallbackVisionCheck.exitCode === 0;
  }

  if (!cuaDriverAvailable && !computerUseStatusOk) {
    console.warn(
      'Computer-use daemon not detected in sandbox image. Engagement may still run, but confirmation evidence requires cua-driver or /computeruse/status.',
    );
  }

  return {
    bundledSkillPresent,
    cuaDriverAvailable,
    computerUseStatusOk,
    visionHelperPresent,
    usedFallback,
  };
}

async function ensureFallbackComputerUseAssets(sandbox: Sandbox): Promise<void> {
  await executeChecked(
    sandbox,
    [`mkdir -p ${shellQuote(`${BENCHPRESS_ROOT}/bin`)}`, `mkdir -p ${shellQuote(`${BENCHPRESS_ROOT}/logs`)}`].join(' && '),
    '/',
    30,
  );

  const cuaDriverStatus = await executeOptional(sandbox, 'cua-driver status >/dev/null 2>&1', '/', 20);
  if (cuaDriverStatus.exitCode !== 0) {
    console.warn('Fallback computer-use check: cua-driver status failed inside sandbox.');
  }

  const readScreenshotScript = `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.argv[2];
if (!path) {
  console.error('Usage: read-screenshot <image-path>');
  process.exit(2);
}
if (!fs.existsSync(path)) {
  console.error('Screenshot not found: ' + path);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, path, note: 'benchpress fallback read-screenshot stub' }));
`;

  await executeChecked(
    sandbox,
    [
      `cat > ${shellQuote(`${BENCHPRESS_ROOT}/bin/read-screenshot.cjs`)} <<'BENCHPRESS_READ_SCREENSHOT_EOF'`,
      readScreenshotScript.trimEnd(),
      'BENCHPRESS_READ_SCREENSHOT_EOF',
      `chmod 755 ${shellQuote(`${BENCHPRESS_ROOT}/bin/read-screenshot.cjs`)}`,
      `ln -sf ${shellQuote(`${BENCHPRESS_ROOT}/bin/read-screenshot.cjs`)} ${shellQuote(`${BENCHPRESS_ROOT}/bin/read-screenshot`)}`,
    ].join('\n'),
    '/',
    30,
  );
}
