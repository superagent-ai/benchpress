import { stubAdapter } from '../types.js';

export const cyberGymAdapter = stubAdapter({
  id: 'cybergym',
  description: 'CyberGym: dockerized memory-safety tasks with sanitizer verification.',
  dependency:
    'Requires autobrin-flue PoC-generation contributor skill and differential patched oracle (not implemented yet).',
});
