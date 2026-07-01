import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@daytona/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRepoTarget } from '../src/daytona/bootstrap.js';
import type { EngagementPayload } from '../src/daytona/payload.js';

/** Quiet git wrapper: pipes stdio so git's own advice/notice chatter (e.g. detached-HEAD tips) doesn't spill into test output; still throws on a non-zero exit. */
function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function repoPayload(sha?: string): Extract<EngagementPayload, { modality: 'repo' }> {
  return {
    modality: 'repo',
    repo: 'owner/repo',
    sha,
    workspaceRoot: '/home/daytona/benchpress',
    targetPreparation: 'prepared',
    resume: false,
  };
}

/** Records every command handed to the sandbox instead of actually running it -- prepareRepoTarget's target path is a fixed sandbox-side constant, not something a test can safely redirect to a temp dir. */
function capturingSandbox(): { sandbox: Sandbox; commands: string[] } {
  const commands: string[] = [];
  const executeCommand = async (command: string) => {
    commands.push(command);
    return { exitCode: 0, result: '' };
  };
  return { sandbox: { id: 'fake-sandbox', process: { executeCommand } } as unknown as Sandbox, commands };
}

describe('prepareRepoTarget clone script (regression: symbolic-ref shas, e.g. repo-cve-smoke\'s "2.13.0")', () => {
  it('tags FETCH_HEAD as the requested sha, before checkout, so a local ref matching it exists afterward', async () => {
    const { sandbox, commands } = capturingSandbox();
    await prepareRepoTarget(sandbox, repoPayload('2.13.0'), 'token');

    const cloneScript = commands.at(-1)!;
    expect(cloneScript).toContain('git -C "$TARGET" fetch --depth 1 origin "$SHA"');
    expect(cloneScript).toContain('git -C "$TARGET" tag "$SHA" FETCH_HEAD');
    expect(cloneScript.indexOf('tag "$SHA" FETCH_HEAD')).toBeLessThan(cloneScript.indexOf('checkout FETCH_HEAD'));
  });

  it('interpolates an empty SHA (never a literal "undefined") so the script\'s own runtime `if [ -n "$SHA" ]` guard skips tagging for the default-branch-HEAD case', async () => {
    const { sandbox, commands } = capturingSandbox();
    await prepareRepoTarget(sandbox, repoPayload(undefined), 'token');

    const cloneScript = commands.at(-1)!;
    expect(cloneScript).toContain("SHA=''");
    // Both branches of the shell `if` are always present in the generated text regardless of
    // payload.sha (the branching is a runtime shell decision, not a JS string-generation one) --
    // this just guards the interpolated value itself, which is what actually varies.
    expect(cloneScript).toContain('git -C "$TARGET" fetch --depth 1 origin HEAD');
  });
});

describe('git tag-as-sha fix, standalone mechanics (mirrors requirePreparedTarget in autobrin-flue/src/workspace.ts)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A real local git repo (used as a file-path "remote") with one commit tagged like repo-cve-smoke's own vulnerableSha ("2.13.0") -- exercises real git ref resolution without any network access. */
  function makeRemoteRepoWithTag(tagName: string): string {
    const remote = mkdtempSync(path.join(tmpdir(), 'benchpress-remote-'));
    tmpDirs.push(remote);
    git(['init', '--quiet'], remote);
    git(['config', 'user.email', 'test@example.com'], remote);
    git(['config', 'user.name', 'Test'], remote);
    writeFileSync(path.join(remote, 'file.txt'), 'hello\n');
    git(['add', '.'], remote);
    git(['commit', '--quiet', '-m', 'initial'], remote);
    git(['tag', tagName], remote);
    return remote;
  }

  function makeFreshTarget(): string {
    const target = mkdtempSync(path.join(tmpdir(), 'benchpress-target-'));
    tmpDirs.push(target);
    git(['init', '--quiet'], target);
    return target;
  }

  it('reproduces the bug: a bare fetch+checkout of a tag leaves no local ref matching the tag name', () => {
    const tagName = '2.13.0';
    const remote = makeRemoteRepoWithTag(tagName);
    const target = makeFreshTarget();

    git(['fetch', '--depth', '1', remote, tagName], target);
    git(['checkout', 'FETCH_HEAD'], target);

    expect(() => git(['rev-parse', '--verify', `${tagName}^{commit}`], target)).toThrow();
  });

  it('the fix: tagging FETCH_HEAD as the requested sha makes it resolve locally afterward, matching HEAD', () => {
    const tagName = '2.13.0';
    const remote = makeRemoteRepoWithTag(tagName);
    const target = makeFreshTarget();

    git(['fetch', '--depth', '1', remote, tagName], target);
    git(['tag', tagName, 'FETCH_HEAD'], target);
    git(['checkout', 'FETCH_HEAD'], target);

    const resolved = git(['rev-parse', '--verify', `${tagName}^{commit}`], target).trim();
    const head = git(['rev-parse', 'HEAD'], target).trim();
    expect(resolved).toBe(head);
    expect(resolved).toHaveLength(40);
  });

  it('is a no-op for a raw commit sha, which already resolves via the object database alone', () => {
    const remote = makeRemoteRepoWithTag('unused-tag');
    const commitSha = git(['rev-parse', 'HEAD'], remote).trim();
    const target = makeFreshTarget();

    git(['fetch', '--depth', '1', remote, commitSha], target);
    // No tagging at all here -- proves the raw-sha path already worked before this fix, and that
    // tagging it too (as the real script now unconditionally does) would be harmless.
    git(['checkout', 'FETCH_HEAD'], target);

    const resolved = git(['rev-parse', '--verify', `${commitSha}^{commit}`], target).trim();
    expect(resolved).toBe(commitSha);
  });
});
