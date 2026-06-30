import { stubAdapter } from '../types.js';

export const bountyBenchAdapter = stubAdapter({
  id: 'bountybench',
  description: 'BountyBench: bounty systems with per-vuln verifiers and dollar scoring.',
  dependency:
    'Requires autobrin-flue webapp modality + computer-use (exploit lane) and detect-only mode (detect lane).',
});
