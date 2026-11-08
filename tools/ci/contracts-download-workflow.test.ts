// CT-06zzzzk (FU-CONTRACTS-DOWNLOAD-RETRY): the install of the oasdiff binary in the
// contracts-check job of .github/workflows/contracts.yml, read from the real file. contracts-check
// (and so contracts-gate) went red on curl 504s while downloading the oasdiff release, the same
// failure CT-06zzzzh (#2847) fixed for gitleaks. The install is to be cached (actions/cache,
// pinned to the same SHA as ci.yml, keyed by the oasdiff version and the sha256 of the release
// archive) and the download retried harder, without relaxing anything:
//
// - the cached path is the release archive itself, so whatever its source (cache or download) it
//   is checked with `sha256sum -c` against OASDIFF_SHA256 before it is unpacked;
// - a cached archive that fails the check fails the job (no silent re-download to green);
// - a download that keeps failing fails the job and the comparison never runs; nothing (if:,
//   continue-on-error) lets the comparison be skipped while the job stays green;
// - contracts-detect, the comparison step, contracts-gate, the triggers, the permissions, the
//   concurrency and the pinned release are as before.
//
// The run steps of the job are extracted from the YAML and executed with bash, in order, with
// every `${{ <expression> }}` replaced by a value chosen per scenario, and with a fake `curl`, a
// fake `sha256sum` (node crypto), a fake `pnpm` and a fake `sleep` first on PATH. The fake curl
// serves a small release archive built here (an `oasdiff` shell script that logs its arguments),
// or a tampered one, or fails like a 504. The cache step itself is simulated: a hit puts an
// archive at the expanded cache `path` and sets `cache-hit` to 'true'. The comparison step runs
// for real against a small git checkout whose base commit has a contracts/openapi.yaml, with
// tools/ci/oasdiff-base.ts copied in, so the unpacked oasdiff is what it calls.
// Modelled on gitleaks-workflow.test.ts; the YAML helpers are line-based (no YAML dependency).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkWorkflows } from './check-workflows.ts';

const REPO = resolve(import.meta.dirname, '../..');
const WORKFLOW = readFileSync(join(REPO, '.github/workflows/contracts.yml'), 'utf8');
const LINES = WORKFLOW.split('\n');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const SCRATCH = join(REPO, '.tmp', `contracts-download-workflow-${process.pid}`);

const JOB = 'contracts-check';
const HEAD_SHA = 'a'.repeat(40);
/** Lower bounds fixed for the implementation (as in CT-06zzzzh). */
const MIN_RETRIES = 6;
const MIN_RETRY_DELAY_S = 2;
const MIN_RETRY_MAX_TIME_S = 60;
/** The job timeout as written; the retries must end before it. */
const JOB_TIMEOUT_MINUTES = 15;
/** The pinned release must not change with this task. */
const PINNED_VERSION = '1.32.1';
const PINNED_SHA_HEAD = '7c8939fc49b7';
const PINNED_SHA_TAIL = 'a1ee7f';

const BREAKING_NAME = 'Breaking changes against the base contract';
/** The comparison step as it was before CT-06zzzzk, verbatim (the block scalar, de-indented). */
const BREAKING_RUN = [
  'set -euo pipefail',
  'if [ -z "$BASE" ] || ! git cat-file -e "${BASE}:contracts/openapi.yaml" 2>/dev/null; then',
  '  echo "::notice title=oasdiff::base has no contracts/openapi.yaml, nothing to compare"',
  '  exit 0',
  'fi',
  '# A detached worktree keeps relative $ref targets of the base contract resolvable.',
  'git worktree add --detach "$RUNNER_TEMP/base-tree" "$BASE"',
  '# Operations still marked x-implementation: planned in the base have no route and no',
  '# caller, so they are left out of the comparison (tools/ci/oasdiff-base.ts; the',
  '# contract has no external $ref, so the JSON copy resolves on its own).',
  'node tools/ci/oasdiff-base.ts "$RUNNER_TEMP/base-tree/contracts/openapi.yaml" \\',
  '  "$RUNNER_TEMP/base-openapi.json"',
  '# Accepted changes, listed one by one with their ruling (D10-484): only response enum',
  '# values added that old clients cannot receive. Without the file nothing is ignored.',
  'ignore=()',
  'if [ -f contracts/oasdiff-accepted.txt ]; then',
  '  ignore=(--err-ignore contracts/oasdiff-accepted.txt)',
  'fi',
  '"$RUNNER_TEMP/oasdiff/oasdiff" breaking --fail-on ERR "${ignore[@]}" \\',
  '  "$RUNNER_TEMP/base-openapi.json" contracts/openapi.yaml',
].join('\n');
const BREAKING_ENV = { BASE: '${{ needs.contracts-detect.outputs.base }}' };
/** The run steps before the install, in order, as before. */
const PRE_RUNS = ['pnpm install --frozen-lockfile', 'pnpm contracts:check'];

const DETECT_RUN = [
  'base=""',
  'if [ "$EVENT" = pull_request ]; then',
  '  base="$PR_BASE_SHA"',
  'elif [ -n "$PUSH_BEFORE" ] && git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then',
  '  base="$PUSH_BEFORE"',
  'fi',
  'if [ -z "$base" ]; then',
  '  # No usable base (first push): treat as changed, there is nothing to compare against.',
  '  changed=true',
  'elif git diff --quiet "$base" HEAD -- contracts packages/contracts-ts; then',
  '  changed=false',
  'else',
  '  changed=true',
  'fi',
  'echo "base=${base} changed=${changed}"',
  'echo "changed=${changed}" >> "$GITHUB_OUTPUT"',
  'echo "base=${base}" >> "$GITHUB_OUTPUT"',
].join('\n');
const DETECT_ENV = {
  EVENT: '${{ github.event_name }}',
  PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
  PUSH_BEFORE: '${{ github.event.before }}',
};
const DETECT_OUTPUTS = [
  '      changed: ${{ steps.diff.outputs.changed }}',
  '      base: ${{ steps.diff.outputs.base }}',
];

const GATE_RUN = [
  'echo "contracts-detect=${DETECT} changed=${CHANGED} contracts-check=${CHECK}"',
  '[ "$DETECT" = success ] || exit 1',
  'if [ "$CHANGED" = true ]; then',
  '  [ "$CHECK" = success ] || exit 1',
  'else',
  '  [ "$CHANGED" = false ] || exit 1',
  '  echo "::notice title=contracts-gate::n/a, contract paths unchanged"',
  'fi',
].join('\n');
const GATE_ENV = {
  DETECT: '${{ needs.contracts-detect.result }}',
  CHANGED: '${{ needs.contracts-detect.outputs.changed }}',
  CHECK: '${{ needs.contracts-check.result }}',
};

