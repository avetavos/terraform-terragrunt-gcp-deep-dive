# Terraform & Terragrunt for GCP — Deep Dive

Bilingual (EN/TH) Terraform + Terragrunt course, GCP edition.

## Harness

`tools/verify-snippets.mjs` proves lesson HCL snippets actually work against
the real `terraform`/`terragrunt` binaries — no cloud credentials exist or
are ever used. Every provider is configured with mock/skip-validation
settings so `init`/`validate`/`fmt`/`test` run fully offline (google cannot
`plan` offline for most resources — see below). This file is byte-identical
across the three sibling courses (`terraform-terragrunt-{aws,azure,gcp}-deep-dive`)
— only `tools/harness.config.json` differs, per cloud.

Pinned, verified-current versions: **Terraform 1.16.4**, **google provider
`hashicorp/google ~> 8.0`** (resolves 8.4.0 at the time of writing — no
version-lag; the constraint already covers current), **Terragrunt 1.1.0**
(CLI redesign: `run --all`, `root.hcl`, `--filter`;
`run-all`/`plan-all`/`apply-all` are removed commands, not just deprecated).

```sh
npm run verify                                  # terraform validate + terragrunt hcl validate, every lesson
node tools/verify-snippets.mjs --test [module/lesson]        # terraform test over .tftest.hcl fences
node tools/verify-snippets.mjs --plan <module>/<lesson>      # terraform plan — reports "not possible offline" cleanly
node tools/verify-snippets.mjs --terragrunt <module>/<lesson> # terragrunt run --all plan, offline, full live tree only
node tools/verify-snippets.mjs --all-hcl        # baseline: every hcl fence standalone as its own main.tf
node tools/verify-snippets.mjs --clean          # remove tools/probe/lessons/**/.terraform + terragrunt caches
node tools/verify-snippets.mjs --clean --clean-cache  # also wipe the shared provider plugin cache (~GBs)
node tools/verify-snippets.mjs --self-test      # harness self-check
```

### Fence convention

A collectible ` ```hcl ` fence's first line is `# <path>`, where `<path>`
ends in `.tf`, `.hcl` (this also covers `.tftest.hcl`), or `.tfvars` — e.g.
`# modules/vpc/main.tf`, `# root.hcl`, `# live/dev/vpc/terragrunt.hcl`,
`# tests/vpc.tftest.hcl`. The path is relative to the LESSON (each lesson
gets its own namespaced directory under `tools/probe/lessons/`), so a lesson
that fences both a raw module and a Terragrunt unit that consumes it gets a
real, coherent multi-file tree. A trailing ` <comment>` after the path is
tolerated (not required). `# @expect-error ...` is a deliberate-error demo
and is skipped. Anything else is a fragment (no path) and is skipped by
default mode.

**Known, accepted limitation:** because the path token allows trailing text
after whitespace, a prose first line that happens to *start* with something
path-shaped is misdetected as a real file containing just that comment —
same documented trade-off as the sibling astro/svelte/nextjs harnesses'
path conventions.

**Baseline note:** most fences in the pre-Phase-3 course use a bare
`# main.tf` / `# providers.tf` first line (no directory). These DO satisfy
the path regex and so ARE collected in default mode, but mostly exercise
single-file validate rather than the multi-file module/live-tree structure
Phase 3 adds. `--all-hcl` instead flattens EVERY hcl fence into its own
standalone `main.tf` — the mode that produced the baseline numbers below.

### Units, generated files, and the `-backend=false` decision

Within a lesson's namespace dir, every directory that directly contains at
least one `*.tf` file is a **terraform unit**; every directory directly
containing `terragrunt.hcl` is a **terragrunt unit**. If `root.hcl` exists
anywhere under the lesson, it's eligible for `terragrunt render` (and, under
`--terragrunt`, `run --all`).

A generated `_harness_providers.tf` is added to a terraform unit only for
whatever it's missing: a `terraform { required_providers { ... } }` pin (if
missing) and/or the mock `provider "google" { project = "mock-project" ...}`
block (if missing). It never adds a `backend` block — this harness always
runs `terraform init -backend=false`, so any `backend "gcs" { ... }` a
lesson's own fence declares is simply never initialized.

