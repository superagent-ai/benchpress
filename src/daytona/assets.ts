import type { Sandbox } from '@daytona/sdk';
import {
  AUTOBRIN_BUNDLED_COMPUTER_USE_SKILL,
  AUTOBRIN_FLUE_DIR,
  BENCHPRESS_ROOT,
  COMPUTER_USE_START_POLL_INTERVAL_MS,
  COMPUTER_USE_START_TIMEOUT_MS,
  DEFAULT_COMPUTER_USE_BASE_URL,
} from './constants.js';
import { executeChecked, executeOptional } from './sandbox-exec.js';
import { shellQuote } from './shell.js';

export type ComputerUseAssetStatus = {
  bundledSkillPresent: boolean;
  cuaDriverAvailable: boolean;
  computerUseStatusOk: boolean;
  computerUseScreenshotOk: boolean;
  visionHelperPresent: boolean;
  usedFallback: boolean;
};

export type ComputerUseScreenshotCheck = {
  ok: boolean;
  bytes: number;
  exitCode: number;
  output: string;
};

/**
 * Checks that the Toolbox loopback screenshot endpoint returns a non-empty image.
 *
 * This (together with `/computeruse/status` reachability) is the real-world signal that
 * computer-use is usable inside the sandbox — not `cua-driver` presence or daemon status. Some
 * app-parity images install `cua-driver` without a running daemon or a `start` subcommand, and
 * some images (e.g. generic `daytona-large`) don't install it at all, even though Toolbox CU
 * works end-to-end in both cases. See https://github.com/superagent-ai/benchpress/issues/4.
 */
export async function checkComputerUseScreenshot(
  sandbox: Sandbox,
  baseUrl: string = DEFAULT_COMPUTER_USE_BASE_URL,
): Promise<ComputerUseScreenshotCheck> {
  const screenshotUrl = `${baseUrl}/computeruse/screenshot`;
  const script = [
    'shot="$(mktemp /tmp/benchpress-cu-screenshot.XXXXXX)"',
    `if curl -fsS -o "$shot" ${shellQuote(screenshotUrl)} && test -s "$shot"; then`,
    '  wc -c < "$shot"',
    '  rc=0',
    'else',
    '  rc=1',
    'fi',
    'rm -f "$shot"',
    'exit "$rc"',
  ].join('\n');

  const response = await executeOptional(sandbox, script, '/', 20);
  const output = response.result.trim();
  const bytes = Number.parseInt(output, 10);
  const sizeOk = Number.isFinite(bytes) && bytes > 0;

  return {
    ok: response.exitCode === 0 && sizeOk,
    bytes: sizeOk ? bytes : 0,
    exitCode: response.exitCode,
    output,
  };
}

export type ComputerUseStartOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/**
 * Starts the sandbox's computer-use process stack (Xvfb, xfce4, x11vnc, novnc) via the Daytona
 * SDK and polls a real screenshot capture until it succeeds or `timeoutMs` elapses.
 *
 * `sandbox.computerUse.start()` resolving does not mean the desktop is screenshot-ready yet --
 * these are supervised processes that take a moment to come up. Without this wait, callers race
 * ahead and see the exact `computerUseScreenshotOk: false` symptom this fixes (see
 * https://github.com/superagent-ai/benchpress/issues/38).
 *
 * Never throws: a failed start() call or a readiness timeout is logged clearly and this returns
 * `false` so callers proceed without computer-use rather than aborting the whole engagement --
 * some sandboxes genuinely don't support it, and most engagements only need it for optional
 * visual confirmation (see `ensureComputerUseAssets` below, which treats the same signals as
 * non-fatal for the same reason).
 */
export async function ensureComputerUseStarted(
  sandbox: Sandbox,
  options: ComputerUseStartOptions = {},
): Promise<boolean> {
  const baseUrl = options.baseUrl ?? DEFAULT_COMPUTER_USE_BASE_URL;
  const timeoutMs = options.timeoutMs ?? COMPUTER_USE_START_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? COMPUTER_USE_START_POLL_INTERVAL_MS;

  try {
    await sandbox.computerUse.start();
  } catch (error) {
    console.warn(
      `sandbox.computerUse.start() failed on sandbox ${sandbox.id}: ${error instanceof Error ? error.message : String(error)}. Continuing without computer-use.`,
    );
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await checkComputerUseScreenshot(sandbox, baseUrl)).ok) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.warn(
    `Computer-use did not become screenshot-ready within ${timeoutMs}ms of sandbox.computerUse.start() on sandbox ${sandbox.id} (Xvfb/xfce4/x11vnc/novnc may not be supported on this image). Continuing without confirmed computer-use readiness.`,
  );
  return false;
}

export async function ensureComputerUseAssets(sandbox: Sandbox): Promise<ComputerUseAssetStatus> {
  const bundledSkillPath = `${AUTOBRIN_FLUE_DIR}/${AUTOBRIN_BUNDLED_COMPUTER_USE_SKILL}`;
  const bundledCheck = await executeOptional(
    sandbox,
    `test -d ${shellQuote(bundledSkillPath)}`,
    '/',
    15,
  );
  const bundledSkillPresent = bundledCheck.exitCode === 0;

  // cua-driver is app-native sugar, not a hard requirement: presence/daemon status is informational
  // only and never gates readiness below. See https://github.com/superagent-ai/benchpress/issues/4.
  const cuaDriverCheck = await executeOptional(sandbox, 'command -v cua-driver >/dev/null 2>&1', '/', 15);
  const cuaDriverAvailable = cuaDriverCheck.exitCode === 0;

  const computerUseStatus = await executeOptional(
    sandbox,
    `curl -fsS ${shellQuote(`${DEFAULT_COMPUTER_USE_BASE_URL}/computeruse/status`)} >/dev/null`,
    '/',
    20,
  );
  const computerUseStatusOk = computerUseStatus.exitCode === 0;
  const computerUseScreenshotOk = (await checkComputerUseScreenshot(sandbox)).ok;

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

  if (!computerUseStatusOk || !computerUseScreenshotOk) {
    console.warn(
      `Computer-use Toolbox check incomplete (status reachable: ${computerUseStatusOk}, screenshot capture: ${computerUseScreenshotOk}). Engagement may still run, but live-computer confirmation evidence may be unavailable. (cua-driver presence/daemon status is informational only and does not gate this — see superagent-ai/benchpress#4.)`,
    );
  } else if (!cuaDriverAvailable) {
    console.error(
      'Note: cua-driver CLI not detected in sandbox image (informational only — Toolbox loopback status and screenshot capture both succeeded, which is what AutoBrin engagements actually require).',
    );
  }

  return {
    bundledSkillPresent,
    cuaDriverAvailable,
    computerUseStatusOk,
    computerUseScreenshotOk,
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
    console.warn('Fallback computer-use check: cua-driver status failed inside sandbox (informational only, not required).');
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
