// CT-06zzzzj (FU-CI-LABEL-RUN-STALE-HEAD, D10-1027 ④ / D10-1046 ②): a label run of
// .github/workflows/ci.yml whose pull request gets a new head while verify-reuse waits for the
// run of the old head ends early, instead of running the heavy jobs in full on the old head.
// Read from the real file.
//
// Pinned here:
//   1. Head moved. On a labeled / unlabeled event whose pull_request.head.sha is H1, verify-reuse
//      reads `repos/<repo>/pulls/<github.event.pull_request.number>` (its head.sha) between the
//      polls of the wait and once more when the wait is over (also when the wait limit is
//      reached), before it decides. As soon as it reads a head other than H1, the find step (the
//      step that outputs `reuse`) exits non-zero, logs one line with `head moved` and both heads,
//      never outputs reuse=true, and makes no further sleep and no further runs / jobs /
//      artifacts query. Under the outputs the failed job leaves, the fifteen heavy jobs are
//      skipped by their `if:`, and ci-gate fails: red on the old head only.
//   2. Head unchanged. pulls/<number> keeps answering H1: the wait and the reuse decision are
//      exactly those of ci-concurrency-workflow.test.ts.
//   3. The pulls query fails (gh exits non-zero, HTTP 502 or 404). That query counts as "head not
//      moved": the step goes on by the old rule and exits 0 with the old decision; a later query
//      that succeeds still counts.
//   4. A push to main (B2) and the code events never read pulls/<number>; the commits/<sha>/pulls
//      lookup of B2 is another endpoint and is unaffected.
//   5. verify-reuse keeps exactly the three read permissions.
//   6. check-workflows reports nothing; ci-gate passes and fails as before, and is still the
//      required check.
//
// The line-based YAML helpers and the GitHub expression evaluator are copied from
// ci-reuse-push-workflow.test.ts (the status functions follow the steps run so far); the jq subset
// of the fake gh is the one of ci-concurrency-workflow.test.ts. The fake gh adds pulls/<number>,
// whose head becomes H2 once a given number of run-list queries has been answered, and
// commits/<sha>/pulls for the push path. The fake gh and the fake sleep write one event log, so
// the order of the queries and sleeps is known.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkWorkflows } from './check-workflows.ts';

const REPO = resolve(import.meta.dirname, '../..');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const LINES = CI.split('\n');
const SCRATCH = join(REPO, '.tmp', `ci-label-stale-head-workflow-${process.pid}`);

/** The head of the label event (`github.event.pull_request.head.sha`). */
const H1 = 'a'.repeat(40);
/** The head pushed to the pull request while the label run waits. */
const H2 = '2'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const RUN_ID = 9000;
const PR_NUMBER = 7;
const GH_REPO = 'o/r';
const WAIT_VAR = 'REUSE_WAIT_SECONDS';
const POLL_VAR = 'REUSE_POLL_SECONDS';
const VERIFY_JOBS = [
  'verify-static',
  'verify-unit',
  'verify-spec-1',
  'verify-spec-2',
  'verify-props-1',
  'verify-props-2',
  'verify-props-3',
  'verify-props-sha-1',
  'verify-props-sha-2',
  'verify-props-sha-3',
  'verify-int-1',
  'verify-int-2',
  'verify-int-3',
  'verify-int-4',
  'verify-int-5',
  'verify-int-6',
] as const;
/** The fifteen heavy jobs: every verify job but verify-static (verify-int-1 … -6, CT-06zzzzq). */
const HEAVY = VERIFY_JOBS.filter((j) => j !== 'verify-static');

/** While the steps of a job run: whether an earlier step failed (for success() / failure()). */
let PRIOR_FAILED = false;

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
  expect(body, `ci.yml has a job \`${id}\``).not.toBeNull();
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
  const indent = Math.min(...e.block.filter((l) => !isBlankOrComment(l)).map(indentOf));
  for (const l of e.block) {
    if (isBlankOrComment(l) || indentOf(l) !== indent) continue;
    const m = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(l);
    if (m) out[m[1] ?? ''] = scalar(m[2] ?? '');
  }
  return out;
}

/** The `if:` of job `id`, without a `${{ }}` wrapper, whitespace collapsed ('' when none). */
function jobIf(id: string): string {
  const e = entry(requireJob(id), 'if', 4);
  if (e === null) return '';
  const text = value(e).replace(/\s+/g, ' ').trim();
  return expressionOf(text) ?? text;
}

type Step = {
  id: string | null;
  name: string | null;
  uses: string | null;
  run: string | null;
  cond: string | null;
  env: Record<string, string>;
};

/** The steps of a job, each a small record of the keys this test needs. */
function steps(id: string): Step[] {
  const body = requireJob(id);
  const at = body.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  expect(at, `job \`${id}\` has steps`).toBeGreaterThanOrEqual(0);
  const items: string[][] = [];
  for (const line of body.slice(at + 1)) {
    if (/^ {6}- /.test(line)) items.push([line.replace(/^ {6}- /, '        ')]);
    else if (items.length > 0 && (line.trim() === '' || indentOf(line) >= 8)) {
      items[items.length - 1]?.push(line);
    } else if (items.length > 0 && !isBlankOrComment(line) && indentOf(line) <= 4) break;
  }
  return items.map((lines) => {
    const get = (key: string): string | null => {
      const e = entry(lines, key, 8);
      return e === null ? null : value(e);
    };
    return {
      id: get('id'),
      name: get('name'),
      uses: get('uses'),
      run: get('run'),
      cond: get('if'),
      env: mapping(entry(lines, 'env', 8)),
    };
  });
}

/** `${{ expr }}` -> expr, or null when the value is not a single expression. */
function expressionOf(text: string): string | null {
  const m = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(text.trim());
  return m ? (m[1] ?? null) : null;
}

// --- a small evaluator of GitHub Actions expressions -------------------------------------------

type GhValue = null | boolean | number | string | GhValue[] | { [key: string]: GhValue };
type GhTok = { t: 'str' | 'num' | 'id' | 'op'; v: string };

