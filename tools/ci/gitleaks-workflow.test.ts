// CT-06zzzzh (FU-GITLEAKS-DOWNLOAD-RETRY, D10-1044 ④): the install of the gitleaks binary in
// .github/workflows/gitleaks.yml, read from the real file. Two gitleaks runs within an hour went
// red on a curl 504 while downloading the release; the install is to be cached (actions/cache,
// pinned to the same SHA as ci.yml, keyed by the gitleaks version and the sha256 of the release
// archive) and the download retried harder, without relaxing anything:
//
// - the cached path is the release archive itself, so whatever its source (cache or download) it
//   is checked with `sha256sum -c` against GITLEAKS_SHA256 before it is unpacked;
// - a cached archive that fails the check fails the job (no silent re-download to green);
// - a download that keeps failing fails the job; nothing (if:, continue-on-error) lets the scan
//   be skipped while the job stays green;
// - the Scan step, the triggers, the permissions and the checkout depth are as before.
//
// The run steps of the job are extracted from the YAML and executed with bash, in order, with
// every `${{ <expression> }}` replaced by a value chosen per scenario, and with a fake `curl`, a
// fake `sha256sum` (node crypto; macOS has none in every version) and a fake `sleep` first on
// PATH. The fake curl serves a small release archive built here (a `gitleaks` shell script that
// logs its arguments), or a tampered one, or fails like a 504. The cache step itself is simulated:
// a hit puts an archive at the expanded cache `path` and sets `cache-hit` to 'true'.
// The YAML helpers are line-based (no YAML dependency), as in ci-ledger-only-workflow.test.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkWorkflows } from './check-workflows.ts';

const REPO = resolve(import.meta.dirname, '../..');
const WORKFLOW = readFileSync(join(REPO, '.github/workflows/gitleaks.yml'), 'utf8');
const LINES = WORKFLOW.split('\n');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const SCRATCH = join(REPO, '.tmp', `gitleaks-workflow-${process.pid}`);

const JOB = 'gitleaks';
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'a'.repeat(40);
/** Lower bounds fixed for the implementation (see the handback of CT-06zzzzh). */
const MIN_RETRIES = 6;
const MIN_RETRY_DELAY_S = 2;
const MIN_RETRY_MAX_TIME_S = 60;
/** The pinned release must not change with this task (D10-1044 ④: sha256 unchanged). */
const PINNED_VERSION = '8.30.1';
const PINNED_SHA_HEAD = '551f6fc83ea4';
const PINNED_SHA_TAIL = 'f2470eb';

/** The Scan step as it was before CT-06zzzzh, verbatim (the block scalar, de-indented). */
const SCAN_RUN = [
  'set -euo pipefail',
  'if [ "$EVENT" = pull_request ]; then',
  '  echo "scanning commits ${PR_BASE_SHA}..${PR_HEAD_SHA}"',
  '  "$RUNNER_TEMP/gitleaks/gitleaks" git --config .gitleaks.toml --redact --no-banner \\',
  '    --log-opts="${PR_BASE_SHA}..${PR_HEAD_SHA}"',
  'else',
  '  echo "scanning the full history"',
  '  "$RUNNER_TEMP/gitleaks/gitleaks" git --config .gitleaks.toml --redact --no-banner',
  'fi',
].join('\n');
const SCAN_ENV = {
  EVENT: '${{ github.event_name }}',
  PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
  PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
};
const SCAN_ARGS = 'git --config .gitleaks.toml --redact --no-banner';

// --- line-based YAML helpers (as in ci-ledger-only-workflow.test.ts) ----------------------------

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
  expect(body, `gitleaks.yml has a job \`${id}\``).not.toBeNull();
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

