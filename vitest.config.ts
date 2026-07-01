import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Real local verification runs (`bench matrix`/`bench run`) populate
    // `.cache/autobrin-flue/<ref>` with a full autobrin-flue checkout,
    // `vendor/` with vendored benchmark repos, etc. Those nested repos ship
    // their own test suites (e.g. autobrin-flue's `tests/autobrin.test.ts`),
    // which fail here because they assume they're running from their own
    // repo root, not benchpress's. Exclude every gitignored generated/vendor
    // directory in addition to vitest's own defaults.
    exclude: [...configDefaults.exclude, '.cache/**', 'vendor/**', 'runs/**', 'results/**', 'engagements/**'],
  },
});