function ghTokenize(src: string): GhTok[] {
  const toks: GhTok[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    if (rest.startsWith("'")) {
      let j = 1;
      let s = '';
      for (;;) {
        if (j >= rest.length) throw new Error(`unterminated string in expression: ${src}`);
        if (rest[j] === "'") {
          if (rest[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += rest[j] ?? '';
        j++;
      }
      toks.push({ t: 'str', v: s });
      i += j + 1;
      continue;
    }
    const num = /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (num) {
      toks.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest);
    if (id) {
      toks.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(?:==|!=|<=|>=|&&|\|\||[!<>()[\].,])/.exec(rest);
    if (op) {
      toks.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(rest[0])} in expression: ${src}`);
  }
  return toks;
}

function ghKind(v: GhValue): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v as 'boolean' | 'number' | 'string';
}

function ghTruthy(v: GhValue): boolean {
  if (v === null || v === false || v === '') return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  return true;
}

function ghNumber(v: GhValue): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v.trim());
  return Number.NaN;
}

function ghEquals(a: GhValue, b: GhValue): boolean {
  const ka = ghKind(a);
  const kb = ghKind(b);
  if (ka === 'array' || ka === 'object' || kb === 'array' || kb === 'object') return a === b;
  if (ka === 'string' && kb === 'string') {
    return (a as string).toLowerCase() === (b as string).toLowerCase();
  }
  if (ka === kb) return a === b;
  return ghNumber(a) === ghNumber(b);
}

function ghCompare(a: GhValue, b: GhValue): number {
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return ghNumber(a) - ghNumber(b);
}

function ghString(v: GhValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return Array.isArray(v) ? 'Array' : 'Object';
}

function ghProp(v: GhValue, key: GhValue): GhValue {
  if (Array.isArray(v)) {
    const n = ghNumber(key);
    return Number.isInteger(n) && n >= 0 && n < v.length ? (v[n] ?? null) : null;
  }
  if (v !== null && typeof v === 'object') {
    const name = ghString(key).toLowerCase();
    const found = Object.keys(v).find((k) => k.toLowerCase() === name);
    return found === undefined ? null : (v[found] ?? null);
  }
  return null;
}

function ghCall(name: string, args: GhValue[]): GhValue {
  const [a = null, b = null] = args;
  switch (name.toLowerCase()) {
    case 'contains':
      if (Array.isArray(a)) return a.some((x) => ghEquals(x, b));
      return ghString(a).toLowerCase().includes(ghString(b).toLowerCase());
    case 'startswith':
      return ghString(a).toLowerCase().startsWith(ghString(b).toLowerCase());
    case 'endswith':
      return ghString(a).toLowerCase().endsWith(ghString(b).toLowerCase());
    case 'format':
      return ghString(a)
        .replace(/\{\{/g, '\u0000')
        .replace(/\}\}/g, '\u0001')
        .replace(/\{(\d+)\}/g, (_, n: string) => ghString(args[Number(n) + 1] ?? null))
        .replace(/\u0000/g, '{')
        .replace(/\u0001/g, '}');
    case 'join':
      return Array.isArray(a) ? a.map(ghString).join(args.length > 1 ? ghString(b) : ',') : a;
    case 'tojson':
      return JSON.stringify(a, null, 2);
    case 'fromjson':
      return JSON.parse(ghString(a)) as GhValue;
    // Status functions: PRIOR_FAILED says whether an earlier step of the job being run failed
    // (false for job-level `if:` values, which are evaluated with no failed need here).
    case 'always':
      return true;
    case 'success':
      return !PRIOR_FAILED;
    case 'failure':
      return PRIOR_FAILED;
    case 'cancelled':
      return false;
    default:
      throw new Error(`the test evaluator does not know the function ${name}()`);
  }
}

/** Evaluates one GitHub expression (the text inside `${{ }}`, or an `if:`) under `ctx`. */
function ghEvaluate(src: string, ctx: Record<string, GhValue>): GhValue {
  const toks = ghTokenize(src);
  let pos = 0;
  const isOp = (v: string): boolean => toks[pos]?.t === 'op' && toks[pos]?.v === v;
  const expectOp = (v: string): void => {
    if (!isOp(v)) throw new Error(`expected ${v} at token ${String(pos)} in expression: ${src}`);
    pos++;
  };
  const or = (): GhValue => {
    let a = and();
    while (isOp('||')) {
      pos++;
      const b = and();
      a = ghTruthy(a) ? a : b;
    }
    return a;
  };
  const and = (): GhValue => {
    let a = eq();
    while (isOp('&&')) {
      pos++;
      const b = eq();
      a = ghTruthy(a) ? b : a;
    }
    return a;
  };
  const eq = (): GhValue => {
    let a = rel();
    while (isOp('==') || isOp('!=')) {
      const op = toks[pos++]?.v;
      const b = rel();
      a = op === '==' ? ghEquals(a, b) : !ghEquals(a, b);
    }
    return a;
  };
  const rel = (): GhValue => {
    let a = unary();
    while (isOp('<') || isOp('<=') || isOp('>') || isOp('>=')) {
      const op = toks[pos++]?.v;
      const c = ghCompare(a, unary());
      a = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
    }
    return a;
  };
  const unary = (): GhValue => {
    if (isOp('!')) {
      pos++;
      return !ghTruthy(unary());
    }
    return postfix();
  };
  const postfix = (): GhValue => {
    let v = primary();
    for (;;) {
      if (isOp('.')) {
        pos++;
        const t = toks[pos++];
        if (t?.t !== 'id') throw new Error(`expected a property name in expression: ${src}`);
        v = ghProp(v, t.v);
      } else if (isOp('[')) {
        pos++;
        const key = or();
        expectOp(']');
        v = ghProp(v, key);
      } else return v;
    }
  };
  const primary = (): GhValue => {
    const t = toks[pos++];
    if (t === undefined) throw new Error(`unexpected end of expression: ${src}`);
    if (t.t === 'str') return t.v;
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'op' && t.v === '(') {
      const v = or();
      expectOp(')');
      return v;
    }
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      if (isOp('(')) {
        pos++;
        const args: GhValue[] = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) {
            pos++;
            args.push(or());
          }
        }
        expectOp(')');
        return ghCall(t.v, args);
      }
      return ghProp(ctx, t.v);
    }
    throw new Error(`unexpected token ${t.v} in expression: ${src}`);
  };
  const result = or();
  if (pos !== toks.length) throw new Error(`trailing tokens in expression: ${src}`);
  return result;
}

/** A workflow value with `${{ }}` parts, evaluated to the string GitHub would use. */
function interpolate(text: string, ctx: Record<string, GhValue>): string {
  return text.replace(/\$\{\{\s*([\s\S]+?)\s*\}\}/g, (_, expr: string) =>
    ghString(ghEvaluate(expr, ctx)),
  );
}

// --- events ------------------------------------------------------------------------------------

/** The `github` context of a pull_request event `action` on PR #7, whose head is H1. */
function prGithub(action: string, workspace: string): Record<string, GhValue> {
  const head = { sha: H1, ref: `chore/pr-${String(PR_NUMBER)}`, repo: { full_name: GH_REPO } };
  return {
    event_name: 'pull_request',
    ref: `refs/pull/${String(PR_NUMBER)}/merge`,
    ref_name: `${String(PR_NUMBER)}/merge`,
    ref_type: 'branch',
    head_ref: head.ref,
    base_ref: 'main',
    sha: 'e'.repeat(40),
    repository: GH_REPO,
    repository_owner: 'o',
    workflow: 'ci',
    run_id: String(RUN_ID),
    run_number: '1',
    run_attempt: '1',
    token: 'not-a-real-token',
    workspace,
    api_url: 'https://api.invalid',
    server_url: 'https://github.invalid',
    actor: 'o',
    event: {
      action,
      number: PR_NUMBER,
      pull_request: {
        number: PR_NUMBER,
        head,
        base: { sha: BASE_SHA, ref: 'main', repo: { full_name: GH_REPO } },
      },
      repository: { full_name: GH_REPO, default_branch: 'main' },
    },
  };
}

/** The `github` context of a push to main of the commit `sha` whose tree is `tree`. */
function pushGithub(sha: string, tree: string, workspace: string): Record<string, GhValue> {
  const ref = 'refs/heads/main';
  return {
    event_name: 'push',
    ref,
    ref_name: 'main',
    ref_type: 'branch',
    head_ref: '',
    base_ref: '',
    sha,
    repository: GH_REPO,
    repository_owner: 'o',
    workflow: 'ci',
    run_id: String(RUN_ID),
    run_number: '1',
    run_attempt: '1',
    token: 'not-a-real-token',
    workspace,
    api_url: 'https://api.invalid',
    server_url: 'https://github.invalid',
    actor: 'o',
    event: {
      ref,
      before: 'd'.repeat(40),
      after: sha,
      head_commit: { id: sha, tree_id: tree },
      repository: { full_name: GH_REPO, default_branch: 'main' },
    },
  };
}

// The fake gh (CommonJS, run with this Node). Written without template literals on purpose. The
// jq subset is the one of ci-concurrency-workflow.test.ts.
const FAKE_GH = String.raw`'use strict';
const fs = require('node:fs');

class JqError extends Error {}
function die(msg) { process.stderr.write('fake gh: ' + msg + '\n'); process.exit(1); }

// ----- jq subset -----
function readString(src, start) {
  const parts = []; let buf = ''; let i = start + 1;
  for (;;) {
    if (i >= src.length) throw new Error('unterminated string in jq filter');
    const c = src[i];
    if (c === '"') { parts.push(buf); return { parts: parts, end: i + 1 }; }
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '(') {
        let depth = 1; let j = i + 2; let inStr = false;
        while (j < src.length && depth > 0) {
          const d = src[j];
          if (inStr) { if (d === '\\') j++; else if (d === '"') inStr = false; }
          else if (d === '"') inStr = true;
          else if (d === '(') depth++;
          else if (d === ')') depth--;
          j++;
        }
        if (depth !== 0) throw new Error('unterminated interpolation in jq filter');
        parts.push(buf); buf = '';
        parts.push({ expr: parse(src.slice(i + 2, j - 1)) });
        i = j; continue;
      }
      const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      if (n === 'u') { buf += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
      if (!Object.prototype.hasOwnProperty.call(map, n)) throw new Error('bad escape in jq string');
      buf += map[n]; i += 2; continue;
    }
    buf += c; i++;
  }
}

function tokenize(src) {
  const toks = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"') { const r = readString(src, i); toks.push({ t: 'str', parts: r.parts }); i = r.end; continue; }
    const rest = src.slice(i);
    let m = /^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (m) { toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    m = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (m) { toks.push({ t: 'field', v: m[1] }); i += m[0].length; continue; }
    m = /^@[A-Za-z0-9]+/.exec(rest);
    if (m) { toks.push({ t: 'format', v: m[0] }); i += m[0].length; continue; }
    m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (m) { toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    if (c === '$') throw new Error('jq variables are not in the fake gh jq subset');
    const two = rest.slice(0, 2);
    if (two === '..') throw new Error('recursive descent is not in the fake gh jq subset');
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '//') { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('.|,<>+-*/()[]{}:;?'.indexOf(c) >= 0) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('unexpected character ' + c + ' in jq filter');
  }
  return toks;
}

function parse(src) {
  const toks = tokenize(src); let pos = 0;
  const isOp = function (v) { const t = toks[pos]; return t !== undefined && t.t === 'op' && t.v === v; };
  const isId = function (v) { const t = toks[pos]; return t !== undefined && t.t === 'id' && t.v === v; };
  const expectOp = function (v) { if (!isOp(v)) throw new Error('expected ' + v + ' in jq filter ' + src); pos++; };
  const expectId = function (v) { if (!isId(v)) throw new Error('expected ' + v + ' in jq filter ' + src); pos++; };
  function pipe() { const a = comma(); if (isOp('|')) { pos++; return { k: 'pipe', a: a, b: pipe() }; } return a; }
  function comma() { let a = alt(); while (isOp(',')) { pos++; a = { k: 'comma', a: a, b: alt() }; } return a; }
  function alt() { const a = or(); if (isOp('//')) { pos++; return { k: 'alt', a: a, b: alt() }; } return a; }
  function or() { let a = and(); while (isId('or')) { pos++; a = { k: 'or', a: a, b: and() }; } return a; }
  function and() { let a = cmp(); while (isId('and')) { pos++; a = { k: 'and', a: a, b: cmp() }; } return a; }
  function cmp() {
    const a = add(); const t = toks[pos];
    if (t && t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].indexOf(t.v) >= 0) { pos++; return { k: 'cmp', op: t.v, a: a, b: add() }; }
    return a;
  }
  function add() {
    let a = mul();
    for (;;) { const t = toks[pos]; if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) { pos++; a = { k: 'arith', op: t.v, a: a, b: mul() }; } else return a; }
  }
  function mul() {
    let a = postfix();
    for (;;) { const t = toks[pos]; if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) { pos++; a = { k: 'arith', op: t.v, a: a, b: postfix() }; } else return a; }
  }
  function postfix() {
    let e = primary();
    for (;;) {
      const t = toks[pos]; const n = toks[pos + 1];
      if (t === undefined) return e;
      if (t.t === 'field') { pos++; e = { k: 'index', a: e, key: { k: 'lit', v: t.v } }; continue; }
      if (t.t === 'op' && t.v === '.' && n && n.t === 'str') { pos += 2; e = { k: 'index', a: e, key: { k: 'str', parts: n.parts } }; continue; }
      if (t.t === 'op' && t.v === '.' && n && n.t === 'op' && n.v === '[') { pos++; continue; }
      if (t.t === 'op' && t.v === '[') {
        pos++;
        if (isOp(']')) { pos++; e = { k: 'iter', a: e }; continue; }
        const key = pipe(); expectOp(']'); e = { k: 'index', a: e, key: key }; continue;
      }
      if (t.t === 'op' && t.v === '?') { pos++; e = { k: 'try', a: e }; continue; }
      return e;
    }
  }
  function object() {
    const entries = [];
    if (isOp('}')) { pos++; return { k: 'obj', entries: entries }; }
    for (;;) {
      const t = toks[pos++]; let key;
      if (t && t.t === 'id') key = { k: 'lit', v: t.v };
      else if (t && t.t === 'str') key = { k: 'str', parts: t.parts };
      else if (t && t.t === 'op' && t.v === '(') { key = pipe(); expectOp(')'); }
      else throw new Error('object key not in the fake gh jq subset');
      let val;
      if (isOp(':')) { pos++; val = alt(); } else val = { k: 'index', a: { k: 'id' }, key: key };
      entries.push({ key: key, val: val });
      if (isOp(',')) { pos++; continue; }
      expectOp('}'); return { k: 'obj', entries: entries };
    }
  }
  function ifExpr() {
    const c = pipe(); expectId('then'); const t = pipe();
    if (isId('elif')) { pos++; return { k: 'if', c: c, t: t, e: ifExpr() }; }
    let e = null;
    if (isId('else')) { pos++; e = pipe(); }
    expectId('end');
    return { k: 'if', c: c, t: t, e: e };
  }
  function primary() {
    const t = toks[pos++];
    if (t === undefined) throw new Error('unexpected end of jq filter ' + src);
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'str', parts: t.parts };
    if (t.t === 'field') return { k: 'index', a: { k: 'id' }, key: { k: 'lit', v: t.v } };
    if (t.t === 'format') return { k: 'format', v: t.v };
    if (t.t === 'op') {
      if (t.v === '.') {
        const n = toks[pos];
        if (n && n.t === 'str') { pos++; return { k: 'index', a: { k: 'id' }, key: { k: 'str', parts: n.parts } }; }
        return { k: 'id' };
      }
      if (t.v === '(') { const e = pipe(); expectOp(')'); return e; }
      if (t.v === '[') { if (isOp(']')) { pos++; return { k: 'arr', e: null }; } const e = pipe(); expectOp(']'); return { k: 'arr', e: e }; }
      if (t.v === '{') return object();
      if (t.v === '-') return { k: 'neg', a: postfix() };
    }
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (t.v === 'if') return ifExpr();
      if (['reduce', 'foreach', 'def', 'try', 'label', 'import', 'include', 'as'].indexOf(t.v) >= 0) {
        throw new Error('jq ' + t.v + ' is not in the fake gh jq subset');
      }
      const args = [];
      if (isOp('(')) { pos++; args.push(pipe()); while (isOp(';')) { pos++; args.push(pipe()); } expectOp(')'); }
      return { k: 'call', name: t.v, args: args };
    }
    throw new Error('unexpected token in jq filter ' + src);
  }
  const e = pipe();
  if (pos !== toks.length) throw new Error('trailing tokens in jq filter ' + src);
  return e;
}

function truthy(v) { return v !== null && v !== false; }
function typeName(v) { if (v === null) return 'null'; if (Array.isArray(v)) return 'array'; return typeof v; }
function rank(v) { if (v === null) return 0; if (v === false) return 1; if (v === true) return 2; if (typeof v === 'number') return 3; if (typeof v === 'string') return 4; if (Array.isArray(v)) return 5; return 6; }
function compare(a, b) {
  const ra = rank(a); const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return a - b;
  if (ra === 4) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 5) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compare(a[i], b[i]); if (c !== 0) return c; } return a.length - b.length; }
  if (ra === 6) {
    const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort(); const c = compare(ka, kb);
    if (c !== 0) return c;
    for (const k of ka) { const d = compare(a[k], b[k]); if (d !== 0) return d; }
  }
  return 0;
}
function tostr(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
function index(v, k) {
  if (v === null) return null;
  if (typeof k === 'string' && typeof v === 'object' && !Array.isArray(v)) return Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null;
  if (typeof k === 'number' && Array.isArray(v)) { const i = Math.floor(k < 0 ? v.length + k : k); return i >= 0 && i < v.length ? v[i] : null; }
  throw new JqError('Cannot index ' + typeName(v) + ' with ' + typeName(k));
}
function iterate(v) {
  if (Array.isArray(v)) return v.slice();
  if (v !== null && typeof v === 'object') return Object.keys(v).map(function (k) { return v[k]; });
  throw new JqError('Cannot iterate over ' + typeName(v));
}
function arith(op, a, b) {
  if (op === '+') {
    if (a === null) return b; if (b === null) return a;
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    if (typeof a === 'string' && typeof b === 'string') return a + b;
    if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
    if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) return Object.assign({}, a, b);
  }
  if (op === '-') {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (Array.isArray(a) && Array.isArray(b)) return a.filter(function (x) { return !b.some(function (y) { return compare(x, y) === 0; }); });
  }
  if (op === '*' && typeof a === 'number' && typeof b === 'number') return a * b;
  if (op === '/' && typeof a === 'number' && typeof b === 'number') return a / b;
  throw new JqError(typeName(a) + ' and ' + typeName(b) + ' cannot be combined with ' + op);
}
function uniq(xs) { const out = []; for (const x of xs.slice().sort(compare)) if (out.length === 0 || compare(out[out.length - 1], x) !== 0) out.push(x); return out; }
function call(name, args, x) {
  const sig = name + '/' + args.length;
  const a0 = args[0];
  switch (sig) {
    case 'empty/0': return [];
    case 'not/0': return [!truthy(x)];
    case 'error/0': throw new JqError(tostr(x));
    case 'error/1': throw new JqError(tostr(ev(a0, x)[0]));
    case 'length/0':
      if (x === null) return [0];
      if (typeof x === 'string' || Array.isArray(x)) return [x.length];
      if (typeof x === 'object') return [Object.keys(x).length];
      if (typeof x === 'number') return [Math.abs(x)];
      throw new JqError('boolean has no length');
    case 'select/1': return ev(a0, x).filter(truthy).map(function () { return x; });
    case 'map/1': return [iterate(x).reduce(function (acc, e) { return acc.concat(ev(a0, e)); }, [])];
    case 'any/0': return [iterate(x).some(truthy)];
    case 'all/0': return [iterate(x).every(truthy)];
    case 'any/1': return [iterate(x).some(function (e) { return ev(a0, e).some(truthy); })];
    case 'all/1': return [iterate(x).every(function (e) { return ev(a0, e).every(truthy); })];
    case 'join/1': return ev(a0, x).map(function (sep) { return iterate(x).map(function (e) { return e === null ? '' : tostr(e); }).join(sep); });
    case 'first/0': return [index(x, 0)];
    case 'last/0': return [index(x, -1)];
    case 'first/1': return ev(a0, x).slice(0, 1);
    case 'keys/0': return [Array.isArray(x) ? x.map(function (_, i) { return i; }) : Object.keys(x).sort()];
    case 'has/1': return ev(a0, x).map(function (k) { return Array.isArray(x) ? k >= 0 && k < x.length : Object.prototype.hasOwnProperty.call(x, k); });
    case 'tostring/0': return [tostr(x)];
    case 'tonumber/0': return [typeof x === 'number' ? x : Number(x)];
    case 'tojson/0': return [JSON.stringify(x)];
    case 'fromjson/0': return [JSON.parse(x)];
    case 'add/0': { const xs = iterate(x); return [xs.length === 0 ? null : xs.reduce(function (s, e) { return arith('+', s, e); })]; }
    case 'sort/0': return [iterate(x).sort(compare)];
    case 'sort_by/1': return [iterate(x).sort(function (p, q) { return compare(ev(a0, p), ev(a0, q)); })];
    case 'unique/0': return [uniq(iterate(x))];
    case 'reverse/0': return [iterate(x).reverse()];
    case 'min/0': { const xs = iterate(x).sort(compare); return [xs.length ? xs[0] : null]; }
    case 'max/0': { const xs = iterate(x).sort(compare); return [xs.length ? xs[xs.length - 1] : null]; }
    case 'flatten/0': return [iterate(x).reduce(function (acc, e) { return acc.concat(Array.isArray(e) ? e : [e]); }, [])];
    case 'type/0': return [typeName(x) === 'array' ? 'array' : typeName(x) === 'object' ? 'object' : typeName(x)];
    case 'values/0': return x === null ? [] : [x];
    case 'startswith/1': return ev(a0, x).map(function (s) { return String(x).startsWith(s); });
    case 'endswith/1': return ev(a0, x).map(function (s) { return String(x).endsWith(s); });
    case 'contains/1': return ev(a0, x).map(function (s) { return typeof x === 'string' ? x.indexOf(s) >= 0 : compare(x, s) === 0; });
    case 'test/1': return ev(a0, x).map(function (re) { return new RegExp(re).test(String(x)); });
    case 'split/1': return ev(a0, x).map(function (s) { return String(x).split(s); });
    case 'ltrimstr/1': return ev(a0, x).map(function (s) { return typeof x === 'string' && x.startsWith(s) ? x.slice(s.length) : x; });
    case 'rtrimstr/1': return ev(a0, x).map(function (s) { return typeof x === 'string' && x.endsWith(s) ? x.slice(0, x.length - s.length) : x; });
    case 'ascii_downcase/0': return [String(x).toLowerCase()];
    case 'ascii_upcase/0': return [String(x).toUpperCase()];
    case 'floor/0': return [Math.floor(x)];
  }
  throw new Error('jq function ' + sig + ' is not in the fake gh jq subset');
}
function format(name, x) {
  if (name === '@text') return tostr(x);
  if (name === '@json') return JSON.stringify(x);
  if (name === '@tsv') return iterate(x).map(function (e) { return e === null ? '' : tostr(e).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n'); }).join('\t');
  if (name === '@sh') return (Array.isArray(x) ? x : [x]).map(function (e) { return typeof e === 'string' ? "'" + e.replace(/'/g, "'\\''") + "'" : tostr(e); }).join(' ');
  throw new Error('jq format ' + name + ' is not in the fake gh jq subset');
}
function ev(n, x) {
  switch (n.k) {
    case 'id': return [x];
    case 'lit': return [n.v];
    case 'str': {
      let outs = [''];
      for (const p of n.parts) {
        if (typeof p === 'string') { outs = outs.map(function (o) { return o + p; }); continue; }
        const vals = ev(p.expr, x); const next = [];
        for (const o of outs) for (const v of vals) next.push(o + tostr(v));
        outs = next;
      }
      return outs;
    }
    case 'format': return [format(n.v, x)];
    case 'pipe': return ev(n.a, x).reduce(function (acc, y) { return acc.concat(ev(n.b, y)); }, []);
    case 'comma': return ev(n.a, x).concat(ev(n.b, x));
    case 'alt': {
      let xs;
      try { xs = ev(n.a, x).filter(truthy); } catch (e) { if (!(e instanceof JqError)) throw e; xs = []; }
      return xs.length > 0 ? xs : ev(n.b, x);
    }
    case 'or': case 'and': {
      const out = [];
      for (const l of ev(n.a, x)) {
        if (n.k === 'or' && truthy(l)) { out.push(true); continue; }
        if (n.k === 'and' && !truthy(l)) { out.push(false); continue; }
        for (const r of ev(n.b, x)) out.push(truthy(r));
      }
      return out;
    }
    case 'cmp': {
      const out = [];
      for (const r of ev(n.b, x)) for (const l of ev(n.a, x)) {
        const c = compare(l, r);
        out.push(n.op === '==' ? c === 0 : n.op === '!=' ? c !== 0 : n.op === '<' ? c < 0 : n.op === '<=' ? c <= 0 : n.op === '>' ? c > 0 : c >= 0);
      }
      return out;
    }
    case 'arith': {
      const out = [];
      for (const r of ev(n.b, x)) for (const l of ev(n.a, x)) out.push(arith(n.op, l, r));
      return out;
    }
    case 'neg': return ev(n.a, x).map(function (v) { if (typeof v !== 'number') throw new JqError('cannot negate'); return -v; });
    case 'index': {
      const out = [];
      for (const b of ev(n.a, x)) for (const k of ev(n.key, x)) out.push(index(b, k));
      return out;
    }
    case 'iter': return ev(n.a, x).reduce(function (acc, b) { return acc.concat(iterate(b)); }, []);
    case 'try': try { return ev(n.a, x); } catch (e) { if (e instanceof JqError) return []; throw e; }
    case 'arr': return [n.e === null ? [] : ev(n.e, x)];
    case 'obj': {
      let outs = [{}];
      for (const en of n.entries) {
        const keys = ev(en.key, x); const vals = ev(en.val, x); const next = [];
        for (const o of outs) for (const k of keys) {
          if (typeof k !== 'string') throw new JqError('object keys must be strings');
          for (const v of vals) { const c = Object.assign({}, o); c[k] = v; next.push(c); }
        }
        outs = next;
      }
      return outs;
    }
    case 'if': {
      const out = [];
      for (const c of ev(n.c, x)) {
        if (truthy(c)) out.push.apply(out, ev(n.t, x));
        else if (n.e !== null) out.push.apply(out, ev(n.e, x));
        else out.push(x);
      }
      return out;
    }
    case 'call': return call(n.name, n.args, x);
  }
  throw new Error('unknown jq node ' + n.k);
}

// ----- the REST endpoints (GET only) -----
// kinds: status (run lists and single runs), jobs, artifacts, pull (pulls/<n>), commit-pulls
// (commits/<sha>/pulls). Every call is one line of the event log, as is every fake sleep.
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const logFile = process.env.FAKE_GH_LOG;
const argv = process.argv.slice(2);
if (argv[0] !== 'api') die('only gh api is faked, got: gh ' + argv.join(' '));
let path = null; let jq = null; let method = null; const fields = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--jq' || a === '-q') jq = argv[++i];
  else if (a.startsWith('--jq=')) jq = a.slice(5);
  else if (a === '-X' || a === '--method') method = argv[++i];
  else if (a.startsWith('--method=')) method = a.slice(9);
  else if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') fields.push(argv[++i]);
  else if (a === '-H' || a === '--header' || a === '--hostname' || a === '--cache') i++;
  else if (a === '--paginate' || a === '--silent') { /* one page is all there is */ }
  else if (a.startsWith('-')) die('flag ' + a + ' is not faked');
  else if (path === null) path = a;
  else die('unexpected argument ' + a);
}
if (path === null) die('no endpoint');
if (method !== null && method.toUpperCase() !== 'GET') die('only GET is faked, got ' + method);
if (method === null && fields.length > 0) die('fields without -X GET would be a POST');
const url = new URL(path.replace(/^\/+/, ''), 'https://api.invalid/');
const p = url.pathname.replace(/^\/+/, '');
const q = url.searchParams;
for (const f of fields) { const at = f.indexOf('='); q.set(f.slice(0, at), f.slice(at + 1)); }

const previous = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); }) : [];
let statusCount = previous.filter(function (e) { return e.kind === 'status'; }).length;
const pullCount = previous.filter(function (e) { return e.kind === 'pull'; }).length;

const prefix = 'repos/' + state.repo + '/';
if (!p.startsWith(prefix)) die('no route for ' + p);
const rest = p.slice(prefix.length);
function findRun(id) { const r = state.runs.find(function (x) { return String(x.id) === String(id); }); if (!r) die('HTTP 404: no run ' + id); return r; }
function isDone(r) { return r.pending !== null && statusCount > r.pending; }
function workflowId(r) { return r.workflow === 'ci.yml' ? 101 : 202; }
function runObj(r) {
  const done = isDone(r);
  return {
    id: r.id, name: r.workflow.replace(/\.yml$/, ''), path: '.github/workflows/' + r.workflow,
    workflow_id: workflowId(r), head_sha: r.head, head_branch: r.event === 'push' ? 'main' : 'chore/x', event: r.event,
    status: done ? 'completed' : 'in_progress', conclusion: done ? r.conclusion : null, run_attempt: 1,
    repository: { full_name: state.repo }, head_repository: { full_name: state.repo },
  };
}
function lastPage() { return Number(q.get('page') || '1') > 1; }
function listRuns(runs) {
  let rs = runs.slice().sort(function (a, b) { return b.id - a.id; }).map(runObj);
  if (q.get('head_sha')) rs = rs.filter(function (r) { return r.head_sha === q.get('head_sha'); });
  if (q.get('event')) rs = rs.filter(function (r) { return r.event === q.get('event'); });
  if (q.get('status')) rs = rs.filter(function (r) { return r.status === q.get('status') || r.conclusion === q.get('status'); });
  if (lastPage()) rs = [];
  return { total_count: rs.length, workflow_runs: rs };
}
function pullObj(n, head) {
  return {
    number: n, state: 'open', merged_at: null, merge_commit_sha: null,
    head: { ref: 'chore/pr-' + n, sha: head, repo: { full_name: state.repo } },
    base: { ref: 'main', sha: state.baseSha, repo: { full_name: state.repo } },
  };
}

let m; let kind; let build; let pullHead = null; let pullError = null;
if ((m = /^pulls\/(\d+)$/.exec(rest))) {
  const n = Number(m[1]); const pr = state.pull; kind = 'pull';
  if (n !== pr.number) pullError = 'gh: Not Found (HTTP 404)';
  else if (pr.failAll || pullCount < pr.failFirst) pullError = pr.failWith === 404 ? 'gh: Not Found (HTTP 404)' : 'gh: Server Error (HTTP 502)';
  else pullHead = pr.moved !== null && statusCount >= pr.movesAfter ? pr.moved : pr.head;
  build = function () { return pullObj(n, pullHead); };
} else if ((m = /^commits\/([^/]+)\/pulls$/.exec(rest))) {
  const sha = m[1]; kind = 'commit-pulls';
  build = function () { return lastPage() ? [] : (state.commitPulls[sha] || []); };
} else if ((m = /^actions\/workflows\/([^/]+)\/runs$/.exec(rest))) {
  const wf = m[1]; kind = 'status';
  build = function () { return listRuns(state.runs.filter(function (r) { return r.workflow === wf || String(workflowId(r)) === wf; })); };
} else if (rest === 'actions/runs') {
  kind = 'status'; build = function () { return listRuns(state.runs); };
} else if ((m = /^actions\/runs\/(\d+)$/.exec(rest))) {
  const r = findRun(m[1]); kind = 'status'; build = function () { return runObj(r); };
} else if ((m = /^actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/jobs$/.exec(rest))) {
  const r = findRun(m[1]); kind = 'jobs';
  build = function () {
    const done = isDone(r);
    const jobs = lastPage() ? [] : Object.keys(r.jobs).map(function (name, i) {
      return { id: r.id * 100 + i, run_id: r.id, name: name, head_sha: r.head, status: done ? 'completed' : 'in_progress', conclusion: done ? r.jobs[name] : null };
    });
    return { total_count: jobs.length, jobs: jobs };
  };
} else if ((m = /^actions\/runs\/(\d+)\/artifacts$/.exec(rest))) {
  const r = findRun(m[1]); kind = 'artifacts';
  build = function () {
    let arts = isDone(r) && !lastPage() ? r.artifacts.map(function (name, i) {
      return { id: r.id * 100 + i, name: name, expired: false, workflow_run: { id: r.id, head_sha: r.head } };
    }) : [];
    if (q.get('name')) arts = arts.filter(function (a) { return a.name === q.get('name'); });
    return { total_count: arts.length, artifacts: arts };
  };
} else die('no route for ' + p);

if (kind === 'status') statusCount += 1;
fs.appendFileSync(logFile, JSON.stringify({ kind: kind, path: p + url.search, head: pullHead }) + '\n');
if (pullError !== null) { process.stderr.write(pullError + '\n'); process.exit(1); }
const body = build();
if (jq === null) { process.stdout.write(JSON.stringify(body) + '\n'); }
else {
  let outs;
  try { outs = ev(parse(jq), body); } catch (e) { die('jq: ' + (e && e.message ? e.message : String(e))); }
  process.stdout.write(outs.map(function (v) { return tostr(v) + '\n'; }).join(''));
}
`;

// --- scenarios ---------------------------------------------------------------------------------

type FakeRun = {
  id: number;
  workflow: string;
  event: 'pull_request' | 'push';
  head: string;
  /** Run-list queries during which the run is in progress; null: never ends. */
  pending: number | null;
  conclusion: 'success' | 'failure' | 'cancelled';
  jobs: Record<string, string>;
  artifacts: string[];
};

type PullConfig = {
  number: number;
  /** The head pulls/<number> answers before it moves. */
  head: string;
  /** The head it answers once `movesAfter` run-list queries have been answered; null: never. */
  moved: string | null;
  movesAfter: number;
  /** Every pulls/<number> query fails. */
  failAll: boolean;
  /** The first `failFirst` pulls/<number> queries fail. */
  failFirst: number;
  failWith: 502 | 404;
};

type Scenario = {
  runs: FakeRun[];
  pull?: Partial<PullConfig>;
  /** commits/<sha>/pulls answers, by sha. */
  commitPulls?: Record<string, unknown[]>;
};

let BIN = '';
let CHECKOUT = '';
let TREE = '';
let PUSH_SHA = '';
let runCount = 0;

function git(cwd: string, args: string[]): string {
  const res = spawnSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: SCRATCH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  BIN = join(SCRATCH, 'bin');
  mkdirSync(BIN, { recursive: true });
  writeFileSync(join(BIN, 'fake-gh.cjs'), FAKE_GH);
  writeFileSync(
    join(BIN, 'gh'),
    `#!/bin/sh\nexec '${process.execPath}' '${join(BIN, 'fake-gh.cjs')}' "$@"\n`,
  );
  chmodSync(join(BIN, 'gh'), 0o755);
  // The fake sleep records itself in the event log of the fake gh and sleeps a moment only.
  const which = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' });
  const realSleep = which.stdout.trim() || '/bin/sleep';
  writeFileSync(
    join(BIN, 'sleep'),
    `#!/bin/sh\nprintf '{"kind":"sleep","path":"%s","head":null}\\n' "$*" >> "$FAKE_GH_LOG"\nexec '${realSleep}' 0.05\n`,
  );
  chmodSync(join(BIN, 'sleep'), 0o755);
  // The checkout the find step runs in: its HEAD tree is the tree of this event.
  CHECKOUT = join(SCRATCH, 'checkout');
  mkdirSync(CHECKOUT, { recursive: true });
  git(CHECKOUT, ['init', '-q', '-b', 'main']);
  writeFileSync(join(CHECKOUT, 'README.md'), '# fixture\n');
  git(CHECKOUT, ['add', '-A']);
  git(CHECKOUT, ['commit', '-q', '-m', 'base']);
  TREE = git(CHECKOUT, ['rev-parse', 'HEAD^{tree}']);
  PUSH_SHA = git(CHECKOUT, ['rev-parse', 'HEAD']);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function allJobs(
  conclusion: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const jobs: Record<string, string> = { 'verify-reuse': conclusion };
  for (const j of VERIFY_JOBS) jobs[j] = overrides[j] ?? conclusion;
  jobs['guard-git'] = conclusion;
  jobs['ci-gate'] = conclusion;
  return jobs;
}