// --- line-based YAML helpers (as in gitleaks-workflow.test.ts) ----------------------------------

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Removes a trailing ` # comment` and surrounding quotes from a scalar value. */
function scalar(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, '').trim();
  const single = /^'(.*)'$/.exec(withoutComment);
  if (single) return (single[1] ?? '').replace(/''/g, "'");
  const double = /^"(.*)"$/.exec(withoutComment);
  return double ? (double[1] ?? '') : withoutComment;
}

/** The lines of the job `id` (without its id line), or null when there is no such job. */
function jobBody(id: string): string[] | null {
  const jobsAt = LINES.findIndex((l) => l === 'jobs:');
  if (jobsAt < 0) return null;
  const at = LINES.findIndex(
    (l, i) => i > jobsAt && new RegExp(`^ {2}${id.replace(/[-]/g, '\\-')}:\\s*(#.*)?$`).test(l),
  );
  if (at < 0) return null;
  const body: string[] = [];
  for (let i = at + 1; i < LINES.length; i++) {
    const line = LINES[i] ?? '';
    if (!isBlankOrComment(line) && indentOf(line) <= 2) break;
    body.push(line);
  }
  return body;
}

function requireJob(id: string): string[] {
  const body = jobBody(id);
  expect(body, `contracts.yml has a job \`${id}\``).not.toBeNull();
  return body ?? [];
}

type Entry = { inline: string; block: string[] };

/** Key `key` at indentation `indent` within `lines`: its inline value and its block lines. */
function entry(lines: string[], key: string, indent: number): Entry | null {
  const re = new RegExp(`^ {${indent}}${key.replace(/[-]/g, '\\-')}:(\\s.*)?$`);
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return null;
  const line = lines[at] ?? '';
  const inline = line.slice(line.indexOf(':') + 1).trim();
  const block: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.trim() !== '' && indentOf(l) <= indent) break;
    block.push(l);
  }
  while (block.length > 0 && (block[block.length - 1] ?? '').trim() === '') block.pop();
  return { inline, block };
}

/** A block scalar (`|`, `>-`, ...) as text, de-indented; a folded one is joined with spaces. */
function blockText(e: Entry): string {
  const nonBlank = e.block.filter((l) => l.trim() !== '');
  const indent = Math.min(...nonBlank.map(indentOf));
  const lines = e.block.map((l) => l.slice(indent));
  if (e.inline.startsWith('>'))
    return lines
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
  return lines.join('\n');
}

function value(e: Entry): string {
  if (/^[|>][-+]?\s*(#.*)?$/.test(e.inline)) return blockText(e);
  return scalar(e.inline);
}

function mapping(e: Entry | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (e === null) return out;
  const nonBlank = e.block.filter((l) => !isBlankOrComment(l));
  if (nonBlank.length === 0) return out;
  const indent = Math.min(...nonBlank.map(indentOf));
  for (const l of e.block) {
    if (isBlankOrComment(l) || indentOf(l) !== indent) continue;
    const m = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(l);
    if (m) out[m[1] ?? ''] = scalar(m[2] ?? '');
  }
  return out;
}

type Step = {
  index: number;
  lines: string[];
  id: string | null;
  name: string | null;
  uses: string | null;
  run: string | null;
  if: string | null;
  continueOnError: string | null;
  env: Record<string, string>;
};

/** The steps of job `job`, each a small record of the keys this test needs. */
function steps(job: string = JOB): Step[] {
  const body = requireJob(job);
  const at = body.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  expect(at, `job \`${job}\` has steps`).toBeGreaterThanOrEqual(0);
  const items: string[][] = [];
  for (const line of body.slice(at + 1)) {
    if (/^ {6}- /.test(line)) items.push([line.replace(/^ {6}- /, '        ')]);
    else if (items.length > 0 && (line.trim() === '' || indentOf(line) >= 8)) {
      items[items.length - 1]?.push(line);
    } else if (items.length > 0 && !isBlankOrComment(line) && indentOf(line) <= 4) break;
  }
  return items.map((lines, index) => {
    const get = (key: string): string | null => {
      const e = entry(lines, key, 8);
      return e === null ? null : value(e);
    };
    return {
      index,
      lines,
      id: get('id'),
      name: get('name'),
      uses: get('uses'),
      run: get('run'),
      if: get('if'),
      continueOnError: get('continue-on-error'),
      env: mapping(entry(lines, 'env', 8)),
    };
  });
}

/** A `with:` input of a step (inline or block scalar), or null. */
function withInput(step: Step, key: string): string | null {
  const w = entry(step.lines, 'with', 8);
  if (w === null) return null;
  const nonBlank = w.block.filter((l) => !isBlankOrComment(l));
  if (nonBlank.length === 0) return null;
  const e = entry(w.block, key, Math.min(...nonBlank.map(indentOf)));
  return e === null ? null : value(e);
}

/** Replaces every `${{ expr }}` in `text` by `values[expr]`; an unknown expression throws. */
function expand(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expr: string) => {
    const v = values[expr];
    if (v === undefined) throw new Error(`no scenario value for \${{ ${expr} }}`);
    return v;
  });
}

/** The non-blank, non-comment lines of a block. */
function significant(e: Entry | null): string[] {
  return e === null ? [] : e.block.filter((l) => !isBlankOrComment(l));
}

// --- the shape of the job ----------------------------------------------------------------------

const CACHE_USES = /^actions\/cache(\/restore)?@([0-9a-f]{40})$/;
const SAVE_USES = /^actions\/cache\/save@([0-9a-f]{40})$/;

type Shape = {
  all: Step[];
  /** The `pnpm install` / `pnpm contracts:check` steps, as before. */
  pre: Step[];
  breaking: Step;
  cache: Step | null;
  save: Step | null;
  /** The other run steps before the comparison: the install of the binary. */
  install: Step[];
};

