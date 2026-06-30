import { spawn } from 'node:child_process';

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand('git', args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

export async function resolveGitRef(repoDir: string, ref: string): Promise<string> {
  return git(['rev-parse', ref], repoDir);
}

export const AUTOBRIN_FLUE_REPO = 'https://github.com/superagent-ai/autobrin-flue.git';

export function defaultAutobrinFlueRef(): string {
  return process.env.AUTOBRIN_FLUE_REF?.trim() || 'staging';
}
