import {
  ALLOWED_FLUE_REFS,
  BENCHPRESS_ROOT,
  DEFAULT_AUTOBRIN_FLUE_MODEL,
  DEFAULT_AUTOBRIN_FLUE_REPOSITORY,
  DEFAULT_COMPUTER_USE_BASE_URL,
  type AllowedFlueRef,
} from './constants.js';
import type { Env } from './client.js';

const AUTOBRIN_FLUE_ENV_KEYS = [
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'FIRECRAWL_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'AUTOBRIN_FLUE_REPOSITORY',
  'AUTOBRIN_FLUE_REF',
  'AUTOBRIN_FLUE_GITHUB_TOKEN',
  'AUTOBRIN_FLUE_MODEL',
  'AUTOBRIN_FLUE_THINKING',
  'AUTOBRIN_FLUE_CONTRIBUTORS',
  'AUTOBRIN_FLUE_PROVIDER_RETRY_MAX_ELAPSED_MS',
  'AUTOBRIN_FLUE_PROVIDER_RETRY_INITIAL_DELAY_MS',
  'AUTOBRIN_FLUE_PROVIDER_RETRY_MAX_DELAY_MS',
  'AUTOBRIN_FLUE_PROVIDER_RETRY_MAX_ATTEMPTS',
  'AUTOBRIN_FLUE_SKILL_TIMEOUT_MS',
  'AUTOBRIN_FLUE_INPUT_COST_PER_1M',
  'AUTOBRIN_FLUE_OUTPUT_COST_PER_1M',
  'AUTOBRIN_FLUE_CACHED_INPUT_COST_PER_1M',
] as const;

const COMPUTER_USE_ENV_KEYS = [
  'AUTOBRIN_COMPUTER_USE',
  'AUTOBRIN_COMPUTER_USE_BASE_URL',
  'CUA_SCREENSHOT_VISION_MODEL',
  'GOOGLE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
] as const;

export function assertAllowedFlueRef(ref: string): AllowedFlueRef {
  if (!ALLOWED_FLUE_REFS.includes(ref as AllowedFlueRef)) {
    throw new Error(
      `AUTOBRIN_FLUE_REF must be a branch pin (${ALLOWED_FLUE_REFS.join(' or ')}); got ${JSON.stringify(ref)}`,
    );
  }
  return ref as AllowedFlueRef;
}

export function resolveFlueRef(env: Env = process.env, override?: string): AllowedFlueRef {
  const ref = override ?? env.AUTOBRIN_FLUE_REF?.trim() ?? 'staging';
  return assertAllowedFlueRef(ref);
}

export function getAutoBrinFlueEnvVars(env: Env = process.env): Record<string, string> {
  const envVars: Record<string, string> = {
    AUTOBRIN_FLUE_MODEL: env.AUTOBRIN_FLUE_MODEL || DEFAULT_AUTOBRIN_FLUE_MODEL,
  };

  for (const key of AUTOBRIN_FLUE_ENV_KEYS) {
    const value = env[key];
    if (value) envVars[key] = value;
  }

  if (!envVars.AUTOBRIN_FLUE_REPOSITORY) {
    envVars.AUTOBRIN_FLUE_REPOSITORY = DEFAULT_AUTOBRIN_FLUE_REPOSITORY;
  }

  return envVars;
}

export type BuildSandboxEnvOptions = {
  env?: Env;
  ref?: string;
  visionModel?: string;
  workspaceRoot?: string;
};

export function buildSandboxEnv(options: BuildSandboxEnvOptions = {}): Record<string, string> {
  const env = options.env ?? process.env;
  const ref = resolveFlueRef(env, options.ref);
  const visionModel = options.visionModel ?? env.CUA_SCREENSHOT_VISION_MODEL?.trim();

  const envVars: Record<string, string> = {
    ...getAutoBrinFlueEnvVars(env),
    AUTOBRIN_FLUE_REF: ref,
    AUTOBRIN_COMPUTER_USE: env.AUTOBRIN_COMPUTER_USE?.trim() || 'daytona',
    AUTOBRIN_COMPUTER_USE_BASE_URL: env.AUTOBRIN_COMPUTER_USE_BASE_URL?.trim() || DEFAULT_COMPUTER_USE_BASE_URL,
    BENCHPRESS_ROOT,
  };

  if (options.workspaceRoot) {
    envVars.BENCHPRESS_WORKSPACE_ROOT = options.workspaceRoot;
  }

  if (visionModel) {
    envVars.CUA_SCREENSHOT_VISION_MODEL = visionModel;
  }

  for (const key of COMPUTER_USE_ENV_KEYS) {
    const value = env[key];
    if (value && !envVars[key]) {
      envVars[key] = value;
    }
  }

  return envVars;
}