function shape(): Shape {
  const all = steps();
  const breakings = all.filter((s) => s.name === BREAKING_NAME);
  expect(breakings.length, `contracts-check has exactly one step named "${BREAKING_NAME}"`).toBe(1);
  const breaking = breakings[0] as Step;
  const before = all.filter((s) => s.index < breaking.index && s.run !== null);
  const pre = before.filter((s) => PRE_RUNS.includes(s.run ?? ''));
  const install = before.filter((s) => !PRE_RUNS.includes(s.run ?? ''));
  expect(
    install.length,
    'a run step before the comparison installs oasdiff',
  ).toBeGreaterThanOrEqual(1);
  const cache = all.find((s) => s.uses !== null && CACHE_USES.test(s.uses)) ?? null;
  const save = all.find((s) => s.uses !== null && SAVE_USES.test(s.uses)) ?? null;
  return { all, pre, breaking, cache, save, install };
}

function requireCache(sh: Shape): Step {
  expect(
    sh.cache,
    'contracts-check has an actions/cache (or actions/cache/restore) step for the release archive',
  ).not.toBeNull();
  return sh.cache as Step;
}

/** workflow env + job env, raw. */
function globalEnvRaw(): Record<string, string> {
  return { ...mapping(entry(LINES, 'env', 0)), ...mapping(entry(requireJob(JOB), 'env', 4)) };
}

/**
 * OASDIFF_VERSION / OASDIFF_SHA256 as the install sees them, unexpanded. Every env block of the
 * workflow, the job and its steps that sets one of them sets the same value.
 */
function pinnedRelease(sh: Shape): { version: string; sha: string } {
  const blocks = [
    mapping(entry(LINES, 'env', 0)),
    mapping(entry(requireJob(JOB), 'env', 4)),
    ...sh.all.map((s) => s.env),
  ];
  for (const key of ['OASDIFF_VERSION', 'OASDIFF_SHA256']) {
    const set = new Set(blocks.filter((b) => key in b).map((b) => b[key]));
    expect(set.size, `${key} is set to one value wherever it is set`).toBe(1);
  }
  const env: Record<string, string> = { ...globalEnvRaw() };
  for (const s of sh.install) Object.assign(env, s.env);
  const version = env['OASDIFF_VERSION'] ?? '';
  const sha = env['OASDIFF_SHA256'] ?? '';
  expect(version, 'OASDIFF_VERSION is set as a literal in an env the install sees').toMatch(
    /^\d+\.\d+\.\d+$/,
  );
  expect(sha, 'OASDIFF_SHA256 is set as a literal in an env the install sees').toMatch(
    /^[0-9a-f]{64}$/,
  );
  return { version, sha };
}

function ciCacheShas(): string[] {
  const shas = new Set<string>();
  for (const m of CI.matchAll(/uses:\s*actions\/cache(?:\/restore|\/save)?@([0-9a-f]{40})/g)) {
    shas.add(m[1] ?? '');
  }
  return [...shas];
}

// --- fakes ---------------------------------------------------------------------------------------

/** curl: logs its argv; FAKE_CURL_MODE ok / bad serves the good / tampered archive, fail = 504. */
const FAKE_CURL = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify(args) + '\n');
let out = null;
let outDir = null;
let remoteName = false;
let createDirs = false;
let url = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o' || a === '--output') out = args[++i];
  else if (a === '--output-dir') outDir = args[++i];
  else if (a === '-O' || a === '--remote-name') remoteName = true;
  else if (a === '--create-dirs') createDirs = true;
  else if (/^-[A-Za-z]+$/.test(a)) {
    if (a.endsWith('o')) out = args[++i];
    else if (a.endsWith('O')) remoteName = true;
  } else if (/^https?:\/\//.test(a)) url = a;
}
const mode = process.env.FAKE_CURL_MODE;
if (mode === 'fail') {
  process.stderr.write('curl: (22) The requested URL returned error: 504\n');
  process.exit(22);
}
if (url === null) {
  process.stderr.write('fake curl: no URL in ' + JSON.stringify(args) + '\n');
  process.exit(2);
}
const body = fs.readFileSync(mode === 'bad' ? process.env.FAKE_CURL_BAD : process.env.FAKE_CURL_GOOD);
if (out === null && remoteName) out = path.basename(new URL(url).pathname);
if (out === null || out === '-') {
  fs.writeSync(1, body);
  process.exit(0);
}
const target = outDir !== null && !path.isAbsolute(out) ? path.join(outDir, out) : out;
if (createDirs) fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, body);
`;

/** sha256sum (GNU semantics for plain hashing and -c); logs every check it makes. */
const FAKE_SHA256SUM = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
let check = false;
let status = false;
let quiet = false;
const files = [];
for (const a of args) {
  if (a === '--check') check = true;
  else if (a === '--status') status = true;
  else if (a === '--quiet') quiet = true;
  else if (['--strict', '--warn', '--binary', '--text', '--ignore-missing'].includes(a)) {}
  else if (a === '-' || !a.startsWith('-')) files.push(a);
  else if (/^-[cwbt]+$/.test(a)) { if (a.includes('c')) check = true; }
  else {
    process.stderr.write('fake sha256sum: unsupported option ' + a + '\n');
    process.exit(2);
  }
}
const read = (f) => (f === '-' ? fs.readFileSync(0) : fs.readFileSync(f));
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const checked = [];
const log = () =>
  fs.appendFileSync(process.env.FAKE_SHA_LOG, JSON.stringify({ args, check, checked }) + '\n');
const sources = files.length > 0 ? files : ['-'];
if (!check) {
  let code = 0;
  for (const f of sources) {
    try {
      process.stdout.write(hash(read(f)) + '  ' + f + '\n');
    } catch (e) {
      process.stderr.write('sha256sum: ' + f + ': No such file or directory\n');
      code = 1;
    }
  }
  log();
  process.exit(code);
}
let bad = 0;
let valid = 0;
for (const src of sources) {
  let text = '';
  try { text = read(src).toString('utf8'); } catch (e) {
    process.stderr.write('sha256sum: ' + src + ': No such file or directory\n');
    bad++;
    continue;
  }
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (m === null) continue;
    valid++;
    const file = m[2];
    let actual = null;
    try { actual = hash(read(file)); } catch (e) { actual = null; }
    const ok = actual !== null && actual === m[1].toLowerCase();
    checked.push({ file: path.resolve(file), expected: m[1].toLowerCase(), actual, ok });
    if (!ok) bad++;
    if (!status && (!ok || !quiet)) process.stdout.write(file + ': ' + (ok ? 'OK' : 'FAILED') + '\n');
  }
}
log();
if (valid === 0) {
  process.stderr.write('sha256sum: no properly formatted checksum lines found\n');
  process.exit(1);
}
process.exit(bad > 0 ? 1 : 0);
`;

