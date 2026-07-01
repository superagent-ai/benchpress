import { runCommand } from './git.js';

export type PulledDockerImage = {
  image: string;
  /** Resolved image ID (`docker image inspect --format '{{.Id}}'`) for reproducibility. */
  imageId: string;
};

/**
 * Pulls a Docker image by reference. `docker pull` is itself idempotent/cached
 * at the layer level, so this does not attempt its own presence check first.
 */
export async function dockerPull(image: string): Promise<void> {
  const { exitCode, stderr, stdout } = await runCommand('docker', ['pull', image]);
  if (exitCode !== 0) {
    throw new Error(
      `docker pull ${image} failed (${exitCode}): ${stderr.trim() || stdout.trim()}. ` +
        'Requires a reachable Docker daemon (e.g. Colima/Docker Desktop).',
    );
  }
}

export async function dockerImageId(image: string): Promise<string> {
  const { exitCode, stdout, stderr } = await runCommand('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
  if (exitCode !== 0) {
    throw new Error(`docker image inspect ${image} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

/** Pulls an image and returns its resolved ID so callers can record a reproducible reference. */
export async function ensureDockerImage(image: string): Promise<PulledDockerImage> {
  await dockerPull(image);
  const imageId = await dockerImageId(image);
  return { image, imageId };
}