`terragrunt hcl validate` / `terragrunt hcl format --check` are recursive
over the whole lesson dir. `terragrunt render --format json` is per-unit and
only attempted when the lesson has a `root.hcl`. `terragrunt run --all` is
never run in default mode — only under `--terragrunt <module>/<lesson>`,
and only for a full live tree (`root.hcl` + ≥2 units, exactly as the deep
review's own probe proved offline with `dependency`+`mock_outputs`).

### `--plan` — google mostly cannot plan offline

`project = "mock-project"` gets a real provider configured, but almost
every real GCP resource type needs the Cloud Resource Manager / a real
project to resolve at plan time; validate-only is the realistic offline
ceiling for most fences. `--plan` always TRIES the plan first (never skips
outright) and pattern-matches the output for known offline-auth/API
failure phrases to print a clean one-line `not possible offline: <reason>`
instead of a raw stack trace.

### `--test`

A `tests/x.tftest.hcl` fence's module root is one directory up; a bare
`.tftest.hcl` fence runs against its own unit dir. The harness adds the same
generated provider pin there if the test file's own `run` blocks don't
already use `mock_provider` — this is the course's real primary offline
proof path for anything beyond `validate` (as the deep review notes: GCS
backend locking is built-in with no separate lock argument, and
`google_project.deletion_policy` defaults to `PREVENT` since provider 6.0 —
neither needs credentials to validate).

### `--all-hcl` baseline (real numbers from a real run)

Every ` ```hcl ` fence in `src/content/docs/en/**` (75 total), flattened to
its own standalone `main.tf`, against `google ~> 8.0`:

```
foundations:                8 pass / 4 fail / 2 fragment
modules:                    3 pass / 6 fail / 9 fragment
multi-environment:          3 pass / 2 fail / 3 fragment
production-and-ecosystem:   3 pass / 1 fail / 5 fragment
state-management:           5 pass / 2 fail / 0 fragment
terragrunt-fundamentals:    1 pass / 0 fail / 7 fragment
variables-and-data-flow:   10 pass / 1 fail / 0 fragment
TOTAL:                     33 pass / 16 fail / 26 fragment (of 75 fences)
```

"fragment" = `terraform init` itself couldn't parse the fence as valid
top-level HCL (expected for a partial snippet, a Terragrunt-only block run
through plain `terraform`, or the prose false-positive documented above).
"fail" = it parsed fine but `terraform validate` found a real schema-level
problem (almost always a fragment referencing a resource/variable declared
in a DIFFERENT fence/lesson) — genuine pre-Phase-3 content gaps for Phase 3
to close, not harness bugs.

### Known, accepted gaps

- **The shared `tools/probe/.plugin-cache` is not safe under concurrent
  writers.** Empirically confirmed while building this harness: running two
  overlapping invocations against the SAME repo (e.g. a killed/leftover
  background run still writing while a fresh one starts) can corrupt the
  cached provider binary, surfacing later as `the cached package ... does
  not match any of the checksums recorded in the dependency lock file` or
  `Failed to read any lines from plugin's stdout` on completely unrelated
  lessons. Fix: `rm -rf tools/probe/.plugin-cache` and re-run. Don't run two
  invocations of this harness against the same repo at once (parallel runs
  across the three DIFFERENT sibling repos are fine — each has its own
  cache).
- **`terraform test` cannot use the shared plugin cache at all** — verified
  empirically: with `TF_PLUGIN_CACHE_DIR` set, `terraform test` fails a
  checksum check that `init`/`validate`/`plan` do not, immediately after a
  clean `init`, apparently because `test` resolves the cache's symlinked
  provider package through a different path than the other commands. `--test`
  and `--self-test` both omit the cache for their `terraform test` calls
  (see `tfEnv(noCache)` in the harness) — this means every `--test` run
  re-downloads the provider fresh into that unit's own `.terraform/providers`,
  which is slower but correct.
- Two different lessons that happen to fence the same relative path are two
  SEPARATE, independent probes — a lesson's own fence set must be
  self-contained to validate cleanly. A lesson whose fences only ever showed
  a fragment of a multi-file example correctly fails validate/hcl-validate
  in default mode; this is a real, reportable content gap, not a harness bug.
- `terraform fmt -check` and `terragrunt render` failures are always
  WARNINGS, never fail `npm run verify` — `validate`/`hcl validate` are the
  hard gates.