/** The oasdiff in the good archive: logs its arguments; FAKE_OASDIFF_BREAKING=1 reports a break. */
const FAKE_OASDIFF = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$FAKE_OASDIFF_LOG"',
  'if [ "$1" = --version ]; then echo "oasdiff version fake"; fi',
  'if [ "$1" = breaking ] && [ "${FAKE_OASDIFF_BREAKING:-}" = 1 ]; then',
  '  echo "error [api-path-removed-without-deprecation] GET /a"',
  '  exit 1',
  'fi',
  'exit 0',
  '',
].join('\n');
const TAMPERED_OASDIFF = [
  '#!/bin/sh',
  ': > "$FAKE_TAMPERED_MARK"',
  'printf \'%s\\n\' "$*" >> "$FAKE_OASDIFF_LOG"',
  'if [ "$1" = --version ]; then echo "tampered"; fi',
  'exit 0',
  '',
].join('\n');

const PNPM = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_PNPM_LOG"\nexit 0\n`;

/** The base contract of the fixture checkout: one shipped and one planned operation. */
const BASE_OPENAPI = [
  'openapi: 3.1.0',
  'info:',
  '  title: fixture',
  '  version: 0.0.0',
  'paths:',
  '  /a:',
  '    get:',
  '      operationId: getA',
  '      responses:',
  "        '200':",
  '          description: ok',
  '  /b:',
  '    post:',
  '      operationId: postB',
  '      x-implementation: planned',
  '      responses:',
  "        '200':",
  '          description: ok',
  '',
].join('\n');
const HEAD_OPENAPI = BASE_OPENAPI.replace('title: fixture', 'title: fixture head');

let BIN = '';
let GOOD_ARCHIVE = '';
let BAD_ARCHIVE = '';
let GOOD_SHA = '';
let runCount = 0;

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function buildArchive(name: string, script: string): string {
  const src = join(SCRATCH, 'fixtures', name);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'oasdiff'), script);
  chmodSync(join(src, 'oasdiff'), 0o755);
  writeFileSync(join(src, 'README.md'), `# ${name}\n`);
  const archive = join(SCRATCH, 'fixtures', `${name}.tar.gz`);
  const res = spawnSync('tar', ['-czf', archive, '-C', src, 'oasdiff', 'README.md'], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', COPYFILE_DISABLE: '1' },
  });
  if (res.status !== 0) throw new Error(`tar: ${res.stderr}`);
  return archive;
}

function writeNodeTool(name: string, source: string): void {
  writeFileSync(join(BIN, `${name}.cjs`), source);
  writeFileSync(
    join(BIN, name),
    `#!/bin/sh\nexec '${process.execPath}' '${join(BIN, `${name}.cjs`)}' "$@"\n`,
  );
  chmodSync(join(BIN, name), 0o755);
}