function verifiedArtifacts(): string[] {
  return VERIFY_JOBS.map((j) => `verified-${j}-${TREE}`);
}

/** Noise present in every scenario; none of it may hold the wait or count for reuse. */
function noiseRuns(): FakeRun[] {
  return [
    // An earlier run on the same head, cancelled long ago.
    {
      id: 4000,
      workflow: 'ci.yml',
      event: 'pull_request',
      head: H1,
      pending: 0,
      conclusion: 'cancelled',
      jobs: allJobs('cancelled'),
      artifacts: [],
    },
    // A ci.yml run on another head that never ends.
    {
      id: 6000,
      workflow: 'ci.yml',
      event: 'pull_request',
      head: OTHER_HEAD,
      pending: null,
      conclusion: 'success',
      jobs: allJobs('success'),
      artifacts: [],
    },
    // Another workflow on the same head that never ends.
    {
      id: 7000,
      workflow: 'protected-paths.yml',
      event: 'pull_request',
      head: H1,
      pending: null,
      conclusion: 'success',
      jobs: { 'protected-paths': 'success' },
      artifacts: [],
    },
  ];
}

/** A code run of ci.yml on H1 that uploaded every verified artifact for this tree. */
function codeRun(id: number, pending: number | null, jobs: Record<string, string>): FakeRun {
  const conclusions = Object.values(jobs);
  return {
    id,
    workflow: 'ci.yml',
    event: 'pull_request',
    head: H1,
    pending,
    conclusion: conclusions.includes('cancelled')
      ? 'cancelled'
      : conclusions.some((c) => c !== 'success')
        ? 'failure'
        : 'success',
    jobs,
    artifacts: verifiedArtifacts(),
  };
}

