# Agent Notes

benchpress is an **evaluation harness**, not a product core. Keep benchmark-specific churn here; generic capabilities belong in autobrin-flue.

## Design principles

- **Grader is the score.** Never use a contender's self-verdict as the benchmark outcome. Map each benchmark's native grader into `src/oracle/types.ts`.
- **Fairness invariant.** One target per task; identical model, budget, and info level for every contender in a matrix run.
- **Built-in matrix.** Comparisons run in one process (`src/matrix/run.ts`), not separate harness instances per tool.
- **Registries only.** Benchmarks live in `src/benchmarks/registry.ts`; contenders in `src/contenders/registry.ts`. No `if (benchmark === '...')` branching elsewhere.
- **No competing-tool names in source.** Ship `autobrin` + generic `command` runner types only. User configs (gitignored) name external agents.
- **Generated output uncommitted.** `runs/`, `results/`, `engagements/`, `.cache/`, `vendor/` stay gitignored.
- **One-way dependency on autobrin-flue.** Clone/pin at runtime via contender `ref` or `AUTOBRIN_FLUE_REF`. Do not add benchpress references to autobrin-flue.
- **Daytona provisioning lives here for standalone runs.** `bench daytona run` provisions a Daytona sandbox, bootstraps autobrin-flue inside it, and runs engagements via the same HTTP/SSE flow as the app repo. autobrin-flue core stays consume-only; benchpress owns sandbox lifecycle for engagements and benchmark runs outside app.

## Benchmark capability dependencies

Scientific adapters are **stubbed** until autobrin-flue ships the required generic capabilities:

| Benchmark | Required autobrin-flue capability |
| --- | --- |
| `cve-bench` | `webapp` modality + cross-cutting computer-use confirmation |
| `cybergym` | PoC-generation contributor skill + differential patched oracle |
| `bountybench` | `webapp` modality (Exploit — **shipped, implemented**) / detect-only mode (Detect+Patch — [autobrin-flue#182](https://github.com/superagent-ai/autobrin-flue/issues/182), still open) |
| `owasp` | detect-only mode + CWE-label Youden scoring |
| `repo-cve-smoke` | `repo` modality only — **dev-smoke lane**, not for scientific reporting |

Do not implement scientific benchmark bodies until the dependency row is satisfied in autobrin-flue — applied at **task-type** granularity for `bountybench`: its Exploit lane's dependency (`webapp` modality) is satisfied, so `adapter.ts` implements it for real; its Detect/Patch lanes' dependency (detect-only mode) is not, so `score()` throws for those task types instead of a full stub (`setup()`/`listTasks()`/`standUpTarget()` need only already-shipped `repo` modality, so those run for real too). See `src/benchmarks/bountybench/README.md`. CVE-Bench may keep `vendor.lock.json` + `setup.ts` wired; `adapter.ts` stays stub until `webapp`/computer-use land.

## Adding a benchmark

1. Create `src/benchmarks/<id>/adapter.ts` implementing `BenchmarkAdapter` from `src/benchmarks/types.ts`.
2. Register in `src/benchmarks/registry.ts`.
3. Add README under the benchmark subdir.
4. If upstream assets are heavy, use pinned runtime clone + committed lockfile (see `cve-bench/vendor.lock.json`).
5. Add tests under `tests/`.

## Adding a contender

- **autobrin:** `{ "type": "autobrin", "id": "autobrin@<ref>", "ref": "<branch-or-sha>" }` or `{ "path": "/abs/checkout" }` for local trees.
- **command:** `{ "type": "command", "id": "<name>", "command": "<tool> run {repo} --model {model}" }` — stdout may be JSON `ContenderClaim`.

## Git workflow

- Default branch: `main`.
- Run `npm run validate` before commit.
- Keep commits atomic; quote paths with brackets.

## Consumer versioning

- `AUTOBRIN_FLUE_REF` (env) or contender `ref` selects which autobrin-flue branch/SHA to clone. Default: `staging`.
- Resolve and record commit SHA on each autobrin contender result for reproducibility.
