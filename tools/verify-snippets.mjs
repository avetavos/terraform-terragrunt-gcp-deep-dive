#!/usr/bin/env node
// Snippet-verification harness for the Terraform/Terragrunt Deep Dive courses
// (aws / azure / gcp siblings — this file is byte-identical across all
// three; only tools/harness.config.json differs, see below).
//
// Unlike the framework-course harnesses (astro/svelte/react/nextjs), this
// course teaches infrastructure-as-code, not application code — there is no
// dev server or type-checker to run a fence through. The only real proof a
// Terraform/Terragrunt snippet is correct is to write it to disk as a real
// `.tf`/`.hcl` file and run the REAL binaries against it: `terraform
// init`/`validate`/`fmt`/`test`/`plan` and `terragrunt hcl validate`/`render`/
// `run --all`. No cloud credentials exist or are ever used — every provider
// is configured with mock/skip-validation settings so `init`+`validate`
// (and, for aws, `plan`) work fully offline. See README's "Harness" section
// for the pinned provider versions and the full list of documented design
// decisions referenced by comments below.
//
// Fence convention (spec §1/§5): an `hcl` fence whose FIRST line is
// `# <path>` where <path> ends in `.tf`, `.hcl` (this also matches
// `.tftest.hcl`), or `.tfvars` is a real file, collected at that path
// RELATIVE TO ITS LESSON (e.g. `# modules/vpc/main.tf`, `# root.hcl`,
// `# live/dev/vpc/terragrunt.hcl`, `# tests/vpc.tftest.hcl`). The path may
// carry a trailing ` <comment>` after whitespace (tolerated, not required —
// same convention as the astro/svelte/nextjs sibling harnesses). A first
// line containing `@expect-error` is a deliberate-error demo and is skipped
// (the lesson prose carries the real error). Anything else is a fragment
// (no path) and is skipped by default mode — see `--all-hcl` below.
//
// KNOWN LIMITATION (documented, not silently "fixed"): because the path
// token is matched greedily against `[\w.\-]+(?:/[\w.\-]+)*\.<ext>` and any
// trailing text after whitespace is tolerated as a comment, a PROSE first
// line that happens to start with something matching the path shape (e.g.
// `# vpc/terragrunt.hcl and rds/terragrunt.hcl both use dependency blocks`)
// is misdetected as a real, collectible file at `vpc/terragrunt.hcl`. This
// is the same trade-off the astro model harness documents for its own path
// convention. Phase 3 authors should avoid starting an explanatory first-line
// comment with a token that parses as a real path.
//
// BASELINE (pre-Phase-3): most existing fences in this course use a bare
// `# main.tf` / `# providers.tf` style first line with NO directory prefix.
// These DO satisfy the path regex (a bare filename is a valid path) and so
// ARE collected as one-file "lessons" in default mode today — this mostly
// exercises single-file validate, not the multi-file module/live-tree
// structure Phase 3 will add. `--all-hcl` (see below) instead treats EVERY
// hcl fence, regardless of its first line, as a standalone `main.tf` — this
// is the mode used to produce the baseline pass/fail counts in the README
// and the task's final report.
//
// Namespacing: a collected fence lands at
// `tools/probe/lessons/<module>__<lesson>/<path>` — the path is used exactly
// as written (including any subdirectories), so a lesson that includes both
// `modules/vpc/main.tf` and `live/dev/vpc/terragrunt.hcl` fences gets a real,
// coherent directory tree with both a raw module and a Terragrunt live unit
// referencing it, under the one lesson namespace.
//
// Units: within a lesson's namespace dir, every directory that directly
// contains at least one `*.tf` file (excluding the harness's own generated
// `_harness_providers.tf` when nothing else is present) is a "terraform
// unit" — `terraform init`/`validate`/`fmt` run there. Every directory that
// directly contains a `terragrunt.hcl` file is a "terragrunt unit". If any
// `root.hcl` exists anywhere under the lesson dir, the lesson is considered
// to have a Terragrunt "root" and is eligible for `terragrunt render` (and,
// under `--terragrunt`, `run --all`).
//
// Generated `_harness_providers.tf`: written into a terraform unit only for
// whatever it is missing — a `terraform { required_providers { ... } }`
// pin (added if no unit `.tf` file has a top-level `terraform {` block) and/or
// a mock `provider "<name>" {}` block (added if none of the unit's `.tf`
// files declares one for this course's cloud). Never adds a `backend` block:
// this harness ALWAYS runs `terraform init -backend=false`, so any backend
// block a lesson's own fence declares (`backend "s3"`, `"azurerm"`, `"gcs"`)
// is simply never initialized — this is the documented resolution to the
// spec's open "-backend=false vs backend-config" question. `terraform test`
// reuses the same generation for the module directory under test.
//
// Terragrunt: `terragrunt hcl validate`/`terragrunt hcl format --check` are
// recursive over a whole lesson dir (confirmed via `terragrunt hcl --help`
// on the installed 1.1.0: "Recursively find ... HCL files and
// validate/rewrite them"). `terragrunt render --format json` is per-UNIT
// (one `terragrunt.hcl` at a time, via `--working-dir`) and only attempted
// when the lesson has a `root.hcl` (an isolated `terragrunt.hcl` with no
// root can't resolve `find_in_parent_folders("root.hcl")`). `run --all` is
// NEVER run in default mode (spec: "ห้าม run --all default") — only under
// the explicit `--terragrunt <module>/<lesson>` flag.
//
// `--plan`: aws mock credentials (`skip_credentials_validation` etc.) let a
// real `terraform plan` proceed for most resource types with no network
// access to AWS at all. azurerm/google generally cannot: azurerm's plan
// needs a real authorizer (Azure CLI/SDK auth chain) and google's provider
// needs to resolve project-level API access for most resources. This harness
// always TRIES `terraform plan` (never skips outright — the spec asks for a
// clean report, not a guess) and pattern-matches the output for known
// offline-auth-failure phrases to print a one-line "not possible offline:
// <reason>" instead of a raw stack trace; anything else is treated as a
// real plan result and its tail is printed.
//
// TF_PLUGIN_CACHE_DIR: shared at `tools/probe/.plugin-cache` so the
// provider binary (aws 6.66.0 / azurerm 5.7.0 / google 8.4.0, per
// harness.config.json) downloads from the public registry exactly ONCE per
// machine, no matter how many lesson units get `terraform init`ed. No other
// network access is used anywhere in this harness.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync, globSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PROBE_DIR = path.join(REPO_ROOT, 'tools/probe');
const LESSONS_DIR = path.join(PROBE_DIR, 'lessons');
const DOCS_EN = path.join(REPO_ROOT, 'src/content/docs/en');
const PLUGIN_CACHE_DIR = path.join(PROBE_DIR, '.plugin-cache');
const CONFIG_PATH = path.join(REPO_ROOT, 'tools/harness.config.json');