/** A code run on H1 cancelled by the push of the new head: no artifacts. */
function cancelledRun(id: number, pending: number): FakeRun {
  return { ...codeRun(id, pending, allJobs('cancelled')), artifacts: [] };
}

/** This run itself: in progress. */
function selfRun(push: boolean): FakeRun {
  return {
    id: RUN_ID,
    workflow: 'ci.yml',
    event: push ? 'push' : 'pull_request',
    head: push ? PUSH_SHA : H1,
    pending: null,
    conclusion: 'success',
    jobs: { 'verify-reuse': 'in_progress' },
    artifacts: [],
  };
}

// --- running verify-reuse ----------------------------------------------------------------------

type Event = { kind: string; path: string; head: string | null };

type ReuseRun = {
  /** The exit status of the step that outputs `reuse`; null when it did not run. */
  findStatus: number | null;
  /** Some step of verify-reuse exited non-zero: the job fails. */
  failed: boolean;
  out: string;
  /** What the find step wrote to $GITHUB_OUTPUT, line by line. */
  written: string[];
  /** The job outputs of verify-reuse, as its `outputs:` evaluate after its steps. */
  outputs: Record<string, string>;
  /** Every gh call and every sleep, in order. */
  events: Event[];
};

/** Lines of a $GITHUB_OUTPUT file as key -> value (`k=v` and `k<<DELIM` forms). */
function readOutputs(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) body.push(lines[i] ?? '');
      out[heredoc[1] ?? ''] = body.join('\n');
      continue;
    }
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

