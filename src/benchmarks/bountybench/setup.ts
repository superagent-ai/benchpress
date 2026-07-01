import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, resolveGitRef, runCommand } from '../../lib/git.js';
import { ensureVendorClone } from '../../lib/checkout.js';
import { readJsonRequired } from '../../lib/json.js';
import { cacheRoot } from '../../lib/paths.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export type BountyTasksVendorLock = {
  repo: string;
  commit: string;
  systemPaths: string[];
};

async function readVendorLock(): Promise<BountyTasksVendorLock> {
  return readJsonRequired<BountyTasksVendorLock>(path.join(moduleDir, 'vendor.lock.json'));
}

/**
 * Sparse-clones the pinned commit of the `bountybench/bountytasks` monorepo,
 * fetching only the system directories this adapter uses (see
 * `vendor.lock.json`). The upstream repo holds ~25 systems x their bounty
 * writeups (HTML snapshots with embedded assets); a full clone would pull
 * far more than benchpress needs for a 3-system representative subset.
 */
export async function ensureBountyTasksVendor(): Promise<string> {
  const lock = await readVendorLock();
  const target = path.join(cacheRoot(), 'vendor', 'bountybench-tasks');
  await mkdir(path.dirname(target), { recursive: true });

  const alreadyCloned = await git(['rev-parse', 'HEAD'], target).then(
    () => true,
    () => false,
  );

  if (!alreadyCloned) {
    const cloneResult = await runCommand(
      'git',
      ['clone', '--filter=blob:none', '--no-checkout', '--sparse', lock.repo, target],
      {},
    );
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Failed to clone ${lock.repo}: ${cloneResult.stderr.trim()}`);
    }
    await git(['sparse-checkout', 'set', ...lock.systemPaths], target);
    await git(['checkout', lock.commit], target);
  }

  const head = await resolveGitRef(target, 'HEAD');
  if (head !== lock.commit) {
    await git(['fetch', 'origin', lock.commit, '--depth', '1'], target);
    await git(['checkout', 'FETCH_HEAD'], target);
  }

  return target;
}

export function systemVendorDir(vendorRoot: string, systemId: string): string {
  return path.join(vendorRoot, systemId);
}

/**
 * Clones a system's vulnerable-codebase fork (BountyBench pins one fork per
 * system under the `cy-suite` GitHub org; see upstream `.gitmodules`) at a
 * given commit/tag. Only needed for exploit-lane targets, which must
 * actually build and run the app -- repo/patch-modality targets hand
 * `{ repo, sha }` straight to AutoBrin, which clones it itself.
 */
export async function ensureBountyCodebase(input: { systemId: string; repo: string; commit: string }): Promise<string> {
  return ensureVendorClone({
    repo: input.repo,
    commit: input.commit,
    dirName: path.join('bountybench-codebases', input.systemId),
  });
}