function writeShellTool(name: string, source: string): void {
  writeFileSync(join(BIN, name), source);
  chmodSync(join(BIN, name), 0o755);
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  BIN = join(SCRATCH, 'bin');
  mkdirSync(BIN, { recursive: true });
  writeNodeTool('curl', FAKE_CURL);
  writeNodeTool('sha256sum', FAKE_SHA256SUM);
  writeShellTool('sleep', `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_SLEEP_LOG"\nexit 0\n`);
  writeShellTool('pnpm', PNPM);
  GOOD_ARCHIVE = buildArchive('good', FAKE_OASDIFF);
  BAD_ARCHIVE = buildArchive('tampered', TAMPERED_OASDIFF);
  GOOD_SHA = sha256(GOOD_ARCHIVE);
  expect(sha256(BAD_ARCHIVE)).not.toBe(GOOD_SHA);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// --- the fixture checkout ------------------------------------------------------------------------

function git(cwd: string, home: string, args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * A checkout whose base commit has contracts/openapi.yaml (with a planned operation) and whose
 * HEAD changes it; tools/ci/oasdiff-base.ts and its import are copied in. Returns the base SHA.
 */
function makeCheckout(checkout: string, home: string): string {
  const copy = (rel: string): void => {
    mkdirSync(dirname(join(checkout, rel)), { recursive: true });
    writeFileSync(join(checkout, rel), readFileSync(join(REPO, rel)));
  };
  copy('tools/ci/oasdiff-base.ts');
  copy('tools/lib/yaml-lite.ts');
  writeFileSync(join(checkout, 'package.json'), '{ "type": "module", "private": true }\n');
  mkdirSync(join(checkout, 'contracts'), { recursive: true });
  writeFileSync(join(checkout, 'contracts', 'openapi.yaml'), BASE_OPENAPI);
  writeFileSync(join(checkout, 'contracts', 'oasdiff-accepted.txt'), '# none\n');
  git(checkout, home, ['init', '--quiet', '--initial-branch=main']);
  git(checkout, home, ['add', '-A']);
  git(checkout, home, ['commit', '--quiet', '-m', 'base']);
  const base = git(checkout, home, ['rev-parse', 'HEAD']);
  writeFileSync(join(checkout, 'contracts', 'openapi.yaml'), HEAD_OPENAPI);
  git(checkout, home, ['commit', '--quiet', '-am', 'head']);
  return base;
}

// --- running the job -----------------------------------------------------------------------------

type Scenario = {
  /** What the cache restores: nothing (miss), the good archive or a tampered one (hit). */
  cache: 'none' | 'good' | 'bad';
  curl: 'ok' | 'bad' | 'fail';
  /** Whether the fake oasdiff reports a breaking change. */
  breaking?: boolean;
};

type ShaCheck = { file: string; expected: string; actual: string | null; ok: boolean };

type JobRun = {
  status: number | null;
  out: string;
  ran: string[];
  curl: string[][];
  checks: ShaCheck[];
  oasdiff: string[];
  pnpm: string[];
  tampered: boolean;
  runnerTemp: string;
  cachePath: string | null;
};

function readLines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

/** Entries a step wrote to $GITHUB_ENV (`K=V` and `K<<DELIM` forms). */
function githubEnvEntries(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    const heredoc = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(l);
    if (heredoc) {
      const buf: string[] = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) buf.push(lines[i] ?? '');
      out[heredoc[1] ?? ''] = buf.join('\n');
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (kv) out[kv[1] ?? ''] = kv[2] ?? '';
  }
  return out;
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** Runs every run step of contracts-check in order, as the runner would, against the fakes. */
function runJob(sc: Scenario): JobRun {
  const dir = join(SCRATCH, `run-${String(++runCount)}`);
  const home = join(dir, 'home');
  const runnerTemp = join(dir, 'runner-temp');
  const checkout = join(dir, 'checkout');
  const tmp = join(dir, 'tmp');
  for (const d of [home, runnerTemp, checkout, tmp]) mkdirSync(d, { recursive: true });
  const baseSha = makeCheckout(checkout, home);
  const logs = {
    FAKE_CURL_LOG: join(dir, 'curl.log'),
    FAKE_SHA_LOG: join(dir, 'sha.log'),
    FAKE_SLEEP_LOG: join(dir, 'sleep.log'),
    FAKE_OASDIFF_LOG: join(dir, 'oasdiff.log'),
    FAKE_PNPM_LOG: join(dir, 'pnpm.log'),
    FAKE_TAMPERED_MARK: join(dir, 'tampered-ran'),
  };
  const sh = shape();
  const hit = sc.cache !== 'none';
  const base: Record<string, string> = {
    'runner.temp': runnerTemp,
    'runner.os': 'Linux',
    'runner.arch': 'X64',
    'github.event_name': 'pull_request',
    'github.workspace': checkout,
    'github.sha': HEAD_SHA,
    'github.ref': 'refs/pull/7/merge',
    'github.repository': 'o/r',
    'github.event.pull_request.base.sha': baseSha,
    'github.event.pull_request.head.sha': HEAD_SHA,
    'needs.contracts-detect.outputs.changed': 'true',
    'needs.contracts-detect.outputs.base': baseSha,
  };
  // The published checksum of this scenario is the one of the good fixture archive.
  const globalEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(globalEnvRaw())) globalEnv[k] = expand(v, base);
  if ('OASDIFF_SHA256' in globalEnv) globalEnv['OASDIFF_SHA256'] = GOOD_SHA;
  const values: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(globalEnv)) values[`env.${k}`] = v;
  values['env.OASDIFF_SHA256'] = GOOD_SHA;
  let cachePath: string | null = null;
  if (sh.cache !== null) {
    const cacheValues: Record<string, string> = { ...values };
    for (const [k, v] of Object.entries(sh.cache.env)) cacheValues[`env.${k}`] = expand(v, values);
    cacheValues['env.OASDIFF_SHA256'] = GOOD_SHA;
    const key = expand(withInput(sh.cache, 'key') ?? '', cacheValues);
    if (sh.cache.id !== null) {
      const outputs = `steps.${sh.cache.id}.outputs`;
      values[`${outputs}.cache-hit`] = hit ? 'true' : '';
      values[`${outputs}.cache-primary-key`] = key;
      values[`${outputs}.cache-matched-key`] = hit ? key : '';
    }
    const raw = withInput(sh.cache, 'path');
    if (raw !== null) cachePath = expandHome(expand(raw.trim(), cacheValues), home);
  }
  if (hit) {
    expect(cachePath, 'the cache step has a path to restore the archive to').not.toBeNull();
    const target = cachePath ?? '';
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(sc.cache === 'good' ? GOOD_ARCHIVE : BAD_ARCHIVE));
  }
  let status: number | null = 0;
  let out = '';
  const ran: string[] = [];
  const githubEnv: Record<string, string> = {};
  const githubPath: string[] = [];
  for (const s of sh.all) {
    if (s.run === null) continue;
    if (s.if !== null) throw new Error(`run step ${String(s.name)} has an if: (${s.if})`);
    const files = {
      GITHUB_OUTPUT: join(dir, `output-${String(s.index)}`),
      GITHUB_ENV: join(dir, `env-${String(s.index)}`),
      GITHUB_PATH: join(dir, `path-${String(s.index)}`),
      GITHUB_STEP_SUMMARY: join(dir, `summary-${String(s.index)}`),
    };
    for (const f of Object.values(files)) writeFileSync(f, '');
    const stepEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env)) stepEnv[k] = expand(v, values);
    if ('OASDIFF_SHA256' in stepEnv) stepEnv['OASDIFF_SHA256'] = GOOD_SHA;
    const res = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', expand(s.run, values)],
      {
        cwd: checkout,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: [BIN, ...githubPath, process.env['PATH'] ?? ''].join(':'),
          HOME: home,
          TMPDIR: tmp,
          CI: 'true',
          GIT_CONFIG_NOSYSTEM: '1',
          GITHUB_ACTIONS: 'true',
          GITHUB_WORKSPACE: checkout,
          GITHUB_EVENT_NAME: 'pull_request',
          RUNNER_TEMP: runnerTemp,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
          ...files,
          ...globalEnv,
          ...githubEnv,
          ...stepEnv,
          ...logs,
          FAKE_CURL_MODE: sc.curl,
          FAKE_CURL_GOOD: GOOD_ARCHIVE,
          FAKE_CURL_BAD: BAD_ARCHIVE,
          FAKE_OASDIFF_BREAKING: sc.breaking === true ? '1' : '0',
        },
      },
    );
    out += `--- ${String(s.name)} (exit ${String(res.status)})\n${res.stdout}\n${res.stderr}\n`;
    ran.push(s.name ?? `#${String(s.index)}`);
    status = res.status;
    if (status !== 0) break;
    Object.assign(githubEnv, githubEnvEntries(files.GITHUB_ENV));
    githubPath.unshift(...readLines(files.GITHUB_PATH).reverse());
  }
  const checks: ShaCheck[] = [];
  for (const l of readLines(logs.FAKE_SHA_LOG)) {
    checks.push(...(JSON.parse(l) as { checked: ShaCheck[] }).checked);
  }
  return {
    status,
    out,
    ran,
    curl: readLines(logs.FAKE_CURL_LOG).map((l) => JSON.parse(l) as string[]),
    checks,
    oasdiff: readLines(logs.FAKE_OASDIFF_LOG),
    pnpm: readLines(logs.FAKE_PNPM_LOG),
    tampered: existsSync(logs.FAKE_TAMPERED_MARK),
    runnerTemp,
    cachePath,
  };
}

/** The comparison the unpacked oasdiff was asked for, as the step has always run it. */
function expectedBreaking(r: JobRun): string {
  return [
    'breaking --fail-on ERR --err-ignore contracts/oasdiff-accepted.txt',
    join(r.runnerTemp, 'base-openapi.json'),
    'contracts/openapi.yaml',
  ].join(' ');
}

