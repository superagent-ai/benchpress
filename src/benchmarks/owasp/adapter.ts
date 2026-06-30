import { stubAdapter } from '../types.js';

export const owaspAdapter = stubAdapter({
  id: 'owasp',
  description: 'OWASP Benchmark: CWE-labeled servlet test cases with Youden scoring.',
  dependency: 'Requires autobrin-flue detect-only mode and CWE-label oracle mapping (not implemented yet).',
});
