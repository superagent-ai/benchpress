import type { AgentRunner } from './types.js';
import type { AutobrinContenderConfig } from './autobrin.js';
import type { PithosContenderConfig } from './pithos.js';
import type { CommandContenderConfig } from './command.js';
import { createAutobrinRunner } from './autobrin.js';
import { createPithosRunner } from './pithos.js';
import { createCommandRunner } from './command.js';
import { defaultAutobrinFlueRef } from '../lib/git.js';

export type ContenderConfig = AutobrinContenderConfig | PithosContenderConfig | CommandContenderConfig;

export function contenderIdFromConfig(config: ContenderConfig): string {
  if (config.type === 'autobrin') {
    if (config.id) return config.id;
    if (config.path) return 'autobrin@local';
    return `autobrin@${config.ref ?? defaultAutobrinFlueRef()}`;
  }
  if (config.type === 'pithos') {
    return config.id ?? 'pithos';
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
  if (config.type === 'pithos') {
    return createPithosRunner({
      ...config,
      id: contenderIdFromConfig(config),
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
  { id: 'pithos', type: 'pithos', provider: 'azure-openai-responses' },
  {
    id: '<your-tool>',
    type: 'command',
    command: '<your-tool> run {repo} --model {model}',
  },
];