const STATUS_FN = /\b(?:success|failure|always|cancelled)\s*\(/;

/**
 * Runs the steps of verify-reuse in order, as GitHub would (a step after a failed one runs only
 * when its `if:` asks for it), under a label event on PR #7 (head H1, `action`, default labeled)
 * or a push to main, against
 * the fake gh and the fake sleep. The wait limit is `wait` seconds, the poll interval 1 second.
 */
function runReuse(
  s: Scenario,
  o: { push?: boolean; wait?: number; action?: string } = {},
): ReuseRun {
  const push = o.push === true;
  const dir = join(SCRATCH, `reuse-${String(++runCount)}`);
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, 'state.json');
  const logFile = join(dir, 'events.log');
  const pull: PullConfig = {
    number: PR_NUMBER,
    head: H1,
    moved: null,
    movesAfter: 0,
    failAll: false,
    failFirst: 0,
    failWith: 502,
    ...s.pull,
  };
  writeFileSync(
    stateFile,
    JSON.stringify({
      repo: GH_REPO,
      baseSha: BASE_SHA,
      runs: [selfRun(push), ...s.runs],
      pull,
      commitPulls: s.commitPulls ?? {},
    }),
  );
  const stepsCtx: Record<string, GhValue> = {};
  const ctx: Record<string, GhValue> = {
    github: push ? pushGithub(PUSH_SHA, TREE, CHECKOUT) : prGithub(o.action ?? 'labeled', CHECKOUT),
    runner: { temp: dir, os: 'Linux', arch: 'X64' },
    secrets: { GITHUB_TOKEN: 'not-a-real-token' },
    env: {},
    vars: {},
    job: { status: 'success' },
    steps: stepsCtx,
    inputs: {},
  };
  const body = requireJob('verify-reuse');
  const declared = mapping(entry(body, 'outputs', 4));
  const reuseExpr = expressionOf(declared['reuse'] ?? '') ?? '';
  const findId = /^steps\.([A-Za-z0-9_-]+)\.outputs\.reuse$/.exec(reuseExpr)?.[1];
  expect(findId, 'verify-reuse outputs reuse from a step').toBeDefined();
  const jobEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(mapping(entry(body, 'env', 4)))) {
    jobEnv[k] = interpolate(v, ctx);
  }
  let findStatus: number | null = null;
  let written: string[] = [];
  let out = '';
  PRIOR_FAILED = false;
  try {
    for (const [i, st] of steps('verify-reuse').entries()) {
      if (st.run === null) continue;
      let runs = !PRIOR_FAILED;
      if (st.cond !== null) {
        const cond = expressionOf(st.cond) ?? st.cond;
        runs = ghTruthy(ghEvaluate(cond, ctx)) && (STATUS_FN.test(cond) || !PRIOR_FAILED);
      }
      if (!runs) continue;
      const output = join(dir, `output-${String(i)}`);
      writeFileSync(output, '');
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(st.env)) env[k] = interpolate(v, ctx);
      const res = spawnSync(
        'bash',
        ['--noprofile', '--norc', '-eo', 'pipefail', '-c', interpolate(st.run, ctx)],
        {
          cwd: CHECKOUT,
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            PATH: `${BIN}:${process.env['PATH'] ?? ''}`,
            HOME: dir,
            CI: 'true',
            GITHUB_ACTIONS: 'true',
            GITHUB_OUTPUT: output,
            GITHUB_WORKSPACE: CHECKOUT,
            GITHUB_EVENT_NAME: push ? 'push' : 'pull_request',
            GITHUB_REF: push ? 'refs/heads/main' : `refs/pull/${String(PR_NUMBER)}/merge`,
            GITHUB_SHA: push ? PUSH_SHA : 'e'.repeat(40),
            GITHUB_REPOSITORY: GH_REPO,
            GITHUB_RUN_ID: String(RUN_ID),
            GITHUB_API_URL: 'https://api.invalid',
            RUNNER_TEMP: dir,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            ...jobEnv,
            ...env,
            [WAIT_VAR]: String(o.wait ?? 20),
            [POLL_VAR]: '1',
            FAKE_GH_STATE: stateFile,
            FAKE_GH_LOG: logFile,
          },
        },
      );
      out += `${res.stdout}\n${res.stderr}`;
      const ok = res.status === 0;
      if (st.id !== null) {
        stepsCtx[st.id] = {
          outputs: readOutputs(output),
          outcome: ok ? 'success' : 'failure',
          conclusion: ok ? 'success' : 'failure',
        };
      }
      if (st.id === findId) {
        findStatus = res.status;
        written = readFileSync(output, 'utf8').split('\n').filter(Boolean);
      }
      if (!ok) PRIOR_FAILED = true;
    }
  } finally {
    PRIOR_FAILED = false;
  }
  const failed = Object.values(stepsCtx).some(
    (v) => (v as { outcome: string }).outcome === 'failure',
  );
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(declared)) outputs[k] = interpolate(v, ctx);
  const events = existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Event)
    : [];
  return { findStatus, failed: failed || (findStatus ?? 0) !== 0, out, written, outputs, events };
}