function compared(r: JobRun): string[] {
  return r.oasdiff.filter((l) => l.startsWith('breaking'));
}

/** Long options with their value, and the letters of short flags, of one curl argv. */
function curlOptions(argv: string[]): { long: Map<string, string | true>; short: Set<string> } {
  const VALUED = new Set([
    '--retry',
    '--retry-delay',
    '--retry-max-time',
    '--max-time',
    '--connect-timeout',
    '--output',
    '--output-dir',
    '--user-agent',
    '--header',
    '--speed-limit',
    '--speed-time',
  ]);
  const VALUED_SHORT = new Set(['o', 'm', 'H', 'A', 'y', 'Y']);
  const long = new Map<string, string | true>();
  const short = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      if (VALUED.has(a)) long.set(a, argv[++i] ?? '');
      else long.set(a, true);
    } else if (/^-[A-Za-z]+$/.test(a)) {
      for (const [j, ch] of [...a.slice(1)].entries()) {
        short.add(ch);
        if (VALUED_SHORT.has(ch)) {
          if (j === a.length - 2) i++;
          break;
        }
      }
    }
  }
  return { long, short };
}

function numberOption(long: Map<string, string | true>, name: string): number {
  const v = long.get(name);
  expect(typeof v, `curl is given ${name} <n>`).toBe('string');
  const n = Number(v);
  expect(Number.isFinite(n), `${name} ${String(v)} is a number`).toBe(true);
  return n;
}

// --- 1. the cache --------------------------------------------------------------------------------

