export const BENCHPRESS_ROOT = '/home/daytona/benchpress';
export const AUTOBRIN_FLUE_DIR = `${BENCHPRESS_ROOT}/autobrin-flue`;
export const WORKSPACE_DIR = `${BENCHPRESS_ROOT}/workspace`;
export const TARGET_DIR = `${WORKSPACE_DIR}/target`;
export const LOGS_DIR = `${BENCHPRESS_ROOT}/logs`;
export const PAYLOAD_PATH = `${BENCHPRESS_ROOT}/autobrin-engagement-payload.json`;
export const RESULT_PATH = `${BENCHPRESS_ROOT}/result.json`;

export const DEFAULT_AUTOBRIN_FLUE_MODEL = 'kimi-azure/kimi-k2.6';
export const DEFAULT_AUTOBRIN_FLUE_REPOSITORY = 'https://github.com/superagent-ai/autobrin-flue.git';
export const DEFAULT_COMPUTER_USE_BASE_URL = 'http://127.0.0.1:2280';

/**
 * Sane bound on how long to wait for `sandbox.computerUse.start()` (Xvfb/xfce4/x11vnc/novnc) to
 * become screenshot-ready before giving up and proceeding without confirmed readiness.
 * See https://github.com/superagent-ai/benchpress/issues/38.
 */
export const COMPUTER_USE_START_TIMEOUT_MS = 60_000;
export const COMPUTER_USE_START_POLL_INTERVAL_MS = 2_000;

export const ALLOWED_FLUE_REFS = ['staging', 'main'] as const;
export type AllowedFlueRef = (typeof ALLOWED_FLUE_REFS)[number];

export const AUTOBRIN_BUNDLED_COMPUTER_USE_SKILL = '.agents/skills/autobrin-computer-use';
