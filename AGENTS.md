# Agent Notes

benchpress is an **evaluation harness**, not a product core. Keep benchmark-specific churn here; generic capabilities belong in autobrin-flue.

## Design principles

- **Grader is the score.** Never use a contender's self-verdict as the benchmark outcome. Map each benchmark's native grader into `src/oracle/types.ts`.
- **Fairness invariant.** One target per task; identical model, budget, and info level for every contender in a matrix run.
- **Built-in matrix.** Comparisons run in one process (`src/matrix/run.ts`), not separate harness instances per tool.
- **Registries only.** Benchmarks live in `src/benchmarks/registry.ts`; contenders in `src/contenders/registry.ts`. No `if (benchmark === '...')` branching elsewhere.
- **No competing-tool names in source, beyond the explicit head-to-head target.** Ship `autobrin`, `pithos`, and generic `command` runner types. `pithos` is a deliberate, narrow exception because PITHOS is the specific tool this harness exists to compare against (superagent-ai/benchpress#12), not an arbitrary third party; other external tools stay on the generic `command` type named only in gitignored user configs.
- **Generated output uncommitted.** `runs/`, `results/`, `engagements/`, `.cache/`, `vendor/` stay gitignored.
- **One-way dependency on autobrin-flue.** Clone/pin at runtime via contender `ref` or `AUTOBRIN_FLUE_REF`. Do not add benchpress references to autobrin-flue.
- **Daytona provisioning lives here for standalone runs.** `bench daytona run` provisions a Daytona sandbox, bootstraps autobrin-flue inside it, and runs engagements via the same HTTP/SSE flow as the app repo. autobrin-flue core stays consume-only; benchpress owns sandbox lifecycle for engagements and benchmark runs outside app. The `autobrin` contender's `transport: "daytona"` reuses this exact launcher (`runDaytonaEngagement`) rather than duplicating sandbox lifecycle logic — extend the launcher, not the contender, for anything sandbox-level.

## Benchmark capability dependencies

Scientific adapters are **stubbed** until autobrin-flue ships the required generic capabilities:

| Benchmark | Required autobrin-flue capability |
| --- | --- |
| `cve-bench` | `webapp` modality + cross-cutting computer-use confirmation |
| `cybergym` | PoC-generation contributor skill + differential patched oracle |
| `bountybench` | `webapp` + computer-use (exploit) / detect-only mode (detect) |
| `owasp` | `score()` only: detect-only mode ([autobrin-flue#182](https://github.com/superagent-ai/autobrin-flue/issues/182), unmerged) for CWE-label Youden scoring |
| `repo-cve-smoke` | `repo` modality only — **dev-smoke lane**, not for scientific reporting |

Do not implement scientific benchmark bodies until the dependency row is satisfied in autobrin-flue. CVE-Bench may keep `vendor.lock.json` + `setup.ts` wired; `adapter.ts` stays stub until `webapp`/computer-use land. CyberGym is a documented, issue-scoped exception (superagent-ai/benchpress#16): `setup()`/`listTasks()`/`standUpTarget()` don't need the blocked capabilities (vendored task metadata, real dockerized pre-/post-patch target stand-up), so they're implemented for real against a representative subset; only `score()` throws `NotImplementedBenchmarkError` until autobrin-flue#180 (PoC-gen skill) and #181 (differential oracle) land. **Exception carved out by [benchpress#14](https://github.com/superagent-ai/benchpress/issues/14):** `owasp`'s `setup()`/`listTasks()`/`standUpTarget()` don't need detect-only mode at all (vendoring + CSV ground-truth parsing + a `repo`-modality `TargetHandle` are self-contained), so they're implemented for real; only `score()` stays blocked and throws `NotImplementedBenchmarkError`.

## Adding a benchmark

1. Create `src/benchmarks/<id>/adapter.ts` implementing `BenchmarkAdapter` from `src/benchmarks/types.ts`.
2. Register in `src/benchmarks/registry.ts`.
3. Add README under the benchmark subdir.
4. If upstream assets are heavy, use pinned runtime clone + committed lockfile (see `cve-bench/vendor.lock.json`).
5. Add tests under `tests/`.

## Adding a contender

- **autobrin:** `{ "type": "autobrin", "id": "autobrin@<ref>", "ref": "<branch-or-sha>" }` or `{ "path": "/abs/checkout" }` for local trees. `transport: "daytona"` (plus `image`/`snapshot`) runs the engagement inside a Daytona sandbox via `runDaytonaEngagement` instead of local `npx`; default (`transport` omitted, or `"local"`) is unchanged. `path` is rejected with `transport: "daytona"` (no local filesystem for the sandbox to read).
- **pithos:** `{ "type": "pithos", "provider": "<pi-provider-id>", "sandboxMode": "docker" | "local", "maxFindings": <n> }` — requires the `pithos` CLI on `PATH` (`uv tool install git+https://github.com/superagent-ai/PITHOS.git`); parses `TRIAGE.json` + `verify/runtime-summary.json`, not stdout. See README's "PITHOS" section for caveats found by running the real CLI, including "Kimi K2.6 on Azure" for the `src/contenders/pithosKimiAzureExtension.ts` Pi extension (`--provider azure-openai-responses --model kimi-k2.6`) that gets PITHOS onto the same Kimi Azure deployment AutoBrin uses.
- **command:** `{ "type": "command", "id": "<name>", "command": "<tool> run {repo} --model {model}" }` — stdout may be JSON `ContenderClaim`.

## Git workflow

- Default branch: `main`.
- Run `npm run validate` before commit.
- Keep commits atomic; quote paths with brackets.

## Consumer versioning

- `AUTOBRIN_FLUE_REF` (env) or contender `ref` selects which autobrin-flue branch/SHA to clone. Default: `staging`.
- Resolve and record commit SHA on each autobrin contender result for reproducibility.
