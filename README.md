# benchpress

**N contenders × Y benchmarks** competition harness for security agents. AutoBrin is one contender (consumed as a black box via `flue run engagement`); any other agent plugs in as a config-driven command contender. The **benchmark grader** is the score — never a contender's self-verdict.

## Quick start

```bash
cd ~/Documents/code/benchpress
npm install
npm run validate

# List registered benchmarks
npm run bench -- list

# Compare autobrin-flue staging vs main (dev-smoke lane)
dotenvx run -f ~/.config/secrets/global.env -- npm run bench -- matrix --config config/matrix.example.jsonc
```

## What it does

For each task, benchpress:

1. Stands up **one** target (fairness invariant)
2. Fans the same target out to all contenders with identical model / budget / info level
3. Maps each benchmark's native grader into a normalized objective signal
4. Emits a head-to-head scorecard (TP/FP/FN, Youden, claim-vs-grader gap, cost)

Version-vs-version comparisons (e.g. `autobrin@staging` vs `autobrin@main`) use the same machinery — multiple `autobrin` contenders differing only by `ref` or `path`.

## Contenders

| Type | Purpose |
| --- | --- |
| `autobrin` | Clones [superagent-ai/autobrin-flue](https://github.com/superagent-ai/autobrin-flue) at a branch/SHA (or uses a local path), runs `flue run engagement` |
| `pithos` | Runs the installed [superagent-ai/PITHOS](https://github.com/superagent-ai/PITHOS) CLI (`pithos run`) for a head-to-head vs `autobrin` |
| `command` | Generic external CLI; add your own agent via config without naming it in repo source |

Example: [`config/contenders.example.jsonc`](config/contenders.example.jsonc)

`AUTOBRIN_FLUE_REF` defaults to `staging` when an autobrin contender omits `ref`. benchpress's own default branch is `main`; that is independent of which autobrin-flue branch you pin.

### `autobrin` transport: `local` vs `daytona`

An `autobrin` contender's `transport` field selects where its engagement actually executes:

| `transport` | Behavior |
| --- | --- |
| `local` (default) | Spawns `npx flue run engagement` on this machine. Unchanged from before this option existed. |
| `daytona` | Provisions a Daytona sandbox and runs the engagement inside it via the same launcher `bench daytona run` uses (see below) — required for benchmarks whose modality needs a live computer-use environment. Repo modality only for now. |

`transport: "daytona"` requires `image` or `snapshot` (same meaning as `bench daytona run --image`/`--snapshot`) and accepts the same `visionModel`/`keepSandbox` knobs; `path` (local checkout override) is rejected since there's no local filesystem for the sandbox to read. Provider/Daytona secrets come from the ambient process environment (`dotenvx run -f ... -- ...`), same as every other `bench` command. See [`config/contenders.example.jsonc`](config/contenders.example.jsonc) for the shape and [`examples/daytona-autobrin-contender.ts`](examples/daytona-autobrin-contender.ts) for a runnable example against the declarative bookworm computer-use image.

### PITHOS

benchpress does not install or vendor PITHOS; install it once per machine/sandbox:

```bash
uv tool install git+https://github.com/superagent-ai/PITHOS.git
```

The `pithos` contender shells out to the `pithos` binary on `PATH` (`pithos run <repo-url> --model <model> ...`) and parses `TRIAGE.json` plus `verify/runtime-summary.json` from its results directory into a `ContenderClaim` — PITHOS's default stdout is a human-readable summary, not JSON, so this is a dedicated contender (`src/contenders/pithos.ts`) rather than the generic `command` type. A runtime/source-oracle `confirmed_runtime` verdict is treated as `confirmed`; absent runtime evidence (the common case without live-app execution), the static triage verdict is used instead. `costUsd`/`costStatus` are always `null`/`"unavailable"` — PITHOS does not report spend.

Config fields (`PithosContenderConfig`):

| Field | Default | Notes |
| --- | --- | --- |
| `provider` | PITHOS's own default (`azure-openai-responses`) or `PITHOS_PROVIDER` env | Pi provider id, e.g. `deepseek`, `azure-openai-responses` |
| `sandboxMode` | `"local"` | `"local"` trusts the outer environment (no Docker) like this harness's own `autobrin` contender; `"docker"` uses PITHOS's pinned Pi CLI image but requires a local Docker daemon |
| `maxFindings` | PITHOS's own default (12) | Bounds candidate-finding breadth; PITHOS's static pipeline runs ~15 sequential stages regardless of this value, so it bounds per-finding cost/time, not pipeline depth |

Caveats found by running the real CLI (not guessed):

- **`repo` must be a URL, not an `owner/repo` slug.** `TargetHandle.repo` (e.g. `"apostrophecms/sanitize-html"`) is converted to `https://github.com/<repo>` before invoking PITHOS; PITHOS's own resolver only recognizes `github.com` URLs (or SSH `git@github.com:...`) and otherwise treats the argument as a local path.
- **`sandboxMode: "local"` has no Pi version pin.** PITHOS's Docker mode runs a pinned `@earendil-works/pi-coding-agent` version baked into its agent image; local mode runs whatever `pi` binary is already on `PATH` (`PI_SKIP_VERSION_CHECK=1` is set internally). A `pi` CLI older than PITHOS's pin can fail with `Unknown options: --session-id, --exclude-tools`. Verified working: `@earendil-works/pi-coding-agent@0.78.1` (PITHOS's own pin at the time of writing, in `pithos/agent_image.py`).
- **Not every Azure OpenAI deployment supports Pi's `azure-openai-responses` provider.** A deployment PITHOS/Pi doesn't recognize can 400 with `Encrypted content is not supported with this model` (observed with an Azure-hosted Kimi K2.6 deployment). `deepseek`/`deepseek-chat` is a reliable fallback for smoke-testing when this happens.
- **`controls.model` is passed through as PITHOS's literal `--model` value**, exactly like the generic `command` contender's `{model}` substitution — it is not translated from autobrin/pi-ai's `provider/model` convention (e.g. `kimi-azure/kimi-k2.6`). A shared matrix run needs a `controls.model` value each contender's own CLI can resolve; that is not always the same literal string across tools with different provider/model naming conventions, so `pithos` is not included in [`config/matrix.example.jsonc`](config/matrix.example.jsonc) to avoid implying one always exists.

## Benchmarks

Registered in [`src/benchmarks/registry.ts`](src/benchmarks/registry.ts):

| ID | Lane | Status | Blocked on (autobrin-flue capability) |
| --- | --- | --- | --- |
| `repo-cve-smoke` | dev-smoke | **Runnable** | `repo` modality only — for harness/version testing, not scientific reporting |
| `cve-bench` | scientific | **Runnable** (2/40 tasks verified) | — (unblocked; see [`src/benchmarks/cve-bench/README.md`](src/benchmarks/cve-bench/README.md)) |
| `cybergym` | scientific | **Partial** (`setup`/`listTasks`/`standUpTarget` real; `score()` blocked) | PoC-generation skill + differential patched oracle |
| `bountybench` | scientific | Stub | `webapp` + computer-use (exploit) / detect-only mode (detect) |
| `owasp` | scientific | **Partial** | `setup`/`listTasks`/`standUpTarget` implemented; `score()` blocked on detect-only mode ([autobrin-flue#182](https://github.com/superagent-ai/autobrin-flue/issues/182), unmerged) |

Remaining scientific benchmarks (`bountybench`) stay stubbed until the corresponding capabilities land in autobrin-flue. CyberGym is a documented exception (see [superagent-ai/benchpress#16](https://github.com/superagent-ai/benchpress/issues/16)): task vendoring, real task listing, and dockerized target stand-up don't need the blocked capabilities, so they're implemented for real against a representative 5-task subset; only `score()` throws until [autobrin-flue#180](https://github.com/superagent-ai/autobrin-flue/issues/180)/[#181](https://github.com/superagent-ai/autobrin-flue/issues/181) land — see [`src/benchmarks/cybergym/README.md`](src/benchmarks/cybergym/README.md). `owasp` goes one step further — it vendors OWASP Benchmark for Java v1.2 and implements real CSV-based task listing today, with only the grader (`score()`) waiting on autobrin-flue#182. See [`src/benchmarks/owasp/README.md`](src/benchmarks/owasp/README.md).

### Scientific: `cve-bench`

Stands up real CVE-Bench Docker target stacks (pre-built `cvebench/*` images, pulled — never
built locally) and scores against CVE-Bench's own live evaluator HTTP endpoint, not AutoBrin's
self-verdict. Requires a working `docker`/`docker compose` on the host. See
[`src/benchmarks/cve-bench/README.md`](src/benchmarks/cve-bench/README.md) for the metadata
mapping, verified task scope, and how to scale up to the full 40-task set:

```bash
dotenvx run -f ~/.config/secrets/global.env -- npm run bench -- matrix --config config/matrix.cve-bench.example.jsonc
```

### Dev smoke: `repo-cve-smoke`

Small repo-modality lane scored by **fix-commit overlap** (external oracle, not AutoBrin self-verdict). Pin vulnerable/fix SHAs in [`src/benchmarks/repo-cve-smoke/tasks.jsonc`](src/benchmarks/repo-cve-smoke/tasks.jsonc) before relying on results.

## CLI

```bash
bench list
bench run <benchmark> --contender <id> --model <model-id> [--flue-ref staging] [--task <id>]
  # pithos contender: [--provider <id>] [--sandbox-mode docker|local] [--max-findings <n>]
bench matrix --config config/matrix.example.jsonc
bench daytona run --ref staging --image <cu-image> --vision-model <model> --payload '<json>' [--snapshot <name>] [--keep-sandbox]
bench daytona doctor [--image <cu-image>] [--snapshot <name>] [--keep-sandbox]
```

### Daytona launcher (`bench daytona`)

Standalone provisioning for autobrin-flue engagements **inside** a Daytona sandbox (topology A: agent-in-sandbox), mirroring the app repo's HTTP run flow. This is the same launcher (`runDaytonaEngagement` in [`src/daytona/launcher.ts`](src/daytona/launcher.ts)) an `autobrin` contender uses under `transport: "daytona"` (see [Contenders](#contenders) above) — `bench daytona run` and the contender path share sandbox lifecycle, bootstrap, and cleanup, they just differ in how the engagement's result gets consumed afterward.

1. `daytona.create` from a computer-use-enabled `--image` or `--snapshot`
2. Clone/build autobrin-flue at `--ref` (`staging` or `main` branch pins only)
3. Ensure computer-use assets and inject env (`AUTOBRIN_COMPUTER_USE=daytona`, `CUA_SCREENSHOT_VISION_MODEL`, provider keys)
4. Start `dist/server.mjs` in the sandbox and `POST /workflows/engagement` to admit the run (Flue returns `{"runId"}` immediately; this is an admission receipt, not a live stream)
5. Wait for the run to finish by polling its Durable Streams run-event feed (`GET /runs/:runId`) and the `result.json` checkpoint AutoBrin writes to disk, then tear down the sandbox (unless `--keep-sandbox`)

`bench daytona doctor` creates a sandbox and checks Toolbox loopback reachability (`http://127.0.0.1:2280/computeruse/status`) plus screenshot capture (`/computeruse/screenshot` returns a non-empty image) — that combination is the real signal that computer-use is usable. `cua-driver` CLI presence/daemon status is reported for visibility but is **informational only** and does not fail the doctor: some computer-use-capable images don't install `cua-driver` at all, and others install it without a running daemon or a `start` subcommand. See [superagent-ai/benchpress#4](https://github.com/superagent-ai/benchpress/issues/4).

### Sandbox requirements

`bench daytona run`/`doctor` provision a real Daytona sandbox, so the image/snapshot you point them at has to satisfy a few constraints that fail hard rather than degrading gracefully:

- **Node.js 22+.** autobrin-flue's `staging` and `main` branches need it — `staging` is on Flue `1.0.0-beta.8`, whose persistence layer uses the built-in `node:sqlite` module, and autobrin-flue's own `CHANGELOG.md` states "CI Node minimum is `22.19.0`". Generic Daytona snapshots (e.g. `daytona-large`) commonly ship Node 20 (`v20.19.2` observed), which fails like this once the engagement server starts — bootstrap itself (clone/`npm install`/`npm run build`) can succeed first and still hit this at startup:

  ```text
  Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
  Node.js v20.19.2
  ```

- **No published "app-parity" snapshot.** superagent-ai/app's computer-use sandbox is a *declarative image*, not a named Daytona snapshot: `node:22-bookworm` plus an XFCE/Xvfb desktop, a browser, `gh`, and the `cua-driver` CLI (installed from [`trycua/cua`](https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)). No equivalent snapshot is published for benchpress to reference by name today. `--image`/`--snapshot` are plain string flags, but the lower-level `createSandbox()` in [`src/daytona/client.ts`](src/daytona/client.ts) accepts a `string | Image` directly (`CreateSandboxFromImageParams`), so you can build the same image inline and create the sandbox programmatically instead of going through those flags. [`examples/node22-bookworm-computer-use-image.ts`](examples/node22-bookworm-computer-use-image.ts) does exactly this:

  ```bash
  dotenvx run -f ~/.config/secrets/global.env -- npx tsx examples/node22-bookworm-computer-use-image.ts
  ```

  Generic `daytona-large` is a perfectly valid `--snapshot` for computer-use itself (see the doctor description above) — it just also needs a Node 22+ runtime for autobrin-flue, same as any other image.

- **`computerUse` is sandbox env, not engagement payload.** `normalizeEngagementPayload` ([`src/daytona/payload.ts`](src/daytona/payload.ts)) has no `computerUse` field — don't put it in `--payload` JSON. Computer-use routing is controlled by `AUTOBRIN_COMPUTER_USE=daytona` and `AUTOBRIN_COMPUTER_USE_BASE_URL`, which `buildSandboxEnv` ([`src/daytona/env.ts`](src/daytona/env.ts)) injects into the **sandbox environment** (defaults: `daytona`, `http://127.0.0.1:2280`), not the payload.

- **`GH_TOKEN` needs read access to `superagent-ai/autobrin-flue`.** See [Secrets](#secrets) below.

Note: `GET /runs/:runId` only returns run events once the `engagement` workflow in autobrin-flue exports a Flue `runs` HTTP handler (see [superagent-ai/autobrin-flue#169](https://github.com/superagent-ai/autobrin-flue/issues/169)). Until then, the launcher logs a one-time notice and relies solely on the `result.json` checkpoint to detect completion.

#### Repo-modality smoke test

Requires `DAYTONA_API_KEY`, a computer-use image, and provider keys in your operator env file:

```bash
dotenvx run -f ~/.config/secrets/global.env -- npm run bench -- daytona run \
  --ref staging \
  --image <daytona-computer-use-image-or-snapshot> \
  --vision-model kimi-k2.6 \
  --payload '{"modality":"repo","repo":"https://github.com/<owner>/<repo>.git","sha":"<vulnerable-sha>","contributors":3,"model":"kimi-azure/kimi-k2.6"}'
```

Expect: sandbox created → autobrin-flue bootstrapped → engagement runs with computer-use env active → run events/checkpoint polled until completion → sandbox deleted. No dependency on the app repo.

Webapp payloads are wired (`modality: "webapp"`, `target.url`) — autobrin-flue#157/#158 shipped, and
the **local `npx` contender path** is verified end-to-end against real CVE-Bench targets (see
`cve-bench` above). The **Daytona path specifically** (this launcher) still has no automated
webapp-modality smoke test; `src/daytona/payload.ts`'s `WebappEngagementPayload`/`buildWebappPayload`
also only carry `target.url` today, one field short of the full `WebappTargetSchema` contract
`src/contenders/types.ts`'s `WebappTargetMetadata` already mirrors for the local path (username,
password, role, outbound/proof-upload URLs) — worth widening when
[superagent-ai/benchpress#11](https://github.com/superagent-ai/benchpress/issues/11) lands.

## Output (gitignored)

- `runs/` — matrix metadata
- `results/` — scorecards and contender logs
- `engagements/` — autobrin engagement workspaces
- `.cache/` — cloned autobrin-flue checkouts and benchmark vendors

## Secrets

Use your operator env file (never commit repo `.env` files):

```bash
dotenvx run -f ~/.config/secrets/global.env -- npm run bench -- matrix --config config/matrix.example.jsonc
```

Agent keys (`AZURE_OPENAI_*`, etc.) pass through to autobrin-flue engagements. Full list and defaults: [`.env.example`](.env.example).

| Variable | Used by | Notes |
| --- | --- | --- |
| `DAYTONA_API_KEY` / `DAYTONA_JWT_TOKEN` + `DAYTONA_ORGANIZATION_ID` | `bench daytona run`/`doctor` | One auth mode required; see `getDaytonaClientConfig` in [`src/daytona/client.ts`](src/daytona/client.ts) |
| `DAYTONA_API_URL`, `DAYTONA_TARGET` | `bench daytona run`/`doctor` | Optional Daytona client overrides |
| `AUTOBRIN_FLUE_REF` | autobrin contender / `bench daytona run` | `staging` (default) or `main` branch pin only |
| `AUTOBRIN_FLUE_REPOSITORY` | `bench daytona run` | Defaults to `https://github.com/superagent-ai/autobrin-flue.git` |
| `AUTOBRIN_FLUE_GITHUB_TOKEN` / `GH_TOKEN` | `bench daytona run` (clones `autobrin-flue` inside the sandbox) | **Must have read access to the private `superagent-ai/autobrin-flue` repo.** A token without that scope reaches the sandbox fine but the clone fails with HTTP 403 |
| `AUTOBRIN_COMPUTER_USE` | `bench daytona run` — sandbox env, **not** the `--payload` JSON | Defaults to `daytona`; routes AutoBrin's consume-only computer-use confirmation |
| `AUTOBRIN_COMPUTER_USE_BASE_URL` | `bench daytona run` — sandbox env | Defaults to `http://127.0.0.1:2280` (Toolbox loopback) |
| `CUA_SCREENSHOT_VISION_MODEL` | `bench daytona run` | Vision sidecar model for screenshot-to-text |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `FIRECRAWL_API_KEY` | autobrin-flue engagements | Passed through to the sandbox |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | autobrin-flue engagements | Optional observability export |

## Relationship to autobrin-flue

benchpress **consumes** autobrin-flue at runtime (branch pin via `AUTOBRIN_FLUE_REF` / contender `ref`). autobrin-flue is not modified and does not reference benchpress. Capabilities (modalities, computer-use, detect-only, etc.) land in autobrin-flue via separate PRs; adapters here are filled in once those exist.
