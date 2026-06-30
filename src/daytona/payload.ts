import { BENCHPRESS_ROOT, WORKSPACE_DIR } from './constants.js';

export type EngagementGuardrails = {
  maxCycles?: number;
  maxEngagementCostUsd?: number;
};

export type RepoEngagementPayload = {
  modality: 'repo';
  repo: string;
  sha?: string;
  workspaceRoot: string;
  targetPreparation: 'prepared' | 'materialize';
  model?: string;
  thinking?: string;
  contributors?: number;
  guardrails?: EngagementGuardrails;
  resume?: boolean;
};

export type WebappEngagementPayload = {
  modality: 'webapp';
  target: { url: string };
  workspaceRoot: string;
  model?: string;
  thinking?: string;
  contributors?: number;
  guardrails?: EngagementGuardrails;
  resume?: boolean;
};

export type EngagementPayload = RepoEngagementPayload | WebappEngagementPayload;

export function buildRepoPayload(input: {
  repo: string;
  sha?: string;
  model?: string;
  thinking?: string;
  contributors?: number;
  guardrails?: EngagementGuardrails;
  workspaceRoot?: string;
}): RepoEngagementPayload {
  return {
    modality: 'repo',
    repo: input.repo,
    sha: input.sha,
    workspaceRoot: input.workspaceRoot ?? BENCHPRESS_ROOT,
    targetPreparation: 'prepared',
    model: input.model,
    thinking: input.thinking,
    contributors: input.contributors,
    guardrails: input.guardrails,
    resume: false,
  };
}

export function buildWebappPayload(input: {
  url: string;
  model?: string;
  thinking?: string;
  contributors?: number;
  guardrails?: EngagementGuardrails;
  workspaceRoot?: string;
}): WebappEngagementPayload {
  return {
    modality: 'webapp',
    target: { url: input.url },
    workspaceRoot: input.workspaceRoot ?? BENCHPRESS_ROOT,
    model: input.model,
    thinking: input.thinking,
    contributors: input.contributors,
    guardrails: input.guardrails,
    resume: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeEngagementPayload(input: unknown): EngagementPayload {
  if (!isRecord(input)) {
    throw new Error('Engagement payload must be a JSON object');
  }

  const modality = input.modality;
  if (modality === 'repo') {
    if (typeof input.repo !== 'string' || !input.repo.trim()) {
      throw new Error('Repo engagement payload requires a non-empty "repo" field');
    }
    return buildRepoPayload({
      repo: input.repo.trim(),
      sha: typeof input.sha === 'string' ? input.sha : undefined,
      model: typeof input.model === 'string' ? input.model : undefined,
      thinking: typeof input.thinking === 'string' ? input.thinking : undefined,
      contributors: typeof input.contributors === 'number' ? input.contributors : undefined,
      guardrails: isRecord(input.guardrails)
        ? {
            maxCycles: typeof input.guardrails.maxCycles === 'number' ? input.guardrails.maxCycles : undefined,
            maxEngagementCostUsd:
              typeof input.guardrails.maxEngagementCostUsd === 'number'
                ? input.guardrails.maxEngagementCostUsd
                : undefined,
          }
        : undefined,
      workspaceRoot: typeof input.workspaceRoot === 'string' ? input.workspaceRoot : BENCHPRESS_ROOT,
    });
  }

  if (modality === 'webapp') {
    const target = input.target;
    if (!isRecord(target) || typeof target.url !== 'string' || !target.url.trim()) {
      throw new Error('Webapp engagement payload requires target.url');
    }
    return buildWebappPayload({
      url: target.url.trim(),
      model: typeof input.model === 'string' ? input.model : undefined,
      thinking: typeof input.thinking === 'string' ? input.thinking : undefined,
      contributors: typeof input.contributors === 'number' ? input.contributors : undefined,
      guardrails: isRecord(input.guardrails)
        ? {
            maxCycles: typeof input.guardrails.maxCycles === 'number' ? input.guardrails.maxCycles : undefined,
            maxEngagementCostUsd:
              typeof input.guardrails.maxEngagementCostUsd === 'number'
                ? input.guardrails.maxEngagementCostUsd
                : undefined,
          }
        : undefined,
      workspaceRoot: typeof input.workspaceRoot === 'string' ? input.workspaceRoot : BENCHPRESS_ROOT,
    });
  }

  throw new Error(`Unsupported engagement modality: ${String(modality)}`);
}

export function engagementWorkspaceDir(payload: EngagementPayload): string {
  return `${payload.workspaceRoot}/workspace`;
}

/**
 * Path where AutoBrin writes its `result.json` checkpoint for this
 * engagement. AutoBrin's `repo`/`model` modalities resolve `engagementRoot`
 * straight from the payload's `workspaceRoot` (see the modality
 * `prepareWorkspace` implementations and `src/workspace.ts` in
 * autobrin-flue), so this must track `payload.workspaceRoot` rather than the
 * launcher's own `BENCHPRESS_ROOT` default -- callers may override
 * `workspaceRoot` away from that default.
 */
export function engagementResultPath(payload: EngagementPayload): string {
  return `${payload.workspaceRoot}/result.json`;
}

export function defaultRepoWorkspace(payload: EngagementPayload): string {
  void payload;
  return WORKSPACE_DIR;
}