const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
// { cloud, providerLabel, providerSource, providerVersion, requiredVersion,
//   mockProviderBlock, planOfflineHints: [substrings], testCanPlanOffline }

const HCL_LANG = 'hcl';

// ---------------------------------------------------------------------------
// String/bracket scanning helpers (ported verbatim from
// astro-deep-dive/tools/verify-snippets.mjs, itself ported from this
// course's own tools/check-parity.mjs) — keeps `export const quiz... = [...]`
// arrays and `<SpotTheBug code={\`...\`}>` props from confusing the fence
// regex when a quiz option string happens to contain literal ``` text.
// ---------------------------------------------------------------------------

function parseStringAt(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      j++;
      break;
    }
    j++;
  }
  return { end: j };
}

function scanBalanced(text, start, open, close) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = parseStringAt(text, i).end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) depth--;
    i++;
  }
  return i;
}

function findExcludedRanges(src) {
  const ranges = [];
  {
    const re = /export\s+const\s+\w+\s*=\s*\[/g;
    let m;
    while ((m = re.exec(src))) {
      const end = scanBalanced(src, re.lastIndex, '[', ']');
      ranges.push([m.index, end]);
      re.lastIndex = end;
    }
  }
  {
    const re = /<SpotTheBug\s+code=\{\s*`/g;
    let m;
    while ((m = re.exec(src))) {
      const backtickIdx = m.index + m[0].length - 1;
      const { end } = parseStringAt(src, backtickIdx);
      ranges.push([m.index, end]);
      re.lastIndex = end;
    }
  }
  return ranges;
}

function stripExcluded(src, ranges) {
  if (!ranges.length) return src;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    out += src.slice(cursor, start);
    out += src.slice(start, end).replace(/[^\n]/g, '');
    cursor = end;
  }
  out += src.slice(cursor);
  return out;
}

function countNewlinesBefore(s, upto) {
  let n = 0;
  for (let i = 0; i < upto; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// Path token: relative, no leading '/', no '..' segment (enforced in code,
// not the regex — a regex that also rejected '..' inline would be far less
// readable). Any characters that are valid across `.tf`/`.hcl`/`.tfvars`
// filenames, one or more '/'-separated segments.
const HCL_TOKEN = String.raw`[\w.\-]+(?:\/[\w.\-]+)*\.(?:tftest\.hcl|hcl|tf|tfvars)`;
const HCL_PATH_RE = new RegExp(`^# (${HCL_TOKEN})(?:\\s+\\S.*)?$`);

function isSafeRelPath(p) {
  if (p.startsWith('/')) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '.');
}

// Collect every ```hcl fence in one MDX file's source.
// Returns [{ fenceNum, line, category, path?, body? }], fenceNum is 1-based
// over ALL real fences (any language) in document order — same convention
// as the sibling harnesses, so a report can say "fence #7" unambiguously.
function collectFences(rawSrc) {
  const src = stripExcluded(rawSrc, findExcludedRanges(rawSrc));
  const fenceRe = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
  const results = [];
  let fenceNum = 0;
  let m;
  while ((m = fenceRe.exec(src))) {
    fenceNum++;
    const lang = m[1];
    if (lang !== HCL_LANG) continue;
    const body = m[2];
    const line = countNewlinesBefore(src, m.index) + 1;
    const firstLine = body.split('\n', 1)[0].trim();

    if (firstLine.includes('@expect-error')) {
      results.push({ fenceNum, line, category: 'expect-error' });
      continue;
    }
    const pm = HCL_PATH_RE.exec(firstLine);
    if (pm && isSafeRelPath(pm[1])) {
      results.push({ fenceNum, line, category: 'collected', path: pm[1], body });
    } else {
      results.push({ fenceNum, line, category: 'skipped-no-path', body });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Lesson discovery
// ---------------------------------------------------------------------------

function discoverLessons() {
  const rels = globSync('**/*.mdx', { cwd: DOCS_EN }).sort();
  return rels.map((rel) => {
    const posixRel = rel.replaceAll('\\', '/');
    return {
      absPath: path.join(DOCS_EN, rel),
      mdxRelPath: `src/content/docs/en/${posixRel}`,
      module: posixRel.split('/')[0],
      lesson: path.basename(posixRel, '.mdx'),
      namespace: `${posixRel.split('/')[0]}__${path.basename(posixRel, '.mdx')}`,
    };
  });
}

function findLesson(target) {
  const parts = target.split('/');
  const lesson = parts.pop();
  const module = parts.join('/');
  return discoverLessons().find((d) => d.module === module && d.lesson === lesson);
}

// ---------------------------------------------------------------------------
// Probe tree construction
// ---------------------------------------------------------------------------

function ensurePluginCache() {
  mkdirSync(PLUGIN_CACHE_DIR, { recursive: true });
}

// fenceMap: namespace -> { mdxRelPath, module, lesson, fences: Map(relPath -> fenceNum) }
function buildLessonsTree(descriptors) {
  rmSync(LESSONS_DIR, { recursive: true, force: true });
  mkdirSync(LESSONS_DIR, { recursive: true });

  const fenceMap = new Map();
  const stats = new Map(); // module -> { collected, skippedNoPath, expectError, tests }

  for (const d of descriptors) {
    const counters = stats.get(d.module) ?? { collected: 0, skippedNoPath: 0, expectError: 0, tests: 0 };
    stats.set(d.module, counters);

    const nsFences = new Map();
    const src = readFileSync(d.absPath, 'utf8');
    for (const f of collectFences(src)) {
      if (f.category === 'collected') {
        counters.collected++;
        if (f.path.endsWith('.tftest.hcl')) counters.tests++;
        nsFences.set(f.path, f.fenceNum);
        const destAbs = path.join(LESSONS_DIR, d.namespace, f.path);
        mkdirSync(path.dirname(destAbs), { recursive: true });
        writeFileSync(destAbs, f.body);
      } else if (f.category === 'skipped-no-path') {
        counters.skippedNoPath++;
      } else if (f.category === 'expect-error') {
        counters.expectError++;
      }
    }
    fenceMap.set(d.namespace, { mdxRelPath: d.mdxRelPath, module: d.module, lesson: d.lesson, fences: nsFences });
  }

  return { fenceMap, stats };
}

function printStats(stats) {
  console.log('\nPer-module fence summary (collected / skipped-no-path / expect-error / tests):');
  const totals = { collected: 0, skippedNoPath: 0, expectError: 0, tests: 0 };
  for (const [module, c] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${module}: ${c.collected} / ${c.skippedNoPath} / ${c.expectError} / ${c.tests}`);
    for (const k of Object.keys(totals)) totals[k] += c[k];
  }
  console.log(`  TOTAL: ${totals.collected} / ${totals.skippedNoPath} / ${totals.expectError} / ${totals.tests}`);
}

// ---------------------------------------------------------------------------
// Unit discovery inside a lesson's namespace dir
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  const st = existsSync(dir) ? statSync(dir) : null;
  if (!st || !st.isDirectory()) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    out.push(d);
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  return out;
}

// { terraformUnits: [absDir...], terragruntUnits: [absDir...], hasRoot: bool }
function discoverUnits(lessonDir) {
  const dirs = walk(lessonDir);
  const terraformUnits = [];
  const terragruntUnits = [];
  let hasRoot = false;
  for (const d of dirs) {
    const entries = existsSync(d) ? readdirSync(d) : [];
    if (entries.some((f) => f.endsWith('.tf') && f !== '_harness_providers.tf')) terraformUnits.push(d);
    if (entries.includes('terragrunt.hcl')) terragruntUnits.push(d);
    if (entries.includes('root.hcl')) hasRoot = true;
  }
  return { terraformUnits, terragruntUnits, hasRoot };
}

// ---------------------------------------------------------------------------
// Harness-generated provider pin, added only for what a unit is missing.
// ---------------------------------------------------------------------------

function ensureHarnessProviders(unitDir) {
  const tfFiles = readdirSync(unitDir).filter((f) => f.endsWith('.tf'));
  let combined = '';
  for (const f of tfFiles) combined += readFileSync(path.join(unitDir, f), 'utf8') + '\n';

  const hasTerraformBlock = /\bterraform\s*\{/.test(combined);
  const providerBlockRe = new RegExp(`\\bprovider\\s+"${CONFIG.providerLabel}"\\s*\\{`);
  const hasProviderBlock = providerBlockRe.test(combined);

  if (hasTerraformBlock && hasProviderBlock) {
    rmSync(path.join(unitDir, '_harness_providers.tf'), { force: true });
    return;
  }

  let out = '// Generated by tools/verify-snippets.mjs — safe to regenerate, do not hand-edit.\n';
  if (!hasTerraformBlock) {
    out += `terraform {\n  required_version = "${CONFIG.requiredVersion}"\n  required_providers {\n    ${CONFIG.providerLabel} = {\n      source  = "${CONFIG.providerSource}"\n      version = "${CONFIG.providerVersion}"\n    }\n  }\n}\n`;
  }
  if (!hasProviderBlock) {
    out += CONFIG.mockProviderBlock;
  }
  writeFileSync(path.join(unitDir, '_harness_providers.tf'), out);
}

// ---------------------------------------------------------------------------
// terraform init / validate / fmt for one unit
// ---------------------------------------------------------------------------

// `noCache: true` omits TF_PLUGIN_CACHE_DIR — REQUIRED for `terraform test`.
// Empirically verified (not documented anywhere we could find): with the
// plugin cache dir set, Terraform links `.terraform/providers/.../<os_arch>`
// as a SYMLINK into the shared cache for `init`/`validate`/`plan`, which is
// fine for those commands, but `terraform test` recomputes the provider
// package's checksum through a different path that does not resolve the
// symlink the same way, and fails immediately with "the cached package ...
// does not match any of the checksums recorded in the dependency lock file"
// even right after a clean `init`. Skipping the shared cache for `--test`
// only (accepting one full re-download per unique provider version there)
// avoids it; `init`/`validate`/`plan`/`terragrunt` keep using the shared
// cache as normal.
function tfEnv(noCache = false) {
  const env = { ...process.env, TF_IN_AUTOMATION: '1' };
  if (!noCache) env.TF_PLUGIN_CACHE_DIR = PLUGIN_CACHE_DIR;
  return env;
}

function runInit(unitDir, { extraArgs = [], noCache = false } = {}) {
  return spawnSync('terraform', ['init', '-backend=false', '-input=false', '-no-color', ...extraArgs], {
    cwd: unitDir,
    encoding: 'utf8',
    env: tfEnv(noCache),
  });
}

function runValidate(unitDir) {
  return spawnSync('terraform', ['validate', '-json', '-no-color'], { cwd: unitDir, encoding: 'utf8', env: tfEnv() });
}

function runFmtCheck(unitDir) {
  return spawnSync('terraform', ['fmt', '-check', '-diff', '-no-color'], { cwd: unitDir, encoding: 'utf8', env: tfEnv() });
}

function mapDiagnostic(fenceMap, namespace, filename) {
  const info = fenceMap.get(namespace);
  if (!info) return null;
  const norm = filename.replaceAll('\\', '/');
  const fenceNum = info.fences.get(norm);
  if (fenceNum == null) return null; // e.g. points into generated _harness_providers.tf
  return { mdxRelPath: info.mdxRelPath, relPath: norm, fenceNum };
}

function namespaceOf(unitDir) {
  const rel = path.relative(LESSONS_DIR, unitDir).replaceAll('\\', '/');
  return rel.split('/')[0];
}

function unitRelPath(unitDir) {
  const ns = namespaceOf(unitDir);
  return path.relative(path.join(LESSONS_DIR, ns), unitDir).replaceAll('\\', '/');
}

// ---------------------------------------------------------------------------
// Default (check) mode
// ---------------------------------------------------------------------------

function runCheckMode() {
  ensurePluginCache();
  const descriptors = discoverLessons();
  const { fenceMap, stats } = buildLessonsTree(descriptors);

  const diagnostics = []; // { severity, where, message }
  const warnings = [];

  for (const namespace of fenceMap.keys()) {
    const lessonDir = path.join(LESSONS_DIR, namespace);
    const { terraformUnits, terragruntUnits, hasRoot } = discoverUnits(lessonDir);

    for (const unitDir of terraformUnits) {
      ensureHarnessProviders(unitDir);
      const init = runInit(unitDir);
      if (init.status !== 0) {
        diagnostics.push({
          severity: 'error',
          where: `${fenceMap.get(namespace).mdxRelPath} (unit ${unitRelPath(unitDir)})`,
          message: `terraform init failed:\n${(init.stdout ?? '') + (init.stderr ?? '')}`.trim(),
        });
        continue;
      }
      const val = runValidate(unitDir);
      let parsed;
      try {
        parsed = JSON.parse(val.stdout);
      } catch {
        diagnostics.push({
          severity: 'error',
          where: `${fenceMap.get(namespace).mdxRelPath} (unit ${unitRelPath(unitDir)})`,
          message: `terraform validate produced no parseable JSON:\n${(val.stdout ?? '') + (val.stderr ?? '')}`.trim(),
        });
        continue;
      }
      for (const d of parsed.diagnostics ?? []) {
        const mapped = mapDiagnostic(fenceMap, namespace, d.range?.filename ?? '');
        const where = mapped
          ? `${mapped.mdxRelPath}:fence #${mapped.fenceNum}`
          : `${fenceMap.get(namespace).mdxRelPath} (unit ${unitRelPath(unitDir)}, ${d.range?.filename})`;
        const entry = { severity: d.severity, where, message: `${d.summary}: ${d.detail}` };
        if (d.severity === 'error') diagnostics.push(entry);
        else warnings.push(entry);
      }

      const fmt = runFmtCheck(unitDir);
      if (fmt.status !== 0 && fmt.status !== null) {
        warnings.push({
          severity: 'warning',
          where: `${fenceMap.get(namespace).mdxRelPath} (unit ${unitRelPath(unitDir)})`,
          message: `terraform fmt -check: not canonically formatted\n${(fmt.stdout ?? '').trim()}`,
        });
      }
    }

    if (terragruntUnits.length) {
      const hv = spawnSync('terragrunt', ['hcl', 'validate', '--working-dir', lessonDir, '--non-interactive', '--no-color'], {
        encoding: 'utf8',
      });
      if (hv.status !== 0) {
        diagnostics.push({
          severity: 'error',
          where: `${fenceMap.get(namespace).mdxRelPath} (terragrunt tree)`,
          message: `terragrunt hcl validate:\n${(hv.stdout ?? '') + (hv.stderr ?? '')}`.trim(),
        });
      }
      const hf = spawnSync(
        'terragrunt',
        ['hcl', 'format', '--check', '--working-dir', lessonDir, '--non-interactive', '--no-color'],
        { encoding: 'utf8' },
      );
      if (hf.status !== 0) {
        warnings.push({
          severity: 'warning',
          where: `${fenceMap.get(namespace).mdxRelPath} (terragrunt tree)`,
          message: `terragrunt hcl format --check: not canonically formatted\n${(hf.stdout ?? '').trim()}`,
        });
      }

      if (hasRoot) {
        for (const unitDir of terragruntUnits) {
          const rd = spawnSync(
            'terragrunt',
            ['render', '--format', 'json', '--working-dir', unitDir, '--non-interactive', '--no-color'],
            { encoding: 'utf8', env: tfEnv() },
          );
          if (rd.status !== 0) {
            warnings.push({
              severity: 'warning',
              where: `${fenceMap.get(namespace).mdxRelPath} (unit ${unitRelPath(unitDir)})`,
              message: `terragrunt render: ${(rd.stderr ?? rd.stdout ?? '').trim().split('\n').slice(0, 4).join(' / ')}`,
            });
          }
        }
      }
    }
  }

  console.log(`\n${diagnostics.length} error(s), ${warnings.length} warning(s):\n`);
  for (const d of diagnostics) console.log(`error ${d.where} — ${d.message}`);
  for (const w of warnings) console.log(`warning ${w.where} — ${w.message}`);
  printStats(stats);

  return diagnostics.length === 0;
}

// ---------------------------------------------------------------------------
// --test [module/lesson]: `terraform test` over collected *.tftest.hcl fences
// ---------------------------------------------------------------------------

// A `tests/x.tftest.hcl` fence's tests run against the module ONE level up
// (Terraform's own convention: `<module-root>/tests/*.tftest.hcl`); a bare
// `.tftest.hcl` fence with no `tests/` prefix runs in its own dir. See the
// inline use in the `roots` loop below.

function runTestMode(target) {
  ensurePluginCache();
  const descriptors = target ? [findLesson(target)].filter(Boolean) : discoverLessons();
  if (target && !descriptors.length) {
    console.error(`no such lesson: ${target}`);
    process.exit(1);
  }
  const { fenceMap } = buildLessonsTree(descriptors);

  let ran = 0;
  for (const namespace of fenceMap.keys()) {
    const lessonDir = path.join(LESSONS_DIR, namespace);
    const info = fenceMap.get(namespace);
    const testRelPaths = [...info.fences.keys()].filter((p) => p.endsWith('.tftest.hcl'));
    if (!testRelPaths.length) continue;

    const roots = new Set();
    for (const rel of testRelPaths) {
      const testDir = path.dirname(path.join(lessonDir, rel));
      const first = rel.split('/')[0];
      const moduleRoot = first === 'tests' ? path.dirname(testDir) : testDir;
      roots.add(moduleRoot);
    }

    for (const moduleRoot of roots) {
      ran++;
      ensureHarnessProviders(moduleRoot);
      const init = runInit(moduleRoot, { noCache: true });
      if (init.status !== 0) {
        console.log(`${info.mdxRelPath}: terraform init failed in ${path.relative(lessonDir, moduleRoot) || '.'}`);
        console.log((init.stdout ?? '') + (init.stderr ?? ''));
        continue;
      }
      const test = spawnSync('terraform', ['test', '-no-color'], { cwd: moduleRoot, encoding: 'utf8', env: tfEnv(true) });
      const out = ((test.stdout ?? '') + (test.stderr ?? '')).trim();
      const summaryLine = out.split('\n').filter((l) => /passed|failed|Success|Error/.test(l)).slice(-3).join('\n');
      console.log(`\n${info.mdxRelPath} (${path.relative(lessonDir, moduleRoot) || '.'}):`);
      console.log(summaryLine || out.split('\n').slice(-10).join('\n'));
    }
  }
  if (!ran) console.log(target ? `${target}: no .tftest.hcl fences` : 'no .tftest.hcl fences in any lesson');
}

// ---------------------------------------------------------------------------
// --plan <module>/<lesson>
// ---------------------------------------------------------------------------

const OFFLINE_AUTH_HINTS = [
  'unable to build authorizer',
  'executable file not found',
  'no valid credential sources',
  'could not find default credentials',
  'Request had insufficient authentication scopes',
  'failed to get existing workspaces',
  'Error: oauth2: cannot fetch token',
];

function runPlanMode(target) {
  ensurePluginCache();
  if (!target) {
    console.error('usage: node tools/verify-snippets.mjs --plan <module>/<lesson>');
    process.exit(1);
  }
  const d = findLesson(target);
  if (!d) {
    console.error(`no such lesson: ${target}`);
    process.exit(1);
  }
  const { fenceMap } = buildLessonsTree([d]);
  const namespace = d.namespace;
  const lessonDir = path.join(LESSONS_DIR, namespace);
  const { terraformUnits } = discoverUnits(lessonDir);
  if (!terraformUnits.length) {
    console.log(`${target}: no terraform units to plan`);
    return;
  }
  for (const unitDir of terraformUnits) {
    ensureHarnessProviders(unitDir);
    const init = runInit(unitDir);
    if (init.status !== 0) {
      console.log(`${target} (${unitRelPath(unitDir)}): init failed`);
      console.log((init.stdout ?? '') + (init.stderr ?? ''));
      continue;
    }
    const plan = spawnSync('terraform', ['plan', '-no-color', '-input=false'], {
      cwd: unitDir,
      encoding: 'utf8',
      env: tfEnv(),
    });
    const out = (plan.stdout ?? '') + (plan.stderr ?? '');
    const hint = OFFLINE_AUTH_HINTS.find((h) => out.includes(h));
    console.log(`\n${target} (${unitRelPath(unitDir)}) [${CONFIG.cloud}]:`);
    if (hint) {
      console.log(`not possible offline: ${hint}`);
    } else {
      console.log(out.trim().split('\n').slice(-30).join('\n'));
    }
  }
}

// ---------------------------------------------------------------------------
// --terragrunt <module>/<lesson>: full live tree, run --all plan offline
// ---------------------------------------------------------------------------

function runTerragruntMode(target) {
  ensurePluginCache();
  if (!target) {
    console.error('usage: node tools/verify-snippets.mjs --terragrunt <module>/<lesson>');
    process.exit(1);
  }
  const d = findLesson(target);
  if (!d) {
    console.error(`no such lesson: ${target}`);
    process.exit(1);
  }
  const { fenceMap } = buildLessonsTree([d]);
  const lessonDir = path.join(LESSONS_DIR, d.namespace);
  const { terragruntUnits, hasRoot } = discoverUnits(lessonDir);
  if (!hasRoot || terragruntUnits.length < 2) {
    console.log(`${target}: no full live tree (root.hcl + ≥2 units) — not possible offline in this lesson`);
    return;
  }
  const res = spawnSync(
    'terragrunt',
    ['run', '--all', '--non-interactive', '--no-color', '--working-dir', lessonDir, '--', 'plan'],
    { encoding: 'utf8', env: tfEnv() },
  );
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  console.log(out.trim().split('\n').slice(-60).join('\n'));
  process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------------------
// --all-hcl: every collected+fragment hcl fence, standalone as its own
// main.tf, pass/fail/fragment counts per lesson (baseline numbers).
// ---------------------------------------------------------------------------

function runAllHclMode() {
  ensurePluginCache();
  const descriptors = discoverLessons();
  const scratchRoot = path.join(PROBE_DIR, 'all-hcl');
  rmSync(scratchRoot, { recursive: true, force: true });
  mkdirSync(scratchRoot, { recursive: true });

  const perModule = new Map(); // module -> { pass, fail, fragment }
  let totalPass = 0,
    totalFail = 0,
    totalFragment = 0;
  const failDetails = [];

  let n = 0;
  for (const d of descriptors) {
    const src = readFileSync(d.absPath, 'utf8');
    const stripped = stripExcluded(src, findExcludedRanges(src));
    const fenceRe = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
    let m;
    const counters = perModule.get(d.module) ?? { pass: 0, fail: 0, fragment: 0 };
    perModule.set(d.module, counters);
    let fenceNum = 0;
    while ((m = fenceRe.exec(stripped))) {
      fenceNum++;
      if (m[1] !== HCL_LANG) continue;
      const body = m[2];
      if (body.split('\n', 1)[0].trim().includes('@expect-error')) continue; // still not a standalone-file candidate
      n++;
      const unitDir = path.join(scratchRoot, `f${n}`);
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(path.join(unitDir, 'main.tf'), body);
      ensureHarnessProviders(unitDir);
      const init = runInit(unitDir);
      if (init.status !== 0) {
        counters.fragment++;
        totalFragment++;
        continue;
      }
      const val = runValidate(unitDir);
      let parsed;
      try {
        parsed = JSON.parse(val.stdout);
      } catch {
        counters.fragment++;
        totalFragment++;
        continue;
      }
      if (parsed.valid) {
        counters.pass++;
        totalPass++;
      } else {
        counters.fail++;
        totalFail++;
        failDetails.push({
          mdxRelPath: d.mdxRelPath,
          fenceNum,
          errors: (parsed.diagnostics ?? []).map((x) => `${x.summary}: ${x.detail}`),
        });
      }
    }
  }

  console.log(`\n--all-hcl baseline (every hcl fence as a standalone main.tf, ${CONFIG.cloud} provider):`);
  for (const [module, c] of [...perModule.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${module}: ${c.pass} pass / ${c.fail} fail / ${c.fragment} fragment`);
  }
  console.log(`  TOTAL: ${totalPass} pass / ${totalFail} fail / ${totalFragment} fragment (of ${n} hcl fences)`);
  if (failDetails.length) {
    console.log('\nreal fails:');
    for (const f of failDetails) {
      console.log(`  ${f.mdxRelPath}:fence #${f.fenceNum}`);
      for (const e of f.errors) console.log(`    ${e}`);
    }
  }
  rmSync(scratchRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// --clean
// ---------------------------------------------------------------------------

function runClean() {
  for (const dir of walk(LESSONS_DIR)) {
    const tfDir = path.join(dir, '.terraform');
    if (existsSync(tfDir)) rmSync(tfDir, { recursive: true, force: true });
    const lockFile = path.join(dir, '.terraform.lock.hcl');
    rmSync(lockFile, { force: true });
    const tgCache = path.join(dir, '.terragrunt-cache');
    if (existsSync(tgCache)) rmSync(tgCache, { recursive: true, force: true });
  }
  console.log('removed tools/probe/lessons/**/.terraform, .terraform.lock.hcl, .terragrunt-cache');
  console.log('NOTE: the shared provider plugin cache at tools/probe/.plugin-cache was left in place');
  console.log('(re-download is the slow part — pass --clean-cache too if you need the disk back).');
  if (process.argv.includes('--clean-cache')) {
    rmSync(PLUGIN_CACHE_DIR, { recursive: true, force: true });
    console.log('removed tools/probe/.plugin-cache');
  }
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

function selfTest() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'verify-snippets-selftest-'));
  const mdxPath = path.join(tmpDir, 'self.mdx');

  const providerLine = CONFIG.mockProviderBlock;
  writeFileSync(
    mdxPath,
    [
      '---',
      'title: selftest',
      '---',
      '',
      '```hcl',
      '# modules/good/main.tf',
      'terraform {',
      `  required_version = "${CONFIG.requiredVersion}"`,
      '  required_providers {',
      `    ${CONFIG.providerLabel} = { source = "${CONFIG.providerSource}", version = "${CONFIG.providerVersion}" }`,
      '  }',
      '}',
      providerLine.trimEnd(),
      'resource "terraform_data" "good" {',
      '  input = "ok"',
      '}',
      '```',
      '',
      '```hcl',
      '# modules/bad/main.tf',
      'resource "terraform_data" "bad" {',
      '  not_a_real_argument = true',
      '}',
      '```',
      '',
      '```hcl',
      '# @expect-error deliberately invalid HCL, never collected',
      'resource "oops" {',
      '```',
      '',
      '```hcl',
      '# tests/good.tftest.hcl',
      'run "check" {',
      '  command = plan',
      '  assert {',
      '    condition     = terraform_data.good.input == "ok"',
      '    error_message = "input mismatch"',
      '  }',
      '}',
      '```',
      '',
      '```hcl',
      '# live/unit/terragrunt.hcl',
      'include "root" {',
      '  path = find_in_parent_folders("root.hcl")',
      '}',
      'terraform {',
      '  source = "../../modules/good"',
      '}',
      '```',
      '',
      '```hcl',
      '# root.hcl',
      'remote_state {',
      '  backend = "local"',
      '  generate = {',
      '    path      = "backend.tf"',
      '    if_exists = "overwrite"',
      '  }',
      '  config = {',
      '    path = "${path_relative_to_include()}/terraform.tfstate"',
      '  }',
      '}',
      '```',
      '',
    ].join('\n'),
  );

  const d = {
    absPath: mdxPath,
    mdxRelPath: 'selftest/self.mdx',
    module: '__selftest__',
    lesson: 'self',
    namespace: '__selftest____self',
  };

  const { fenceMap, stats } = buildLessonsTree([d]);
  const lessonDir = path.join(LESSONS_DIR, d.namespace);
  const { terraformUnits, terragruntUnits, hasRoot } = discoverUnits(lessonDir);

  const results = { goodPassed: null, badFailed: null, tgValidatePassed: null, tgRenderPassed: null, testPassed: null };

  for (const unitDir of terraformUnits) {
    ensureHarnessProviders(unitDir);
    const init = runInit(unitDir);
    const rel = unitRelPath(unitDir);
    if (rel === 'modules/good') {
      results.goodPassed = init.status === 0 && JSON.parse(runValidate(unitDir).stdout || '{}').valid === true;
    } else if (rel === 'modules/bad') {
      const val = init.status === 0 ? JSON.parse(runValidate(unitDir).stdout || '{}') : { valid: false };
      results.badFailed = val.valid === false;
    }
  }

  if (terragruntUnits.length) {
    const hv = spawnSync('terragrunt', ['hcl', 'validate', '--working-dir', lessonDir, '--non-interactive', '--no-color'], {
      encoding: 'utf8',
    });
    results.tgValidatePassed = hv.status === 0;
    if (hasRoot) {
      const unitDir = terragruntUnits.find((u) => unitRelPath(u) !== '.');
      if (unitDir) {
        const rd = spawnSync(
          'terragrunt',
          ['render', '--format', 'json', '--working-dir', unitDir, '--non-interactive', '--no-color'],
          { encoding: 'utf8', env: tfEnv() },
        );
        results.tgRenderPassed = rd.status === 0;
      }
    }
  }

  const testModuleRoot = path.join(lessonDir, 'modules/good');
  if (existsSync(path.join(lessonDir, 'tests/good.tftest.hcl'))) {
    ensureHarnessProviders(testModuleRoot);
    runInit(testModuleRoot, { noCache: true });
    const test = spawnSync('terraform', ['test', '-no-color'], { cwd: testModuleRoot, encoding: 'utf8', env: tfEnv(true) });
    results.testPassed = test.status === 0;
  }

  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(LESSONS_DIR, { recursive: true, force: true });

  const ok =
    results.goodPassed === true &&
    results.badFailed === true &&
    results.tgValidatePassed === true &&
    results.tgRenderPassed === true &&
    results.testPassed === true;

  if (ok) {
    console.log('\nself-test: PASS', results);
    process.exit(0);
  }
  console.error('\nself-test: FAIL', results);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) return selfTest();
  if (args.includes('--all-hcl')) return runAllHclMode();
  if (args.includes('--clean')) return runClean();

  const testIdx = args.indexOf('--test');
  if (testIdx !== -1) return runTestMode(args[testIdx + 1]);

  const planIdx = args.indexOf('--plan');
  if (planIdx !== -1) return runPlanMode(args[planIdx + 1]);

  const tgIdx = args.indexOf('--terragrunt');
  if (tgIdx !== -1) return runTerragruntMode(args[tgIdx + 1]);

  const ok = runCheckMode();
  process.exit(ok ? 0 : 1);
}

main();
