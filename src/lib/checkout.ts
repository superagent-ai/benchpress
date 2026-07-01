import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AUTOBRIN_FLUE_REPO, git, resolveGitRef, runCommand } from './git.js';
import { cacheRoot } from './paths.js';
import { slugify } from './json.js';

export type EnsureAutobrinCheckoutOptions = {
  ref?: string;
  path?: string;
};

export type AutobrinCheckout = {
  root: string;
  ref: string;
  commitSha: string;
};

/**
 * Runs `git clone` and throws a descriptive error on failure (auth, network,
 * bad ref, etc.) instead of resolving silently. Callers that swallow this
 * failure end up masking it behind a confusing, misattributed
 * `spawn git ENOENT` from a *later* command run against the still-missing
 * clone target -- Node reports ENOENT against the executable name even when
 * the real cause is a nonexistent `cwd` (see `runCommand`/`spawn` cwd
 * semantics), which is not the actual failure here.
 */
async function cloneOrThrow(args: string[], context: string): Promise<void> {
  const result = await runCommand('git', args, {});
  if (result.exitCode !== 0) {
    throw new Error(`git clone failed for ${context} (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** True when `dir` exists and is a non-empty directory `git -C <dir>` could be run against. */
async function isExistingCheckout(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export async function ensureAutobrinCheckout(options: EnsureAutobrinCheckoutOptions): Promise<AutobrinCheckout> {
  if (options.path) {
    const root = path.resolve(options.path);
    const commitSha = await resolveGitRef(root, 'HEAD');
    const ref = options.ref ?? commitSha;
    return { root, ref, commitSha };
  }

  const ref = options.ref ?? process.env.AUTOBRIN_FLUE_REF?.trim() ?? 'staging';
  const cacheDir = path.join(cacheRoot(), 'autobrin-flue', slugify(ref));
  await mkdir(path.dirname(cacheDir), { recursive: true });

  if (await isExistingCheckout(cacheDir)) {
    try {
      await git(['rev-parse', 'HEAD'], cacheDir);
      await git(['fetch', 'origin', ref, '--depth', '1'], cacheDir);
      await git(['checkout', 'FETCH_HEAD'], cacheDir);
    } catch {
      await cloneOrThrow(['clone', '--filter=blob:none', '--branch', ref, AUTOBRIN_FLUE_REPO, cacheDir], `autobrin-flue@${ref}`);
    }
  } else {
    await cloneOrThrow(['clone', '--filter=blob:none', '--branch', ref, AUTOBRIN_FLUE_REPO, cacheDir], `autobrin-flue@${ref}`);
  }

  const commitSha = await resolveGitRef(cacheDir, 'HEAD');
  return { root: cacheDir, ref, commitSha };
}

export async function ensureVendorClone(options: {
  repo: string;
  commit: string;
  dirName: string;
}): Promise<string> {
  const target = path.join(cacheRoot(), 'vendor', options.dirName);
  await mkdir(path.dirname(target), { recursive: true });

  if (await isExistingCheckout(target)) {
    try {
      await git(['rev-parse', 'HEAD'], target);
      await git(['fetch', 'origin', options.commit, '--depth', '1'], target);
      await git(['checkout', 'FETCH_HEAD'], target);
    } catch {
      await cloneOrThrow(['clone', '--filter=blob:none', options.repo, target], options.repo);
      await git(['checkout', options.commit], target);
    }
  } else {
    await cloneOrThrow(['clone', '--filter=blob:none', options.repo, target], options.repo);
    await git(['checkout', options.commit], target);
  }

  const head = await resolveGitRef(target, 'HEAD');
  if (head !== options.commit) {
    await git(['checkout', options.commit], target);
  }

  return target;
}