const count = (r: ReuseRun, kind: string): number => r.events.filter((e) => e.kind === kind).length;

// --- the jobs after verify-reuse ---------------------------------------------------------------

type Needs = Record<string, GhValue>;

/** The needs of a label run on PR #7 (not ledger-only) after verify-reuse ended with `result`. */
function labelNeeds(result: string, outputs: Record<string, string>): Needs {
  return {
    'verify-reuse': { result, outputs },
    'ledger-only-detect': { result: 'success', outputs: { only: 'false' } },
  };
}

/** Whether job `id` runs under `needs` on the event `github`, by its `if:`. */
function jobRuns(id: string, needs: Needs, github: Record<string, GhValue>): boolean {
  const cond = jobIf(id);
  expect(cond, `${id} has an if`).toMatch(/\S/);
  return ghTruthy(ghEvaluate(cond, { github, needs }));
}

/**
 * Runs the ci-gate Summarise step of a label run whose verify-reuse ended with `result` and
 * `outputs`: each verify job that runs passes, each other one is skipped; guard-git passed.
 */
function gatePasses(
  result: string,
  outputs: Record<string, string>,
): { pass: boolean; out: string } {
  const github = prGithub('labeled', '/w');
  const needs = labelNeeds(result, outputs);
  const all: Needs = { ...needs, 'guard-git': { result: 'success', outputs: {} } };
  for (const j of VERIFY_JOBS) {
    all[j] = { result: jobRuns(j, needs, github) ? 'success' : 'skipped', outputs: {} };
  }
  const s = steps('ci-gate').find((x) => x.name === 'Summarise');
  expect(s?.run, 'ci-gate has the step Summarise with a run script').toBeTruthy();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(s?.env ?? {}))
    env[k] = interpolate(v, { github, needs: all });
  const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', s?.run ?? ''], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { pass: res.status === 0, out: `${res.stdout}\n${res.stderr}` };
}

