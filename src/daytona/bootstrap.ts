import type { Sandbox } from '@daytona/sdk';
import {
  AUTOBRIN_FLUE_DIR,
  BENCHPRESS_ROOT,
  LOGS_DIR,
  TARGET_DIR,
  WORKSPACE_DIR,
} from './constants.js';
import type { EngagementPayload } from './payload.js';
import { executeChecked, executeOptional } from './sandbox-exec.js';
import { shellQuote } from './shell.js';

export type BootstrapOptions = {
  ref: string;
  repository?: string;
  githubToken?: string;
};

export async function ensureWorkspaceLayout(sandbox: Sandbox): Promise<void> {
  await executeChecked(
    sandbox,
    [
      `mkdir -p ${shellQuote(BENCHPRESS_ROOT)}`,
      `mkdir -p ${shellQuote(LOGS_DIR)}`,
      `mkdir -p ${shellQuote(WORKSPACE_DIR)}`,
      `mkdir -p ${shellQuote(AUTOBRIN_FLUE_DIR)}`,
    ].join(' && '),
    '/',
    30,
  );
}

export async function bootstrapAutobrinFlue(sandbox: Sandbox, options: BootstrapOptions): Promise<void> {
  await ensureWorkspaceLayout(sandbox);

  const repo = options.repository ?? process.env.AUTOBRIN_FLUE_REPOSITORY ?? 'https://github.com/superagent-ai/autobrin-flue.git';
  const ref = options.ref;
  const githubToken = options.githubToken ?? process.env.AUTOBRIN_FLUE_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

  const cloneScript = [
    'set -euo pipefail',
    `ROOT=${shellQuote(AUTOBRIN_FLUE_DIR)}`,
    `REPO=${shellQuote(repo)}`,
    `REF=${shellQuote(ref)}`,
    `TMP=${shellQuote(`${BENCHPRESS_ROOT}/.autobrin-flue-checkout`)}`,
    'if [ ! -f "$ROOT/package.json" ]; then',
    '  rm -rf "$ROOT" "$TMP"',
    '  CLONE_URL="$REPO"',
    '  if [ -n "$AUTOBRIN_FLUE_GITHUB_TOKEN" ] && [[ "$REPO" == https://github.com/* ]]; then',
    '    CLONE_URL="https://x-access-token:${AUTOBRIN_FLUE_GITHUB_TOKEN}@github.com/${REPO#https://github.com/}"',
    '  fi',
    `  git clone --depth 1 --branch "$REF" "$CLONE_URL" "$TMP" >> ${shellQuote(`${LOGS_DIR}/autobrin-flue-clone.log`)} 2>&1`,
    '  mkdir -p "$ROOT"',
    '  if [ -f "$TMP/.argusignore" ]; then',
    '    (cd "$TMP" && tar --exclude-from=.argusignore -cf - .) | tar -C "$ROOT" -xf -',
    '  else',
    '    (cd "$TMP" && tar --exclude-vcs -cf - .) | tar -C "$ROOT" -xf -',
    '  fi',
    '  rm -rf "$TMP"',
    'fi',
    `cd ${shellQuote(AUTOBRIN_FLUE_DIR)}`,
    'if [ ! -d node_modules ]; then',
    `  npm install >> ${shellQuote(`${LOGS_DIR}/autobrin-flue-install.log`)} 2>&1`,
    'fi',
    'if [ ! -d dist ] && [ ! -d .flue/dist ] && [ ! -d .flue/build ]; then',
    `  npm run build >> ${shellQuote(`${LOGS_DIR}/autobrin-flue-build.log`)} 2>&1`,
    'fi',
  ].join('\n');

  await executeChecked(sandbox, cloneScript, '/', 900, {
    AUTOBRIN_FLUE_GITHUB_TOKEN: githubToken,
  });
}

export async function prepareRepoTarget(
  sandbox: Sandbox,
  payload: Extract<EngagementPayload, { modality: 'repo' }>,
  githubToken?: string,
): Promise<void> {
  await executeChecked(
    sandbox,
    [`mkdir -p ${shellQuote(WORKSPACE_DIR)}`, `rm -rf ${shellQuote(TARGET_DIR)}`].join(' && '),
    '/',
    30,
  );

  const token = githubToken ?? process.env.GH_TOKEN ?? process.env.AUTOBRIN_FLUE_GITHUB_TOKEN ?? '';
  const cloneUrl = payload.repo.startsWith('http') ? payload.repo : `https://github.com/${payload.repo.replace(/^\//, '')}`;

  const cloneScript = [
    'set -euo pipefail',
    `TARGET=${shellQuote(TARGET_DIR)}`,
    `CLONE_URL=${shellQuote(cloneUrl)}`,
    'if [ -n "$GITHUB_ACCESS_TOKEN" ] && [[ "$CLONE_URL" == https://github.com/* ]]; then',
    '  CLONE_URL="https://x-access-token:${GITHUB_ACCESS_TOKEN}@github.com/${CLONE_URL#https://github.com/}"',
    'fi',
    'git clone --depth 1 "$CLONE_URL" "$TARGET"',
    payload.sha ? `git -C "$TARGET" checkout ${shellQuote(payload.sha)}` : '',
    'git -C "$TARGET" rev-parse HEAD',
  ]
    .filter(Boolean)
    .join('\n');

  await executeChecked(sandbox, cloneScript, '/', 600, {
    GITHUB_ACCESS_TOKEN: token,
  });
}

export async function prepareWebappTarget(
  sandbox: Sandbox,
  payload: Extract<EngagementPayload, { modality: 'webapp' }>,
): Promise<void> {
  const url = payload.target.url;
  const probe = await executeOptional(
    sandbox,
    `curl -fsS -o /dev/null -w '%{http_code}' ${shellQuote(url)} | grep -Eq '^(2|3)'`,
    '/',
    30,
  );
  if (probe.exitCode !== 0) {
    console.warn(
      `Webapp target ${url} is not reachable from the sandbox yet. Boot logic depends on autobrin-flue#158.`,
    );
  }
}
