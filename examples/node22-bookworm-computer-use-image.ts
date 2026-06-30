#!/usr/bin/env tsx
/**
 * Builds a declarative Daytona `Image` that mirrors the app-parity computer-use sandbox: Node 22
 * (required by autobrin-flue staging/main — see README "Sandbox requirements"), an XFCE/Xvfb
 * desktop, a browser, and the `cua-driver` CLI.
 *
 * Why this exists (superagent-ai/benchpress#5): there is no published Daytona *snapshot* with this
 * exact combination, so `bench daytona doctor/run --image`/`--snapshot` (string flags) can't name
 * one. The lower-level `createSandbox()` in `src/daytona/client.ts` already accepts a `string |
 * Image` (via `CreateSandboxFromImageParams`), so a script like this one can build the image inline
 * and hand it straight to `createSandbox` -- no changes to benchpress's CLI or option types needed.
 *
 * Usage:
 *   dotenvx run -f ~/.config/secrets/global.env -- npx tsx examples/node22-bookworm-computer-use-image.ts
 *
 * Requires DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID). Building the image from
 * scratch (apt installs, cua-driver download) typically takes a few minutes on first run.
 */
import { fileURLToPath } from 'node:url';
import { Image } from '@daytona/sdk';
import {
  createDaytonaClient,
  createSandbox,
  deleteDaytonaSandbox,
  disableSandboxAutoStop,
} from '../src/daytona/client.js';
import { ensureComputerUseAssets } from '../src/daytona/assets.js';

// Mirrors superagent-ai/app's `node:22-bookworm` computer-use image recipe (apt packages + the
// `cua-driver` install script from https://raw.githubusercontent.com/trycua/cua). Omits app's
// Claude Code-specific skill registration step, which doesn't apply to AutoBrin/benchpress.
const BASE_PACKAGES = ['bash', 'ca-certificates', 'curl', 'git', 'gnupg', 'lsb-release', 'python3', 'python3-pip', 'ripgrep'];
const DESKTOP_PACKAGES = [
  'xvfb',
  'xfce4',
  'xfce4-terminal',
  'dbus-x11',
  'at-spi2-core',
  'libx11-6',
  'libxrandr2',
  'libxext6',
  'libxrender1',
  'libxfixes3',
  'libxss1',
  'libxtst6',
  'libxi6',
];
const CUA_DRIVER_RUNTIME_PACKAGES = ['tar', 'gzip', 'procps'];
const BROWSER_PACKAGES = ['chromium', 'xdg-utils'];

const CUA_DRIVER_INSTALL_COMMAND = [
  'CUA_DRIVER_RS_HOME=/opt/cua-driver',
  'CUA_DRIVER_RS_INSTALL_DIR=/usr/local/bin',
  'CUA_DRIVER_RS_NO_MODIFY_PATH=1',
  '/bin/bash -c',
  '"$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"',
].join(' ');

export function buildNode22BookwormComputerUseImage(): Image {
  return Image.base('node:22-bookworm')
    .runCommands(
      [
        'apt-get update',
        [
          'apt-get install -y --no-install-recommends',
          BASE_PACKAGES.join(' '),
          DESKTOP_PACKAGES.join(' '),
          CUA_DRIVER_RUNTIME_PACKAGES.join(' '),
          BROWSER_PACKAGES.join(' '),
        ].join(' '),
        'mkdir -p -m 0755 /etc/apt/keyrings',
        'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null',
        'chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list >/dev/null',
        'apt-get update',
        'apt-get install -y --no-install-recommends gh',
        'rm -rf /var/lib/apt/lists/*',
        CUA_DRIVER_INSTALL_COMMAND,
        'chmod -R a+rX /opt/cua-driver && chmod 755 /usr/local/bin/cua-driver',
      ].join(' && '),
      'getent group daytona >/dev/null || groupadd -r daytona',
      'id -u daytona >/dev/null 2>&1 || useradd -r -g daytona -m -d /home/daytona daytona',
      'mkdir -p /home/daytona && chown -R daytona:daytona /home/daytona',
    )
    .workdir('/home/daytona')
    .entrypoint(['/bin/bash']);
}

async function main(): Promise<void> {
  const daytona = createDaytonaClient(process.env);
  console.error('Building Node 22 bookworm computer-use image and creating sandbox (this can take a few minutes)...');

  const sandbox = await createSandbox(daytona, {
    kind: 'image',
    image: buildNode22BookwormComputerUseImage(),
    autoStopInterval: 0,
  });

  try {
    console.error(`Sandbox created: ${sandbox.id}`);
    await disableSandboxAutoStop(sandbox);

    const node = await sandbox.process.executeCommand('node --version', '/', undefined, 15);
    console.error(`node --version -> ${node.result.trim()} (exit ${node.exitCode})`);

    // cua-driver is installed but its daemon/start flow is app-managed (see README + issue #4);
    // ensureComputerUseAssets only probes it informationally, it never gates this script.
    const computerUse = await ensureComputerUseAssets(sandbox);
    console.error(`Computer-use assets: ${JSON.stringify(computerUse, null, 2)}`);
  } finally {
    await deleteDaytonaSandbox(sandbox.id, process.env);
    console.error(`Sandbox deleted: ${sandbox.id}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