// --- 1. the head moved: the label run ends early -----------------------------------------------

/** Everything a label run whose pull request got the head H2 must show. */
function expectEndedEarly(r: ReuseRun): void {
  expect(r.findStatus, `the find step ran\n${r.out}`).not.toBeNull();
  expect(r.findStatus, `the find step exits non-zero\n${r.out}`).not.toBe(0);
  expect(r.failed, 'verify-reuse fails').toBe(true);
  const line = r.out.split('\n').find((l) => /head moved/i.test(l));
  expect(line, `one log line says "head moved"\n${r.out}`).toBeDefined();
  expect(line, 'that line names the head of this event').toContain(H1);
  expect(line, 'that line names the current head of the pull request').toContain(H2);
  expect(r.written, 'reuse=true is never written').not.toContain('reuse=true');
  expect(r.outputs['reuse'], 'the job output reuse is not true').not.toBe('true');
  const at = r.events.findIndex((e) => e.kind === 'pull' && e.head === H2);
  expect(
    at,
    `pulls/${String(PR_NUMBER)} was read and answered H2\n${JSON.stringify(r.events)}`,
  ).toBeGreaterThanOrEqual(0);
  expect(r.events[at]?.path, 'the pull request of this event is read, by its number').toMatch(
    new RegExp(`^repos/${GH_REPO}/pulls/${String(PR_NUMBER)}(\\?|$)`),
  );
  expect(
    r.events.slice(at + 1).filter((e) => e.kind !== 'pull'),
    'once H2 was read: no sleep, no runs / jobs / artifacts query',
  ).toEqual([]);
  // The heavy jobs do not run on the old head, and the gate is red there.
  const github = prGithub('labeled', '/w');
  for (const job of HEAVY) {
    expect(jobRuns(job, labelNeeds('failure', r.outputs), github), `${job} is skipped`).toBe(false);
  }
  const gate = gatePasses('failure', r.outputs);
  expect(gate.pass, `ci-gate fails on the old head\n${gate.out}`).toBe(false);
}

it('[CT-06zzzzj] head moves while waiting for a run that never finishes: the find step fails at the next check, before the wait limit, with no further poll or sleep', () => {
  const r = runReuse(
    {
      runs: [...noiseRuns(), codeRun(5001, null, allJobs('success'))],
      pull: { moved: H2, movesAfter: 1 },
    },
    { wait: 5 },
  );
  expectEndedEarly(r);
  expect(r.out, 'it did not wait until the limit').not.toMatch(/wait limit/i);
  expect(count(r, 'sleep'), 'found at the first or second round').toBeLessThanOrEqual(2);
  expect(count(r, 'jobs') + count(r, 'artifacts'), 'no reuse decision was made').toBe(0);
});

it('[CT-06zzzzj] head moves as the old run is cancelled: after the wait the head is checked first, the find step fails, no jobs / artifacts are read', () => {
  const r = runReuse(
    {
      runs: [...noiseRuns(), cancelledRun(5001, 2)],
      pull: { moved: H2, movesAfter: 2 },
    },
    { wait: 20 },
  );
  expectEndedEarly(r);
  expect(count(r, 'jobs') + count(r, 'artifacts'), 'no reuse decision was made').toBe(0);
});

it('[CT-06zzzzj] head moves while the old run is still passing: the find step fails, no reuse=true, no jobs / artifacts are read', () => {
  const r = runReuse(
    {
      runs: [...noiseRuns(), codeRun(5001, 2, allJobs('success'))],
      pull: { moved: H2, movesAfter: 1 },
    },
    { wait: 20 },
  );
  expectEndedEarly(r);
  expect(count(r, 'jobs') + count(r, 'artifacts'), 'no reuse decision was made').toBe(0);
});

it('[CT-06zzzzj] head already moved, nothing to wait for, a finished pass on the old head exists: the head is checked before deciding, the find step fails, no reuse=true', () => {
  const r = runReuse(
    {
      runs: [...noiseRuns(), codeRun(5001, 0, allJobs('success'))],
      pull: { moved: H2, movesAfter: 0 },
    },
    { wait: 20 },
  );
  expectEndedEarly(r);
  expect(count(r, 'sleep'), 'nothing to wait for').toBe(0);
  expect(count(r, 'jobs') + count(r, 'artifacts'), 'no reuse decision was made').toBe(0);
});

it('[CT-06zzzzj] head already moved and the wait limit is reached at once: the head is still checked, the find step fails instead of running every job in full', () => {
  const r = runReuse(
    {
      runs: [...noiseRuns(), codeRun(5001, null, allJobs('success'))],
      pull: { moved: H2, movesAfter: 0 },
    },
    { wait: 0 },
  );
  expectEndedEarly(r);
  expect(count(r, 'sleep'), 'a limit of 0 s never sleeps').toBe(0);
});

it('[CT-06zzzzj] the first pulls query fails, a later one answers the moved head: the failure does not stop the checks, the find step fails then', () => {
  const r = runReuse(
    {
      runs: [...noiseRuns(), codeRun(5001, null, allJobs('success'))],
      pull: { moved: H2, movesAfter: 0, failFirst: 1 },
    },
    { wait: 5 },
  );
  expectEndedEarly(r);
  expect(
    r.events.filter((e) => e.kind === 'pull' && e.head === null).length,
    'the failed query was made',
  ).toBe(1);
  expect(r.out).not.toMatch(/wait limit/i);
});

