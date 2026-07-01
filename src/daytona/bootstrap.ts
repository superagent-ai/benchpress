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

/**
 * Builds the human-readable message surfaced when the `autobrin-flue` clone step fails, so the
 * caller can immediately tell "no token configured" apart from "token present but rejected"
 * (insufficient scope / SSO not authorized / HTTP 403) rather than seeing a bare git exit code.
 * superagent-ai/autobrin-flue is private, so `GH_TOKEN` (or `AUTOBRIN_FLUE_GITHUB_TOKEN`) must have
 * read access to it. See https://github.com/superagent-ai/benchpress/issues/5.
 */
export function describeAutobrinFlueCloneFailure(params: {
  repo: string;
  hasToken: boolean;
  logPath: string;
}): string {
  if (!params.hasToken) {
    return [
      'autobrin-flue clone failed: no GitHub token configured.',
      `${params.repo} is private -- set AUTOBRIN_FLUE_GITHUB_TOKEN or GH_TOKEN to a token with read access to it.`,
      `See ${params.logPath} for git's full output.`,
    ].join(' ');
  }
  return [
    'autobrin-flue clone failed even though a GitHub token was provided.',
    `The token likely lacks read access to ${params.repo} (insufficient scope, SSO not authorized, or HTTP 403).`,
    `See ${params.logPath} for git's full output.`,
  ].join(' ');
}

export async function bootstrapAutobrinFlue(sandbox: Sandbox, options: BootstrapOptions): Promise<void> {
  await ensureWorkspaceLayout(sandbox);

  const repo = options.repository ?? process.env.AUTOBRIN_FLUE_REPOSITORY ?? 'https://github.com/superagent-ai/autobrin-flue.git';
  const ref = options.ref;
  const githubToken = options.githubToken ?? process.env.AUTOBRIN_FLUE_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  const cloneLogPath = `${LOGS_DIR}/autobrin-flue-clone.log`;
  const cloneFailureMessage = describeAutobrinFlueCloneFailure({
    repo,
    hasToken: Boolean(githubToken),
    logPath: cloneLogPath,
  });

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
    `  if git clone --depth 1 --branch "$REF" "$CLONE_URL" "$TMP" >> ${shellQuote(cloneLogPath)} 2>&1; then`,
    '    mkdir -p "$ROOT"',
    '    if [ -f "$TMP/.argusignore" ]; then',
    '      (cd "$TMP" && tar --exclude-from=.argusignore -cf - .) | tar -C "$ROOT" -xf -',
    '    else',
    '      (cd "$TMP" && tar --exclude-vcs -cf - .) | tar -C "$ROOT" -xf -',
    '    fi',
    '    rm -rf "$TMP"',
    '  else',
    '    clone_rc=$?',
    `    echo ${shellQuote(cloneFailureMessage)}`,
    '    exit "$clone_rc"',
    '  fi',
    'fi',
    `cd ${shellQuote(AUTOBRIN_FLUE_DIR)}`,
    'if [ ! -d node_modules ]; then',
    `  npm install >> ${shellQuote(`${LOGS_DIR}/autobrin-flue-install.log`)} 2>&1`,
    'fi',
    'if [ ! -f dist/server.mjs ] && [ ! -f .flue/dist/server.mjs ]; then',
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
    `SHA=${shellQuote(payload.sha ?? '')}`,
    'if [ -n "$GITHUB_ACCESS_TOKEN" ] && [[ "$CLONE_URL" == https://github.com/* ]]; then',
    '  CLONE_URL="https://x-access-token:${GITHUB_ACCESS_TOKEN}@github.com/${CLONE_URL#https://github.com/}"',
    'fi',
    'rm -rf "$TARGET"',
    'mkdir -p "$TARGET"',
    'git -C "$TARGET" init',
    'git -C "$TARGET" remote add origin "$CLONE_URL"',
    'if [ -n "$SHA" ]; then',
    '  git -C "$TARGET" fetch --depth 1 origin "$SHA"',
    // autobrin-flue's own `targetPreparation: "prepared"` validation resolves `sha` via
    // `git rev-parse --verify "$SHA^{commit}"` (src/workspace.ts, requirePreparedTarget). A raw
    // 40-char commit hash resolves straight from the object database once fetched, but a
    // symbolic ref like a tag (e.g. repo-cve-smoke's own "2.13.0") does not: `git fetch <ref>`
    // with no explicit local refspec mapping only ever populates FETCH_HEAD, never a same-named
    // local ref. Tagging FETCH_HEAD as "$SHA" is a harmless no-op for the raw-hash case and fixes
    // the symbolic-ref case; the repo was just freshly `git init`'d above, so there is no
    // pre-existing tag to collide with.
    '  git -C "$TARGET" tag "$SHA" FETCH_HEAD',
    'else',
    '  git -C "$TARGET" fetch --depth 1 origin HEAD',
    'fi',
    'git -C "$TARGET" checkout FETCH_HEAD',
    'git -C "$TARGET" rev-parse HEAD',
  ].join('\n');

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