/** The steps of the job, each a small record of the keys this test needs. */
function steps(): Step[] {
  const body = requireJob(JOB);
  const at = body.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  expect(at, `job \`${JOB}\` has steps`).toBeGreaterThanOrEqual(0);
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

// --- the shape of the job ----------------------------------------------------------------------

const CACHE_USES = /^actions\/cache(\/restore)?@([0-9a-f]{40})$/;
const SAVE_USES = /^actions\/cache\/save@([0-9a-f]{40})$/;

type Shape = {
  all: Step[];
  scan: Step;
  cache: Step | null;
  save: Step | null;
  /** The run steps before Scan: the install of the binary. */
  install: Step[];
};

function shape(): Shape {
  const all = steps();
  const scans = all.filter((s) => s.name === 'Scan');
  expect(scans.length, 'gitleaks.yml has exactly one step named Scan').toBe(1);
  const scan = scans[0] as Step;
  const install = all.filter((s) => s.index < scan.index && s.run !== null);
  expect(install.length, 'a run step before Scan installs gitleaks').toBeGreaterThanOrEqual(1);
  const cache = all.find((s) => s.uses !== null && CACHE_USES.test(s.uses)) ?? null;
  const save = all.find((s) => s.uses !== null && SAVE_USES.test(s.uses)) ?? null;
  return { all, scan, cache, save, install };
}

function requireCache(sh: Shape): Step {
  expect(
    sh.cache,
    'gitleaks.yml has an actions/cache (or actions/cache/restore) step for the release archive',
  ).not.toBeNull();
  return sh.cache as Step;
}

/** workflow env + job env, raw. */
function globalEnvRaw(): Record<string, string> {
  return { ...mapping(entry(LINES, 'env', 0)), ...mapping(entry(requireJob(JOB), 'env', 4)) };
}

/** The env the install sees, unexpanded: GITLEAKS_VERSION / GITLEAKS_SHA256 as written. */
function pinnedRelease(sh: Shape): { version: string; sha: string } {
  const env: Record<string, string> = { ...globalEnvRaw() };
  for (const s of sh.install) Object.assign(env, s.env);
  const version = env['GITLEAKS_VERSION'] ?? '';
  const sha = env['GITLEAKS_SHA256'] ?? '';
  expect(version, 'GITLEAKS_VERSION is set as a literal in an env block').toMatch(
    /^\d+\.\d+\.\d+$/,
  );
  expect(sha, 'GITLEAKS_SHA256 is set as a literal in an env block').toMatch(/^[0-9a-f]{64}$/);
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

const FAKE_GITLEAKS = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$FAKE_GITLEAKS_LOG"',
  'if [ "$1" = version ]; then echo "fake"; fi',
  'exit 0',
  '',
].join('\n');
const TAMPERED_GITLEAKS = [
  '#!/bin/sh',
  ': > "$FAKE_TAMPERED_MARK"',
  'printf \'%s\\n\' "$*" >> "$FAKE_GITLEAKS_LOG"',
  'if [ "$1" = version ]; then echo "tampered"; fi',
  'exit 0',
  '',
].join('\n');

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
  writeFileSync(join(src, 'gitleaks'), script);
  chmodSync(join(src, 'gitleaks'), 0o755);
  writeFileSync(join(src, 'README.md'), `# ${name}\n`);
  const archive = join(SCRATCH, 'fixtures', `${name}.tar.gz`);
  const res = spawnSync('tar', ['-czf', archive, '-C', src, 'gitleaks', 'README.md'], {
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

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  BIN = join(SCRATCH, 'bin');
  mkdirSync(BIN, { recursive: true });
  writeNodeTool('curl', FAKE_CURL);
  writeNodeTool('sha256sum', FAKE_SHA256SUM);
  writeFileSync(
    join(BIN, 'sleep'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_SLEEP_LOG"\nexit 0\n`,
  );
  chmodSync(join(BIN, 'sleep'), 0o755);
  GOOD_ARCHIVE = buildArchive('good', FAKE_GITLEAKS);
  BAD_ARCHIVE = buildArchive('tampered', TAMPERED_GITLEAKS);
  GOOD_SHA = sha256(GOOD_ARCHIVE);
  expect(sha256(BAD_ARCHIVE)).not.toBe(GOOD_SHA);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// --- running the job -----------------------------------------------------------------------------

type Scenario = {
  event: 'pull_request' | 'push';
  /** What the cache restores: nothing (miss), the good archive or a tampered one (hit). */
  cache: 'none' | 'good' | 'bad';
  curl: 'ok' | 'bad' | 'fail';
};

type ShaCheck = { file: string; expected: string; actual: string | null; ok: boolean };

type JobRun = {
  status: number | null;
  out: string;
  ran: string[];
  curl: string[][];
  checks: ShaCheck[];
  gitleaks: string[];
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

/** Runs every run step of the job in order, as the runner would, against the fakes. */
function runJob(sc: Scenario): JobRun {
  const dir = join(SCRATCH, `run-${String(++runCount)}`);
  const home = join(dir, 'home');
  const runnerTemp = join(dir, 'runner-temp');
  const checkout = join(dir, 'checkout');
  const tmp = join(dir, 'tmp');
  for (const d of [home, runnerTemp, checkout, tmp]) mkdirSync(d, { recursive: true });
  const logs = {
    FAKE_CURL_LOG: join(dir, 'curl.log'),
    FAKE_SHA_LOG: join(dir, 'sha.log'),
    FAKE_SLEEP_LOG: join(dir, 'sleep.log'),
    FAKE_GITLEAKS_LOG: join(dir, 'gitleaks.log'),
    FAKE_TAMPERED_MARK: join(dir, 'tampered-ran'),
  };
  const sh = shape();
  const hit = sc.cache !== 'none';
  const base: Record<string, string> = {
    'runner.temp': runnerTemp,
    'runner.os': 'Linux',
    'runner.arch': 'X64',
    'github.event_name': sc.event,
    'github.workspace': checkout,
    'github.sha': HEAD_SHA,
    'github.ref': sc.event === 'pull_request' ? 'refs/pull/7/merge' : 'refs/heads/main',
    'github.repository': 'o/r',
    'github.event.pull_request.base.sha': sc.event === 'pull_request' ? BASE_SHA : '',
    'github.event.pull_request.head.sha': sc.event === 'pull_request' ? HEAD_SHA : '',
  };
  // The published checksum of this scenario is the one of the good fixture archive.
  const globalEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(globalEnvRaw())) globalEnv[k] = expand(v, base);
  if ('GITLEAKS_SHA256' in globalEnv) globalEnv['GITLEAKS_SHA256'] = GOOD_SHA;
  const values: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(globalEnv)) values[`env.${k}`] = v;
  values['env.GITLEAKS_SHA256'] = GOOD_SHA;
  let cachePath: string | null = null;
  if (sh.cache !== null) {
    const cacheValues: Record<string, string> = { ...values };
    for (const [k, v] of Object.entries(sh.cache.env)) cacheValues[`env.${k}`] = expand(v, values);
    cacheValues['env.GITLEAKS_SHA256'] = GOOD_SHA;
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
    if ('GITLEAKS_SHA256' in stepEnv) stepEnv['GITLEAKS_SHA256'] = GOOD_SHA;
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
          GITHUB_ACTIONS: 'true',
          GITHUB_WORKSPACE: checkout,
          GITHUB_EVENT_NAME: sc.event,
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
    gitleaks: readLines(logs.FAKE_GITLEAKS_LOG),
    tampered: existsSync(logs.FAKE_TAMPERED_MARK),
    runnerTemp,
    cachePath,
  };
}

function scanned(r: JobRun): string[] {
  return r.gitleaks.filter((l) => l.startsWith(SCAN_ARGS));
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

it('[CT-06zzzzh] a cache step before the install, pinned to the same actions/cache SHA as ci.yml, keyed by the gitleaks version and sha256, caching the release archive', () => {
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
  expect(key, 'the cache key holds the gitleaks version').toContain(version);
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

it('[CT-06zzzzh] cache hit with the right archive: no download, sha256sum -c passes on it, gitleaks is unpacked and the PR range is scanned', () => {
  const r = runJob({ event: 'pull_request', cache: 'good', curl: 'fail' });
  expect(r.status, r.out).toBe(0);
  expect(r.curl, 'a cache hit downloads nothing').toEqual([]);
  expect(
    r.checks.some((c) => c.ok && c.actual === GOOD_SHA),
    `sha256sum -c checked the cached archive\n${r.out}`,
  ).toBe(true);
  expect(r.checks.every((c) => c.ok)).toBe(true);
  const bin = join(r.runnerTemp, 'gitleaks', 'gitleaks');
  expect(existsSync(bin), 'gitleaks is unpacked where Scan runs it').toBe(true);
  expect(readFileSync(bin, 'utf8')).toBe(FAKE_GITLEAKS);
  expect(r.tampered).toBe(false);
  expect(scanned(r), r.out).toEqual([`${SCAN_ARGS} --log-opts=${BASE_SHA}..${HEAD_SHA}`]);
});

it('[CT-06zzzzh] cache hit with a tampered archive: the job fails, the tampered binary never runs, no silent re-download to green', () => {
  // The fake curl would serve the good archive: a re-download after the failed check is the
  // behaviour this test rules out (the job must fail on the bad cache, not turn green).
  const r = runJob({ event: 'push', cache: 'bad', curl: 'ok' });
  expect(r.status, r.out).not.toBe(0);
  expect(r.status, r.out).not.toBeNull();
  expect(
    r.checks.some((c) => !c.ok),
    `sha256sum -c rejected the cached archive\n${r.out}`,
  ).toBe(true);
  expect(r.tampered, 'the tampered binary was never run').toBe(false);
  expect(scanned(r), 'no scan reported after a failed check').toEqual([]);
  expect(r.ran.includes('Scan'), r.out).toBe(false);
});

it('[CT-06zzzzh] cache miss: curl downloads the pinned release, sha256sum -c passes, the verified archive is left at the cache path, the full history is scanned', () => {
  const sh = shape();
  const { version } = pinnedRelease(sh);
  const r = runJob({ event: 'push', cache: 'none', curl: 'ok' });
  expect(r.status, r.out).toBe(0);
  expect(r.curl.length, 'a cache miss downloads').toBeGreaterThanOrEqual(1);
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz`;
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
  const bin = join(r.runnerTemp, 'gitleaks', 'gitleaks');
  expect(existsSync(bin), 'gitleaks is unpacked where Scan runs it').toBe(true);
  expect(readFileSync(bin, 'utf8')).toBe(FAKE_GITLEAKS);
  expect(scanned(r), r.out).toEqual([SCAN_ARGS]);
});

it('[CT-06zzzzh] cache miss with a download that fails the sha256 check: the job fails and the downloaded binary never runs', () => {
  const r = runJob({ event: 'push', cache: 'none', curl: 'bad' });
  expect(r.status, r.out).not.toBe(0);
  expect(r.status, r.out).not.toBeNull();
  expect(r.curl.length).toBeGreaterThanOrEqual(1);
  expect(
    r.checks.some((c) => !c.ok),
    `sha256sum -c rejected the download\n${r.out}`,
  ).toBe(true);
  expect(r.tampered, 'the unverified binary was never run').toBe(false);
  expect(scanned(r)).toEqual([]);
});

// --- 3. stronger retries -------------------------------------------------------------------------

it('[CT-06zzzzh] curl retries harder: --retry >= 6, --retry-all-errors (or --retry-connrefused), --retry-delay >= 2, --retry-max-time within [60 s, the job timeout), --fail and --location', () => {
  const r = runJob({ event: 'push', cache: 'none', curl: 'ok' });
  expect(r.status, r.out).toBe(0);
  expect(r.curl.length, 'a cache miss downloads').toBeGreaterThanOrEqual(1);
  const timeout = Number(scalar(entry(requireJob(JOB), 'timeout-minutes', 4)?.inline ?? ''));
  expect(timeout, 'the job keeps a timeout-minutes').toBeGreaterThan(0);
  for (const argv of r.curl) {
    const { long, short } = curlOptions(argv);
    expect(numberOption(long, '--retry'), 'more retries than before').toBeGreaterThanOrEqual(
      MIN_RETRIES,
    );
    expect(
      long.has('--retry-all-errors') || long.has('--retry-connrefused'),
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

it('[CT-06zzzzh] a download that keeps failing: the install exits non-zero, no gitleaks is unpacked, no scan is reported', () => {
  const r = runJob({ event: 'pull_request', cache: 'none', curl: 'fail' });
  expect(r.status, r.out).not.toBe(0);
  expect(r.status, r.out).not.toBeNull();
  expect(r.curl.length, 'curl was tried').toBeGreaterThanOrEqual(1);
  expect(existsSync(join(r.runnerTemp, 'gitleaks', 'gitleaks'))).toBe(false);
  expect(scanned(r)).toEqual([]);
  expect(r.ran.includes('Scan'), r.out).toBe(false);
});

it('[CT-06zzzzh] nothing skips the scan or swallows a failure: no if: on the install or Scan steps, no continue-on-error, no if: on the job', () => {
  const sh = shape();
  for (const s of sh.install) {
    expect(s.if, `install step ${String(s.name)} runs unconditionally`).toBeNull();
  }
  expect(sh.scan.if, 'Scan runs unconditionally').toBeNull();
  expect(sh.scan.uses).toBeNull();
  const body = requireJob(JOB);
  expect(
    body.filter((l) => /^\s*continue-on-error\s*:/.test(l)),
    'no continue-on-error anywhere in the job',
  ).toEqual([]);
  expect(WORKFLOW).not.toMatch(/^\s*continue-on-error\s*:/m);
  expect(entry(body, 'if', 4), 'the job has no if:').toBeNull();
  for (const s of sh.all) {
    expect(s.continueOnError, `step ${String(s.name)}`).toBeNull();
  }
});

// --- 5. the scan is not relaxed ------------------------------------------------------------------

it('[CT-06zzzzh] the scan is not relaxed: Scan run and env verbatim, triggers, permissions, checkout depth and the pinned release as before', () => {
  const sh = shape();
  expect(sh.scan.run).toBe(SCAN_RUN);
  expect(sh.scan.env).toEqual(SCAN_ENV);
  expect(sh.scan.index, 'Scan comes after the install').toBeGreaterThan(
    Math.max(...sh.install.map((s) => s.index)),
  );
  const on = entry(LINES, 'on', 0);
  expect(on?.inline).toBe('');
  expect(on?.block.filter((l) => !isBlankOrComment(l))).toEqual([
    '  pull_request:',
    '  push:',
    '    branches: [main]',
  ]);
  const permissions = entry(LINES, 'permissions', 0);
  expect(permissions?.inline).toBe('');
  expect(permissions?.block.filter((l) => !isBlankOrComment(l))).toEqual(['  contents: read']);
  const body = requireJob(JOB);
  expect(entry(body, 'permissions', 4), 'no job-level permissions').toBeNull();
  expect(scalar(entry(body, 'runs-on', 4)?.inline ?? '')).toBe('ubuntu-latest');
  const checkout = sh.all.find((s) => /^actions\/checkout@[0-9a-f]{40}$/.test(s.uses ?? ''));
  expect(checkout, 'the job checks out the repository').toBeDefined();
  expect(withInput(checkout as Step, 'fetch-depth'), 'the full history is fetched').toBe('0');
  expect(withInput(checkout as Step, 'persist-credentials')).toBe('false');
  expect((checkout as Step).index).toBeLessThan(sh.scan.index);
  const { version, sha } = pinnedRelease(sh);
  expect(version).toBe(PINNED_VERSION);
  expect(sha.startsWith(PINNED_SHA_HEAD) && sha.endsWith(PINNED_SHA_TAIL)).toBe(true);
  // The install reads the checksum from the env, so the value above is the one it verifies with.
  for (const s of sh.install) expect(s.run ?? '').not.toContain(sha);
  expect(sh.install.some((s) => (s.run ?? '').includes('GITLEAKS_SHA256'))).toBe(true);
});

// --- 6. the workflow rules still hold ------------------------------------------------------------

it('[CT-06zzzzh] check-workflows reports no problem for the workflows as they are', () => {
  expect(checkWorkflows(REPO)).toEqual([]);
});
