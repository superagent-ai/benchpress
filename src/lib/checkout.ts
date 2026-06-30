import { mkdir } from 'node:fs/promises';
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

  try {
    await git(['rev-parse', 'HEAD'], cacheDir);
    await git(['fetch', 'origin', ref, '--depth', '1'], cacheDir);
    await git(['checkout', 'FETCH_HEAD'], cacheDir);
  } catch {
    await runCommand('git', ['clone', '--filter=blob:none', '--branch', ref, AUTOBRIN_FLUE_REPO, cacheDir], {});
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

  try {
    await git(['rev-parse', 'HEAD'], target);
    await git(['fetch', 'origin', options.commit, '--depth', '1'], target);
    await git(['checkout', 'FETCH_HEAD'], target);
  } catch {
    await runCommand('git', ['clone', '--filter=blob:none', options.repo, target], {});
    await git(['checkout', options.commit], target);
  }

  const head = await resolveGitRef(target, 'HEAD');
  if (head !== options.commit) {
    await git(['checkout', options.commit], target);
  }

  return target;
}