it('[CT-06zzzzk] a cache step before the oasdiff install, pinned to the same actions/cache SHA as ci.yml, keyed by the oasdiff version and sha256, caching the release archive only, no restore-keys, no if:', () => {
  const sh = shape();
  const cache = requireCache(sh);
  const ciShas = ciCacheShas();
  expect(ciShas, 'ci.yml pins actions/cache to one SHA').toHaveLength(1);
  const pin = CACHE_USES.exec(cache.uses ?? '')?.[2];
  expect(pin, 'the cache step is pinned to the SHA ci.yml uses').toBe(ciShas[0]);
  expect(cache.index, 'the cache is restored before the install').toBeLessThan(
    Math.min(...sh.install.map((s) => s.index)),
  );
  expect(cache.if, 'the restore always runs').toBeNull();
  expect(cache.continueOnError, 'a failed restore is not swallowed').toBeNull();
  expect(withInput(cache, 'restore-keys'), 'no partial (prefix) restore').toBeNull();
  // The key holds both pinned values, as the install reads them.
  const { version, sha } = pinnedRelease(sh);
  const values: Record<string, string> = {
    'runner.os': 'Linux',
    'runner.arch': 'X64',
    'github.workspace': '/workspace',
  };
  for (const [k, v] of Object.entries({ ...globalEnvRaw(), ...cache.env })) {
    values[`env.${k}`] = v;
  }
  const keyRaw = withInput(cache, 'key');
  expect(keyRaw, 'the cache step has a key').not.toBeNull();
  const key = expand(keyRaw ?? '', values);
  expect(key, 'the cache key holds the oasdiff version').toContain(version);
  expect(key, 'the cache key holds the sha256 of the release archive').toContain(sha);
  // The cached path is the archive itself: one path, a .tar.gz, nothing left for a shell to expand.
  const pathRaw = withInput(cache, 'path') ?? '';
  const paths = pathRaw.split('\n').filter((l) => l.trim() !== '');
  expect(paths, 'the cache step caches exactly one path').toHaveLength(1);
  const path = expand(paths[0] ?? '', { ...values, 'runner.temp': '/runner-temp' });
  expect(path, 'the cached path is the release archive').toMatch(/\.tar\.gz$/);
  expect(path, 'actions/cache does not expand shell variables in path').not.toContain('$');
  // A restore / save pair: the save uses the same pin, key and path, after the install,
  // and never on a failed job.
  if (/^actions\/cache\/restore@/.test(cache.uses ?? '')) {
    expect(sh.save, 'actions/cache/restore is paired with actions/cache/save').not.toBeNull();
    const save = sh.save as Step;
    expect(SAVE_USES.exec(save.uses ?? '')?.[1]).toBe(ciShas[0]);
    expect(withInput(save, 'key')).toBe(keyRaw);
    expect(withInput(save, 'path')).toBe(withInput(cache, 'path'));
    expect(save.index).toBeGreaterThan(Math.max(...sh.install.map((s) => s.index)));
    expect(save.if ?? '', 'the save never runs on a failed job').not.toMatch(
      /always\s*\(|failure\s*\(|cancelled\s*\(/,
    );
  } else {
    expect(sh.save, 'actions/cache saves by itself; no extra save step').toBeNull();
  }
});

// --- 2. every source is verified -----------------------------------------------------------------

it('[CT-06zzzzk] cache hit with the right archive: no download, sha256sum -c passes on it, oasdiff is unpacked and the comparison runs against the base', () => {
  const r = runJob({ cache: 'good', curl: 'fail' });
  expect(r.status, r.out).toBe(0);
  expect(r.curl, 'a cache hit downloads nothing').toEqual([]);
  expect(
    r.checks.some((c) => c.ok && c.actual === GOOD_SHA),
    `sha256sum -c checked the cached archive\n${r.out}`,
  ).toBe(true);
  expect(r.checks.every((c) => c.ok)).toBe(true);
  const bin = join(r.runnerTemp, 'oasdiff', 'oasdiff');
  expect(existsSync(bin), 'oasdiff is unpacked where the comparison runs it').toBe(true);
  expect(readFileSync(bin, 'utf8')).toBe(FAKE_OASDIFF);
  expect(r.tampered).toBe(false);
  expect(r.ran.includes(BREAKING_NAME), r.out).toBe(true);
  expect(compared(r), r.out).toEqual([expectedBreaking(r)]);
});

it('[CT-06zzzzk] cache hit with a tampered archive: the job fails, the tampered binary never runs, no silent re-download to green', () => {
  // The fake curl would serve the good archive: a re-download after the failed check is the
  // behaviour this test rules out (the job must fail on the bad cache, not turn green).
  const r = runJob({ cache: 'bad', curl: 'ok' });
  expect(r.status, r.out).not.toBe(0);
  expect(r.status, r.out).not.toBeNull();
  expect(
    r.checks.some((c) => !c.ok),
    `sha256sum -c rejected the cached archive\n${r.out}`,
  ).toBe(true);
  expect(r.curl, 'no re-download after a failed check of the cached archive').toEqual([]);
  expect(r.tampered, 'the tampered binary was never run').toBe(false);
  expect(compared(r), 'no comparison reported after a failed check').toEqual([]);
  expect(r.ran.includes(BREAKING_NAME), r.out).toBe(false);
});

it('[CT-06zzzzk] cache miss: curl downloads the pinned release, sha256sum -c passes, the verified archive is left at the cache path, the comparison runs', () => {
  const sh = shape();
  const { version } = pinnedRelease(sh);
  const r = runJob({ cache: 'none', curl: 'ok' });
  expect(r.status, r.out).toBe(0);
  expect(r.curl.length, 'a cache miss downloads').toBeGreaterThanOrEqual(1);
  const url = `https://github.com/oasdiff/oasdiff/releases/download/v${version}/oasdiff_${version}_linux_amd64.tar.gz`;
  expect(
    r.curl.every((argv) => argv.includes(url)),
    `curl fetches the pinned release\n${JSON.stringify(r.curl)}`,
  ).toBe(true);
  expect(
    r.checks.some((c) => c.ok && c.actual === GOOD_SHA),
    `sha256sum -c checked the download\n${r.out}`,
  ).toBe(true);
  expect(r.checks.every((c) => c.ok)).toBe(true);
  expect(r.cachePath, 'the cache step has a path').not.toBeNull();
  const cached = r.cachePath ?? '';
  expect(existsSync(cached), 'the downloaded archive is where the cache saves it').toBe(true);
  expect(sha256(cached), 'what the cache saves is the verified archive').toBe(GOOD_SHA);
  const bin = join(r.runnerTemp, 'oasdiff', 'oasdiff');
  expect(existsSync(bin), 'oasdiff is unpacked where the comparison runs it').toBe(true);
  expect(readFileSync(bin, 'utf8')).toBe(FAKE_OASDIFF);
  expect(r.pnpm, 'the lint and drift checks still run first').toEqual([
    'install --frozen-lockfile',
    'contracts:check',
  ]);
  expect(compared(r), r.out).toEqual([expectedBreaking(r)]);
  // The base copy is written by tools/ci/oasdiff-base.ts, the planned operation left out.
  const baseJson = JSON.parse(
    readFileSync(join(r.runnerTemp, 'base-openapi.json'), 'utf8'),
  ) as Record<string, Record<string, unknown>>;
  expect(Object.keys(baseJson['paths'] ?? {})).toEqual(['/a']);
});

it('[CT-06zzzzk] cache miss with a download that fails the sha256 check: the job fails and the downloaded binary never runs', () => {
  const r = runJob({ cache: 'none', curl: 'bad' });
  expect(r.status, r.out).not.toBe(0);
  expect(r.status, r.out).not.toBeNull();
  expect(r.curl.length).toBeGreaterThanOrEqual(1);
  expect(
    r.checks.some((c) => !c.ok),
    `sha256sum -c rejected the download\n${r.out}`,
  ).toBe(true);
  expect(r.tampered, 'the unverified binary was never run').toBe(false);
  expect(compared(r)).toEqual([]);
  expect(r.ran.includes(BREAKING_NAME), r.out).toBe(false);
});

// --- 3. stronger retries -------------------------------------------------------------------------

it('[CT-06zzzzk] curl retries harder: --retry >= 6, --retry-all-errors, --retry-delay >= 2, --retry-max-time within [60 s, the 15-minute job timeout), --fail and --location', () => {
  const r = runJob({ cache: 'none', curl: 'ok' });
  expect(r.status, r.out).toBe(0);
  expect(r.curl.length, 'a cache miss downloads').toBeGreaterThanOrEqual(1);
  const timeout = Number(scalar(entry(requireJob(JOB), 'timeout-minutes', 4)?.inline ?? ''));
  expect(timeout, 'the job timeout is as before').toBe(JOB_TIMEOUT_MINUTES);
  for (const argv of r.curl) {
    const { long, short } = curlOptions(argv);
    expect(numberOption(long, '--retry'), 'more retries than before').toBeGreaterThanOrEqual(
      MIN_RETRIES,
    );
    expect(
      long.has('--retry-all-errors'),
      `5xx and connection errors are retried\n${JSON.stringify(argv)}`,
    ).toBe(true);
    expect(numberOption(long, '--retry-delay'), 'a pause between attempts').toBeGreaterThanOrEqual(
      MIN_RETRY_DELAY_S,
    );
    const maxTime = numberOption(long, '--retry-max-time');
    expect(maxTime, 'retrying is bounded in time').toBeGreaterThanOrEqual(MIN_RETRY_MAX_TIME_S);
    expect(maxTime, 'the retries end before the job timeout').toBeLessThan(timeout * 60);
    expect(
      long.has('--fail') || long.has('--fail-with-body') || short.has('f'),
      'an HTTP error is a failure',
    ).toBe(true);
    expect(long.has('--location') || short.has('L'), 'release redirects are followed').toBe(true);
  }
});

// --- 4. a failed download is red -----------------------------------------------------------------

it('[CT-06zzzzk] a download that keeps failing: the install exits non-zero, no oasdiff is unpacked, the comparison step never runs', () => {
  const r = runJob({ cache: 'none', curl: 'fail' });
  expect(r.status, r.out).not.toBe(0);
  expect(r.status, r.out).not.toBeNull();
  expect(r.curl.length, 'curl was tried').toBeGreaterThanOrEqual(1);
  expect(existsSync(join(r.runnerTemp, 'oasdiff', 'oasdiff'))).toBe(false);
  expect(r.oasdiff, 'no oasdiff ran').toEqual([]);
  expect(r.ran.includes(BREAKING_NAME), r.out).toBe(false);
  const last = r.ran[r.ran.length - 1] ?? '';
  expect(
    shape().install.some((s) => (s.name ?? `#${String(s.index)}`) === last),
    `the failing step is the install\n${r.out}`,
  ).toBe(true);
});

it('[CT-06zzzzk] nothing skips the comparison or swallows a failure: no if: on the install or comparison steps, the job if: as before, no continue-on-error anywhere', () => {
  const sh = shape();
  for (const s of sh.install) {
    expect(s.if, `install step ${String(s.name)} runs unconditionally`).toBeNull();
  }
  for (const s of sh.pre) expect(s.if, `step ${String(s.run)} runs unconditionally`).toBeNull();
  expect(sh.breaking.if, 'the comparison runs unconditionally').toBeNull();
  expect(sh.breaking.uses).toBeNull();
  const body = requireJob(JOB);
  expect(entry(body, 'if', 4)?.inline, 'the job condition is as before').toBe(
    "needs.contracts-detect.outputs.changed == 'true'",
  );
  expect(entry(body, 'needs', 4)?.inline).toBe('contracts-detect');
  expect(WORKFLOW, 'no continue-on-error in the workflow').not.toMatch(
    /^\s*(-\s+)?continue-on-error\s*:/m,
  );
  for (const s of sh.all) {
    expect(s.continueOnError, `step ${String(s.name)}`).toBeNull();
  }
});

it('[CT-06zzzzk] a breaking change reported by the unpacked oasdiff still fails the job', () => {
  const r = runJob({ cache: 'good', curl: 'fail', breaking: true });
  expect(r.status, r.out).not.toBe(0);
  expect(r.status, r.out).not.toBeNull();
  expect(r.ran[r.ran.length - 1], r.out).toBe(BREAKING_NAME);
  expect(compared(r), r.out).toEqual([expectedBreaking(r)]);
});

// --- 5. nothing is relaxed -----------------------------------------------------------------------

it('[CT-06zzzzk] the comparison is not relaxed: the comparison step verbatim and last, the lint and drift steps as before, checkout with the full history', () => {
  const sh = shape();
  expect(sh.breaking.run).toBe(BREAKING_RUN);
  expect(sh.breaking.env).toEqual(BREAKING_ENV);
  expect(sh.breaking.index, 'the comparison comes after the install').toBeGreaterThan(
    Math.max(...sh.install.map((s) => s.index)),
  );
  expect(
    sh.all.filter((s) => s.index > sh.breaking.index && s.run !== null),
    'no run step after the comparison',
  ).toEqual([]);
  expect(sh.pre.map((s) => s.run)).toEqual(PRE_RUNS);
  for (const s of sh.pre) expect(s.env).toEqual({});
  const checkout = sh.all.find((s) => /^actions\/checkout@[0-9a-f]{40}$/.test(s.uses ?? ''));
  expect(checkout, 'the job checks out the repository').toBeDefined();
  expect(withInput(checkout as Step, 'fetch-depth'), 'the full history is fetched').toBe('0');
  expect(withInput(checkout as Step, 'persist-credentials')).toBe('false');
  expect((checkout as Step).index).toBeLessThan(sh.breaking.index);
  const body = requireJob(JOB);
  expect(entry(body, 'permissions', 4), 'no job-level permissions').toBeNull();
  expect(scalar(entry(body, 'runs-on', 4)?.inline ?? '')).toBe('ubuntu-latest');
});

it('[CT-06zzzzk] contracts-detect and contracts-gate decide as before', () => {
  // contracts-detect
  const detectBody = requireJob('contracts-detect');
  expect(entry(detectBody, 'if', 4), 'contracts-detect always runs').toBeNull();
  expect(entry(detectBody, 'needs', 4)).toBeNull();
  expect(significant(entry(detectBody, 'outputs', 4))).toEqual(DETECT_OUTPUTS);
  const detect = steps('contracts-detect').filter((s) => s.run !== null);
  expect(detect).toHaveLength(1);
  const diff = detect[0] as Step;
  expect(diff.id).toBe('diff');
  expect(diff.if).toBeNull();
  expect(diff.run).toBe(DETECT_RUN);
  expect(diff.env).toEqual(DETECT_ENV);
  const detectCheckout = steps('contracts-detect').find((s) =>
    /^actions\/checkout@[0-9a-f]{40}$/.test(s.uses ?? ''),
  );
  expect(detectCheckout, 'contracts-detect checks out the repository').toBeDefined();
  expect(withInput(detectCheckout as Step, 'fetch-depth')).toBe('0');
  // contracts-gate
  const gateBody = requireJob('contracts-gate');
  expect(entry(gateBody, 'if', 4)?.inline).toBe('always()');
  expect(entry(gateBody, 'needs', 4)?.inline).toBe('[contracts-detect, contracts-check]');
  const gate = steps('contracts-gate');
  expect(gate).toHaveLength(1);
  const summarise = gate[0] as Step;
  expect(summarise.name).toBe('Summarise');
  expect(summarise.if).toBeNull();
  expect(summarise.run).toBe(GATE_RUN);
  expect(summarise.env).toEqual(GATE_ENV);
  // contracts-gate stays the required check (ops/branch-protection.json).
  expect(readFileSync(join(REPO, 'ops/branch-protection.json'), 'utf8')).toContain(
    '"context": "contracts-gate"',
  );
});

it('[CT-06zzzzk] triggers, permissions, concurrency and the pinned oasdiff release as before', () => {
  const on = entry(LINES, 'on', 0);
  expect(on?.inline).toBe('');
  expect(significant(on)).toEqual(['  pull_request:', '  push:', '    branches: [main]']);
  const permissions = entry(LINES, 'permissions', 0);
  expect(permissions?.inline).toBe('');
  expect(significant(permissions)).toEqual(['  contents: read']);
  for (const job of ['contracts-detect', 'contracts-check', 'contracts-gate']) {
    expect(entry(requireJob(job), 'permissions', 4), `no permissions on ${job}`).toBeNull();
  }
  const concurrency = entry(LINES, 'concurrency', 0);
  expect(concurrency?.inline).toBe('');
  expect(significant(concurrency)).toEqual([
    "  group: contracts-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
  ]);
  const sh = shape();
  const { version, sha } = pinnedRelease(sh);
  expect(version).toBe(PINNED_VERSION);
  expect(sha.startsWith(PINNED_SHA_HEAD) && sha.endsWith(PINNED_SHA_TAIL)).toBe(true);
  // The install reads the checksum from the env, so the value above is the one it verifies with.
  for (const s of sh.install) expect(s.run ?? '').not.toContain(sha);
  expect(sh.install.some((s) => (s.run ?? '').includes('OASDIFF_SHA256'))).toBe(true);
  expect(
    sh.install.some((s) => /sha256sum\s+(-c|--check)\b/.test(s.run ?? '')),
    'the install checks the archive with sha256sum -c',
  ).toBe(true);
});

// --- 6. the workflow rules still hold ------------------------------------------------------------

it('[CT-06zzzzk] check-workflows reports no problem for the workflows as they are', () => {
  expect(checkWorkflows(REPO)).toEqual([]);
});
