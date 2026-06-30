import type { AgentRunner } from './types.js';
import type { AutobrinContenderConfig } from './autobrin.js';
import type { CommandContenderConfig } from './command.js';
import { createAutobrinRunner } from './autobrin.js';
import { createCommandRunner } from './command.js';
import { defaultAutobrinFlueRef } from '../lib/git.js';

export type ContenderConfig = AutobrinContenderConfig | CommandContenderConfig;

export function contenderIdFromConfig(config: ContenderConfig): string {
  if (config.type === 'autobrin') {
    if (config.id) return config.id;
    if (config.path) return 'autobrin@local';
    return `autobrin@${config.ref ?? defaultAutobrinFlueRef()}`;
  }
  return config.id;
}

export function createContender(config: ContenderConfig): AgentRunner {
  if (config.type === 'autobrin') {
    return createAutobrinRunner({
      config: {
        ...config,
        id: contenderIdFromConfig(config),
      },
    });
  }
  return createCommandRunner(config);
}

export function createContenders(configs: ContenderConfig[]): AgentRunner[] {
  return configs.map((config) => createContender(config));
}

export const exampleContenderConfigs: ContenderConfig[] = [
  { id: 'autobrin@staging', type: 'autobrin', ref: 'staging' },
  { id: 'autobrin@main', type: 'autobrin', ref: 'main' },
  {
    id: '<your-tool>',
    type: 'command',
    command: '<your-tool> run {repo} --model {model}',
  },
];
