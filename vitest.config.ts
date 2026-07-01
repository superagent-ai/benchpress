import { defineConfig } from 'vitest/config';

// Without an explicit `exclude`, vitest's default test glob (`**/*.test.ts`) also matches test
// files inside benchpress's own gitignored, generated directories -- most importantly
// `.cache/autobrin-flue/<ref>/tests/**`, which `src/lib/checkout.ts` populates with a full clone
// (including its own test suite) the first time any `autobrin` contender actually runs. Discovered
// via a real `bench run` against superagent-ai/benchpress#15's BountyBench target: those nested
// tests fail here because they resolve against this project's vitest/tsconfig, not autobrin-flue's
// own -- entirely unrelated to whether autobrin-flue itself is healthy.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.cache/**', '**/vendor/**', '**/runs/**', '**/results/**', '**/engagements/**'],
  },
});