it('[CT-06zzzzj] an unlabeled event ends early on a moved head as a labeled one does', () => {
  const r = runReuse(
    {
      runs: [...noiseRuns(), codeRun(5001, null, allJobs('success'))],
      pull: { moved: H2, movesAfter: 1 },
    },
    { wait: 5, action: 'unlabeled' },
  );
  expectEndedEarly(r);
  expect(r.out).not.toMatch(/wait limit/i);
});

// --- 2 and 3. head unchanged, or the pulls query fails: exactly as before ----------------------

type Old = {
  name: string;
  runs: () => FakeRun[];
  wait: number;
  reuse: 'true' | 'false';
  sleeps: [number, number];
  log: RegExp[];
};

/** The scenarios of ci-concurrency-workflow.test.ts (CT-06zzzze), with their expectations. */
const OLD: Old[] = [
  {
    name: 'nothing else on this head: decides at once',
    runs: () => noiseRuns(),
    wait: 20,
    reuse: 'false',
    sleeps: [0, 0],
    log: [],
  },
  {
    name: 'an earlier finished pass on this tree: decides at once',
    runs: () => [...noiseRuns(), codeRun(5001, 0, allJobs('success'))],
    wait: 20,
    reuse: 'true',
    sleeps: [0, 0],
    log: [],
  },
  {
    name: 'waits for the code run in progress, then reuses its pass',
    runs: () => [...noiseRuns(), codeRun(5001, 2, allJobs('success'))],
    wait: 20,
    reuse: 'true',
    sleeps: [1, 4],
    log: [/waiting/i, /5001/],
  },
  {
    name: 'waits for every unfinished run on this head',
    runs: () => [
      ...noiseRuns(),
      { ...codeRun(5001, 1, allJobs('cancelled')), artifacts: [] },
      codeRun(5002, 3, allJobs('success')),
    ],
    wait: 20,
    reuse: 'true',
    sleeps: [2, 5],
    log: [/waiting/i],
  },
  {
    name: 'waits for the run in progress, which fails a job: reuse=false',
    runs: () => [
      ...noiseRuns(),
      codeRun(5001, 2, allJobs('success', { 'verify-int-2': 'failure' })),
    ],
    wait: 20,
    reuse: 'false',
    sleeps: [1, 4],
    log: [/waiting/i],
  },
  {
    name: 'a run that never finishes: stops at the wait limit, reuse=false',
    runs: () => [...noiseRuns(), codeRun(5001, null, allJobs('success'))],
    wait: 2,
    reuse: 'false',
    sleeps: [1, Number.POSITIVE_INFINITY],
    log: [/wait limit/i],
  },
  {
    name: 'gives up waiting even if an earlier pass exists: reuse=false',
    runs: () => [
      ...noiseRuns(),
      codeRun(5001, 0, allJobs('success')),
      codeRun(5002, null, allJobs('success')),
    ],
    wait: 2,
    reuse: 'false',
    sleeps: [1, Number.POSITIVE_INFINITY],
    log: [/wait limit/i],
  },
];

const MODES: { mode: string; pull: Partial<PullConfig> }[] = [
  { mode: 'unchanged (pulls answers H1)', pull: {} },
  { mode: 'unknown (every pulls query fails, HTTP 502)', pull: { failAll: true, failWith: 502 } },
  { mode: 'unknown (every pulls query fails, HTTP 404)', pull: { failAll: true, failWith: 404 } },
];

it.each(MODES.flatMap((m) => OLD.map((c) => ({ ...c, mode: m.mode, pull: m.pull }))))(
  '[CT-06zzzzj] head $mode: $name -> exit 0, reuse=$reuse, as before',
  (c) => {
    const r = runReuse({ runs: c.runs(), pull: c.pull }, { wait: c.wait });
    expect(r.findStatus, `the find step exits 0\n${r.out}`).toBe(0);
    expect(r.failed, r.out).toBe(false);
    expect(
      r.written.filter((l) => l.startsWith('reuse=')),
      r.out,
    ).toEqual([`reuse=${c.reuse}`]);
    expect(r.outputs['reuse'], r.out).toBe(c.reuse);
    expect(count(r, 'sleep'), r.out).toBeGreaterThanOrEqual(c.sleeps[0]);
    expect(count(r, 'sleep'), r.out).toBeLessThanOrEqual(c.sleeps[1]);
    for (const re of c.log) expect(r.out).toMatch(re);
    expect(r.out, 'nothing says the head moved').not.toMatch(/head moved/i);
    // The jobs after it: the heavy jobs run exactly when reuse is not true; the gate passes.
    const github = prGithub('labeled', '/w');
    for (const job of HEAVY) {
      expect(jobRuns(job, labelNeeds('success', r.outputs), github), job).toBe(c.reuse !== 'true');
    }
    const gate = gatePasses('success', r.outputs);
    expect(gate.pass, gate.out).toBe(true);
  },
);

it('[CT-06zzzzj] a verify-reuse that failed for another reason (no outputs) still lets every heavy job run on a label event', () => {
  const github = prGithub('labeled', '/w');
  for (const job of VERIFY_JOBS) {
    expect(jobRuns(job, labelNeeds('failure', {}), github), job).toBe(true);
  }
});

// --- 4. the push to main (B2) and the code events never read pulls/<number> --------------------

it('[CT-06zzzzj] push to main: B2 reuses as before and never reads pulls/<number>, even when it would answer another head', () => {
  const merged = {
    number: PR_NUMBER,
    state: 'closed',
    merged_at: '2026-11-08T07:00:00Z',
    merge_commit_sha: PUSH_SHA,
    base: { ref: 'main', sha: BASE_SHA, repo: { full_name: GH_REPO } },
    head: { ref: `chore/pr-${String(PR_NUMBER)}`, sha: H1, repo: { full_name: GH_REPO } },
  };
  const r = runReuse(
    {
      runs: [...noiseRuns(), codeRun(5001, 0, allJobs('success'))],
      pull: { moved: H2, movesAfter: 0 },
      commitPulls: { [PUSH_SHA]: [merged] },
    },
    { push: true, wait: 2 },
  );
  expect(r.findStatus, r.out).toBe(0);
  expect(r.failed, r.out).toBe(false);
  expect(r.outputs['reuse'], r.out).toBe('true');
  expect(count(r, 'commit-pulls'), 'B2 looks the pull request up from the pushed commit').toBe(1);
  expect(count(r, 'pull'), 'pulls/<number> is never read on a push').toBe(0);
  expect(count(r, 'sleep'), 'the push path never sleeps').toBe(0);
  expect(r.out).not.toMatch(/head moved/i);
});

it('[CT-06zzzzj] code events: verify-reuse does not run, and every verify job runs as before', () => {
  for (const action of ['opened', 'synchronize', 'reopened']) {
    const github = prGithub(action, '/w');
    expect(ghTruthy(ghEvaluate(jobIf('verify-reuse'), { github })), action).toBe(false);
    const needs: Needs = {
      'verify-reuse': { result: 'skipped', outputs: {} },
      'ledger-only-detect': { result: 'success', outputs: { only: 'false' } },
    };
    for (const job of VERIFY_JOBS)
      expect(jobRuns(job, needs, github), `${action}: ${job}`).toBe(true);
  }
});

// --- 5. permissions ----------------------------------------------------------------------------

it('[CT-06zzzzj] verify-reuse keeps exactly contents, actions and pull-requests read; nothing writes', () => {
  const perms = mapping(entry(requireJob('verify-reuse'), 'permissions', 4));
  expect(perms).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read' });
  expect(mapping(entry(LINES, 'permissions', 0))).toEqual({ contents: 'read' });
  const text = steps('verify-reuse')
    .map((s) => `${s.run ?? ''}\n${Object.values(s.env).join('\n')}`)
    .join('\n');
  expect(text).not.toMatch(/secrets\.(?!GITHUB_TOKEN\b)/);
  expect(text).not.toMatch(/(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)/i);
});

// --- 6. the workflow rules and the required check ----------------------------------------------

it('[CT-06zzzzj] the required status check of ci.yml is still ci-gate, which runs always()', () => {
  const bp = JSON.parse(readFileSync(join(REPO, 'ops/branch-protection.json'), 'utf8')) as {
    rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
  };
  const contexts = bp.rules
    .flatMap((r) => r.parameters?.required_status_checks ?? [])
    .map((c) => c.context);
  expect(contexts).toContain('ci-gate');
  expect(jobIf('ci-gate')).toBe('always()');
});

it('[CT-06zzzzj] check-workflows reports no problem for the workflows as they are', () => {
  expect(checkWorkflows(REPO)).toEqual([]);
});
