// CT-06zzzzf (D10-1024 B2, ci-load-plan §2 B2): on a push to main, verify-reuse of
// .github/workflows/ci.yml reuses the passes of the pull request that produced the pushed commit,
// read from the real file.
//
// Reuse holds only when ALL of these hold, for every one of the twelve heavy verify jobs:
//   1. `repos/<repo>/commits/<pushed sha>/pulls` lists exactly one pull request, and it is merged,
//      its base is main and its head repository (`head.repo.full_name`) is this repository;
//   2. a ci.yml run of event pull_request on that pull request's final head H, whose
//      `head_repository.full_name` is this repository, has the job's latest attempt `success`;
//   3. that run carries the unexpired artifact `verified-<job>-<tree>`, <tree> being exactly the
//      tree of this push's checkout.
// Anything else (a fork, a tree that differs, an expired or missing artifact, a job that did not
// pass, zero or several or unmerged pull requests, a base other than main, any API error, or only
// some of the jobs qualifying) means reuse=false: every job runs in full, and the step still
// exits 0. The push path never waits (no sleep). ci-gate and the required check names do not
// change.
//
// The `if:` values are evaluated with a small evaluator of the GitHub expression language (copied
// from ci-concurrency-workflow.test.ts). The run steps of verify-reuse are executed with bash under
// the context of a push to main, with a fake `gh` and a fake `sleep` first on PATH. The fake gh
// answers `gh api` GET for the endpoints listed at its routes from a scenario file and implements
// the jq subset of ci-concurrency-workflow.test.ts for `--jq` (the verify image has no jq); every
// other gh command, an unknown endpoint or a jq feature outside the subset fails loudly. The
// ci-gate Summarise step is executed with bash, unchanged in logic.
// The YAML helpers are line-based (no YAML dependency), as in ci-ledger-only-workflow.test.ts.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkWorkflows } from './check-workflows.ts';

const REPO = resolve(import.meta.dirname, '../..');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const LINES = CI.split('\n');
const SCRATCH = join(REPO, '.tmp', `ci-reuse-push-workflow-${process.pid}`);

/** The final head of the merged pull request. */
const PR_HEAD = 'a'.repeat(40);
/** An earlier head of the same pull request. */
const OLD_HEAD = 'c'.repeat(40);
/** The head of some other pull request. */
const OTHER_HEAD = '9'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const RUN_ID = 9000;
const PR_NUMBER = 2817;
const GH_REPO = 'o/r';
const FORK_REPO = 'evil/r';
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
] as const;
type VerifyJob = (typeof VERIFY_JOBS)[number];

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
    // Status functions: no step or job before the expressions evaluated here failed or was cancelled.
    case 'always':
    case 'success':
      return true;
    case 'failure':
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

type Ev = { name: string; ctx: Record<string, GhValue> };

function prEvent(action: string, number = 7): Ev {
  const head = { sha: PR_HEAD, ref: `chore/pr-${String(number)}`, repo: { full_name: GH_REPO } };
  return {
    name: `pull_request ${action} on PR #${String(number)}`,
    ctx: {
      github: {
        event_name: 'pull_request',
        ref: `refs/pull/${String(number)}/merge`,
        ref_name: `${String(number)}/merge`,
        ref_type: 'branch',
        head_ref: head.ref,
        base_ref: 'main',
        sha: 'e'.repeat(40),
        repository: GH_REPO,
        workflow: 'ci',
        run_id: String(RUN_ID),
        event: {
          action,
          number,
          pull_request: { number, head, base: { sha: BASE_SHA, ref: 'main' } },
        },
      },
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
    workflow_ref: `${GH_REPO}/.github/workflows/ci.yml@${ref}`,
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
      created: false,
      deleted: false,
      forced: false,
      head_commit: { id: sha, tree_id: tree },
      repository: { full_name: GH_REPO, default_branch: 'main' },
    },
  };
}

function pushEvent(): Ev {
  return { name: 'push to refs/heads/main', ctx: { github: pushGithub('f'.repeat(40), '', '/w') } };
}

// --- 1. verify-reuse also runs on a push to main -----------------------------------------------

it('[CT-06zzzzf] verify-reuse runs on a push to main and on labeled / unlabeled events, never on pull_request code events', () => {
  const cond = jobIf('verify-reuse');
  expect(cond, 'verify-reuse has an if').toMatch(/\S/);
  const truth = (ev: Ev): boolean => ghTruthy(ghEvaluate(cond, ev.ctx));
  expect(truth(pushEvent()), 'push to main').toBe(true);
  expect(truth(prEvent('labeled')), 'labeled').toBe(true);
  expect(truth(prEvent('unlabeled')), 'unlabeled').toBe(true);
  for (const a of ['opened', 'synchronize', 'reopened']) expect(truth(prEvent(a)), a).toBe(false);
});

// --- 5. permissions ----------------------------------------------------------------------------

it('[CT-06zzzzf] verify-reuse adds only pull-requests: read; every permission stays read-only; the workflow default is unchanged', () => {
  const perms = mapping(entry(requireJob('verify-reuse'), 'permissions', 4));
  expect(perms).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read' });
  for (const v of Object.values(perms)) expect(v).toBe('read');
  expect(mapping(entry(LINES, 'permissions', 0))).toEqual({ contents: 'read' });
  // No step of verify-reuse writes through the API or uses another credential than the job token.
  const text = steps('verify-reuse')
    .map((s) => `${s.run ?? ''}\n${Object.values(s.env).join('\n')}`)
    .join('\n');
  expect(text).not.toMatch(/secrets\.(?!GITHUB_TOKEN\b)/);
  expect(text).not.toMatch(/(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)/i);
});

// --- 6a. the heavy jobs are skipped on a push exactly when verify-reuse said reuse=true ---------

function heavyIfCtx(reuseResult: string, reuse: string): Record<string, GhValue> {
  return {
    github: pushGithub('f'.repeat(40), '', '/w'),
    needs: {
      'verify-reuse': { result: reuseResult, outputs: reuseResult === 'success' ? { reuse } : {} },
      'ledger-only-detect': { result: 'skipped', outputs: {} },
    },
  };
}

it.each(VERIFY_JOBS.map((job) => ({ job })))(
  '[CT-06zzzzf] on a push, $job is skipped only when verify-reuse succeeded with reuse=true',
  ({ job }) => {
    const cond = jobIf(job);
    expect(cond, `${job} has an if`).toMatch(/\S/);
    const runs = (result: string, reuse: string): boolean =>
      ghTruthy(ghEvaluate(cond, heavyIfCtx(result, reuse)));
    expect(runs('success', 'true'), 'reuse=true: skipped').toBe(false);
    expect(runs('success', 'false'), 'reuse=false: runs').toBe(true);
    expect(runs('success', ''), 'no output: runs').toBe(true);
    expect(runs('failure', ''), 'verify-reuse failed: runs').toBe(true);
  },
);

// The fake gh (CommonJS, run with this Node). Written without template literals on purpose. The
// jq subset is the one of ci-concurrency-workflow.test.ts; the endpoints add pull requests,
// run attempts, head repositories and expired artifacts.
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
// kinds: pulls (commits/<sha>/pulls, pulls/<n>), runs (workflow run lists and single runs),
// jobs (jobs of a run or of one attempt), artifacts (artifacts of a run, or of the repository).
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

const prefix = 'repos/' + state.repo + '/';
if (!p.startsWith(prefix)) die('no route for ' + p);
const rest = p.slice(prefix.length);
const own = state.repos[0];
function repoById(id) { const r = state.repos.find(function (x) { return x.id === id; }); if (!r) die('no repository ' + id); return r; }
function lastPage() { return Number(q.get('page') || '1') > 1; }
function allPulls() { const out = []; for (const k of Object.keys(state.pulls)) for (const pr of state.pulls[k]) out.push(pr); return out; }
function fullPull(pr) { return Object.assign({}, pr, { merged: pr.merged_at !== null }); }
function findRun(id) { const r = state.runs.find(function (x) { return String(x.id) === String(id); }); if (!r) die('HTTP 404: no run ' + id); return r; }
function workflowId(r) { return r.workflow === 'ci.yml' ? 101 : 202; }
function attemptsOf(r) { return r.attempts.length === 0 ? [{}] : r.attempts; }
function runConclusion(r) {
  if (r.pending) return null;
  const last = attemptsOf(r)[attemptsOf(r).length - 1];
  const cs = Object.keys(last).map(function (k) { return last[k]; });
  if (cs.indexOf('failure') >= 0) return 'failure';
  if (cs.indexOf('cancelled') >= 0) return 'cancelled';
  return 'success';
}
function runObj(r) {
  const head = r.headRepo === null ? null : repoById(r.headRepo);
  const prs = r.pr !== null && r.headRepo === own.id && r.event === 'pull_request'
    ? [{ number: r.pr, head: { sha: r.head, ref: 'chore/x', repo: { id: own.id, name: 'r' } }, base: { sha: state.baseSha, ref: 'main', repo: { id: own.id, name: 'r' } } }]
    : [];
  return {
    id: r.id, name: r.workflow.replace(/\.yml$/, ''), path: '.github/workflows/' + r.workflow,
    workflow_id: workflowId(r), head_sha: r.head, head_branch: r.event === 'push' ? 'main' : 'chore/x', event: r.event,
    status: r.pending ? 'in_progress' : 'completed', conclusion: runConclusion(r), run_attempt: attemptsOf(r).length,
    repository: own, head_repository: head, pull_requests: prs,
  };
}
function listRuns(runs) {
  let rs = runs.slice().sort(function (a, b) { return b.id - a.id; }).map(runObj);
  if (q.get('head_sha')) rs = rs.filter(function (r) { return r.head_sha === q.get('head_sha'); });
  if (q.get('event')) rs = rs.filter(function (r) { return r.event === q.get('event'); });
  if (q.get('branch')) rs = rs.filter(function (r) { return r.head_branch === q.get('branch'); });
  if (q.get('status')) rs = rs.filter(function (r) { return r.status === q.get('status') || r.conclusion === q.get('status'); });
  if (lastPage()) rs = [];
  return { total_count: rs.length, workflow_runs: rs };
}
function jobObjs(r, attempt) {
  const jobs = attemptsOf(r)[attempt - 1];
  if (jobs === undefined) die('HTTP 404: no attempt ' + attempt + ' of run ' + r.id);
  return Object.keys(jobs).map(function (name, i) {
    return { id: r.id * 1000 + attempt * 100 + i, run_id: r.id, run_attempt: attempt, workflow_name: 'ci', name: name, head_sha: r.head,
      status: r.pending ? 'in_progress' : 'completed', conclusion: r.pending ? null : jobs[name] };
  });
}
function artifactObjs(r) {
  return r.artifacts.map(function (a, i) {
    return { id: r.id * 100 + i, name: a.name, size_in_bytes: 41, expired: a.expired,
      workflow_run: { id: r.id, repository_id: own.id, head_repository_id: r.headRepo, head_branch: 'chore/x', head_sha: r.head } };
  });
}
function nameFilter(arts) { return q.get('name') ? arts.filter(function (a) { return a.name === q.get('name'); }) : arts; }

let m; let kind; let build;
if ((m = /^commits\/([^/]+)\/pulls$/.exec(rest))) {
  const sha = m[1]; kind = 'pulls';
  build = function () { return lastPage() ? [] : (state.pulls[sha] || []); };
} else if ((m = /^pulls\/(\d+)$/.exec(rest))) {
  const n = Number(m[1]); kind = 'pulls';
  build = function () { const pr = allPulls().find(function (x) { return x.number === n; }); if (!pr) die('HTTP 404: no pull ' + n); return fullPull(pr); };
} else if ((m = /^actions\/workflows\/([^/]+)\/runs$/.exec(rest))) {
  const wf = m[1]; kind = 'runs';
  build = function () { return listRuns(state.runs.filter(function (r) { return r.workflow === wf || String(workflowId(r)) === wf; })); };
} else if (rest === 'actions/runs') {
  kind = 'runs'; build = function () { return listRuns(state.runs); };
} else if ((m = /^actions\/runs\/(\d+)$/.exec(rest))) {
  const id = m[1]; kind = 'runs'; build = function () { return runObj(findRun(id)); };
} else if ((m = /^actions\/runs\/(\d+)\/jobs$/.exec(rest))) {
  const id = m[1]; kind = 'jobs';
  build = function () {
    const r = findRun(id); const filter = q.get('filter') || 'latest';
    if (filter !== 'latest' && filter !== 'all') die('HTTP 422: bad filter ' + filter);
    let jobs = [];
    if (filter === 'latest') jobs = jobObjs(r, attemptsOf(r).length);
    else for (let n = 1; n <= attemptsOf(r).length; n++) jobs = jobs.concat(jobObjs(r, n));
    if (lastPage()) jobs = [];
    return { total_count: jobs.length, jobs: jobs };
  };
} else if ((m = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(rest))) {
  const id = m[1]; const n = Number(m[2]); kind = 'jobs';
  build = function () { const jobs = lastPage() ? [] : jobObjs(findRun(id), n); return { total_count: jobs.length, jobs: jobs }; };
} else if ((m = /^actions\/runs\/(\d+)\/artifacts$/.exec(rest))) {
  const id = m[1]; kind = 'artifacts';
  build = function () { const arts = lastPage() ? [] : nameFilter(artifactObjs(findRun(id))); return { total_count: arts.length, artifacts: arts }; };
} else if (rest === 'actions/artifacts') {
  kind = 'artifacts';
  build = function () {
    let arts = [];
    for (const r of state.runs.slice().sort(function (a, b) { return b.id - a.id; })) arts = arts.concat(artifactObjs(r));
    arts = lastPage() ? [] : nameFilter(arts);
    return { total_count: arts.length, artifacts: arts };
  };
} else die('no route for ' + p);

const previous = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0;
fs.appendFileSync(logFile, JSON.stringify({ kind: kind, path: p + url.search, jq: jq }) + '\n');
if (state.fail.indexOf(kind) >= 0 || state.failAt === previous + 1) {
  process.stderr.write('gh: Server Error (HTTP 502)\n');
  process.exit(1);
}
const body = build();
if (jq === null) { process.stdout.write(JSON.stringify(body) + '\n'); }
else {
  let outs;
  try { outs = ev(parse(jq), body); } catch (e) { die('jq: ' + (e && e.message ? e.message : String(e))); }
  process.stdout.write(outs.map(function (v) { return tostr(v) + '\n'; }).join(''));
}
`;

// --- scenarios ---------------------------------------------------------------------------------

type Repo = { id: number; full_name: string; fork: boolean };
const OWN: Repo = { id: 1, full_name: GH_REPO, fork: false };
const FORK: Repo = { id: 2, full_name: FORK_REPO, fork: true };
/** A repository of another name that is not marked as a fork: only the name tells it apart. */
const LOOKALIKE: Repo = { id: 3, full_name: FORK_REPO, fork: false };

type Pr = {
  number: number;
  state: 'open' | 'closed';
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { ref: string; sha: string; repo: Repo };
  head: { ref: string; sha: string; repo: Repo | null };
};

type FakeRun = {
  id: number;
  workflow: string;
  event: 'pull_request' | 'push';
  head: string;
  /** The id of the head repository (OWN, FORK or LOOKALIKE), or null. */
  headRepo: number | null;
  pr: number | null;
  /** In progress: never completes. */
  pending: boolean;
  /** The job conclusions of each attempt, oldest first. */
  attempts: Record<string, string>[];
  artifacts: { name: string; expired: boolean }[];
};

type Scenario = {
  pulls: Pr[];
  runs: FakeRun[];
  /** Every call of these kinds fails (pulls, runs, jobs, artifacts). */
  fail?: string[];
  /** The n-th gh call (1-based) fails. */
  failAt?: number;
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
  // The push path must never sleep: the fake sleep records the call and fails at once, so a wait
  // taken by mistake ends the step (non-zero) instead of depending on how fast this machine is.
  writeFileSync(
    join(BIN, 'sleep'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_SLEEP_LOG"\necho 'fake sleep: the push path must not sleep' >&2\nexit 1\n`,
  );
  chmodSync(join(BIN, 'sleep'), 0o755);
  // The checkout of the pushed commit: its HEAD tree is the tree of this push.
  CHECKOUT = join(SCRATCH, 'checkout');
  mkdirSync(CHECKOUT, { recursive: true });
  git(CHECKOUT, ['init', '-q', '-b', 'main']);
  writeFileSync(join(CHECKOUT, 'README.md'), '# fixture\n');
  git(CHECKOUT, ['add', '-A']);
  git(CHECKOUT, ['commit', '-q', '-m', 'squash of PR']);
  TREE = git(CHECKOUT, ['rev-parse', 'HEAD^{tree}']);
  PUSH_SHA = git(CHECKOUT, ['rev-parse', 'HEAD']);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** The pull request that produced the pushed commit, merged into main from this repository. */
function pull(
  o: {
    number?: number;
    head?: string;
    headRepo?: Repo | null;
    base?: string;
    merged?: boolean;
    open?: boolean;
  } = {},
): Pr {
  const merged = o.merged ?? true;
  return {
    number: o.number ?? PR_NUMBER,
    state: o.open === true ? 'open' : 'closed',
    merged_at: merged ? '2026-11-08T07:00:00Z' : null,
    merge_commit_sha: merged ? PUSH_SHA : null,
    base: { ref: o.base ?? 'main', sha: BASE_SHA, repo: OWN },
    head: {
      ref: `chore/pr-${String(o.number ?? PR_NUMBER)}`,
      sha: o.head ?? PR_HEAD,
      repo: o.headRepo === undefined ? OWN : o.headRepo,
    },
  };
}

function jobsAll(
  conclusion: string,
  overrides: Partial<Record<VerifyJob, string>> = {},
): Record<string, string> {
  const jobs: Record<string, string> = { 'verify-reuse': conclusion };
  jobs['ledger-only-detect'] = conclusion;
  for (const j of VERIFY_JOBS) jobs[j] = overrides[j] ?? conclusion;
  jobs['guard-git'] = conclusion;
  jobs['ci-gate'] = conclusion;
  return jobs;
}

type ArtifactOverride = { tree?: string; expired?: boolean; missing?: boolean };

/** The `verified-<job>-<tree>` artifacts of a passing run, `tree` defaulting to this push's tree. */
function verified(
  tree?: string,
  overrides: Partial<Record<VerifyJob, ArtifactOverride>> = {},
): { name: string; expired: boolean }[] {
  const out: { name: string; expired: boolean }[] = [];
  for (const j of VERIFY_JOBS) {
    const o = overrides[j] ?? {};
    if (o.missing === true) continue;
    out.push({ name: `verified-${j}-${o.tree ?? tree ?? TREE}`, expired: o.expired ?? false });
  }
  return out;
}

/** A completed code run (opened / synchronize) of ci.yml on the final head that passed. */
function codeRun(id: number, o: Partial<FakeRun> = {}): FakeRun {
  return {
    id,
    workflow: 'ci.yml',
    event: 'pull_request',
    head: PR_HEAD,
    headRepo: OWN.id,
    pr: PR_NUMBER,
    pending: false,
    attempts: [jobsAll('success')],
    artifacts: verified(),
    ...o,
  };
}

/** The label run on the final head (owner approval label): verify jobs skipped, no artifacts. */
function labelRun(id: number, o: Partial<FakeRun> = {}): FakeRun {
  const jobs: Record<string, string> = { 'verify-reuse': 'success' };
  jobs['ledger-only-detect'] = 'success';
  for (const j of VERIFY_JOBS) jobs[j] = 'skipped';
  jobs['guard-git'] = 'success';
  jobs['ci-gate'] = 'success';
  return codeRun(id, { attempts: [jobs], artifacts: [], ...o });
}

/** This push run itself: in progress. */
function selfRun(): FakeRun {
  return {
    id: RUN_ID,
    workflow: 'ci.yml',
    event: 'push',
    head: PUSH_SHA,
    headRepo: OWN.id,
    pr: null,
    pending: true,
    attempts: [{ 'verify-reuse': 'in_progress' }],
    artifacts: [],
  };
}

/** Noise present in every scenario; none of it may count for reuse or make the push path wait. */
function noise(): FakeRun[] {
  return [
    // An earlier code run on the final head, cancelled by the next push to the pull request.
    codeRun(4000, { attempts: [jobsAll('cancelled')], artifacts: [] }),
    // A ci.yml run of another pull request that never ends.
    codeRun(6000, { head: OTHER_HEAD, pr: 2900, pending: true, artifacts: [] }),
    // Another workflow on the final head that never ends.
    codeRun(7000, {
      workflow: 'protected-paths.yml',
      pending: true,
      attempts: [{ 'protected-paths': 'success' }],
      artifacts: [],
    }),
  ];
}

/** Reuse holds: one merged own-repo PR; its code run on the final head passed on this tree. */
function good(): Scenario {
  return { pulls: [pull()], runs: [...noise(), codeRun(5001), labelRun(5002)] };
}

/** `tree` with its last character replaced. */
function oneCharOff(tree: string): string {
  const last = tree.slice(-1);
  return tree.slice(0, -1) + (last === '0' ? '1' : '0');
}

type Call = { kind: string; path: string; jq: string | null };
type PushRun = {
  status: number | null;
  out: string;
  reuse: string;
  sleeps: number;
  calls: Call[];
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

/** Runs the steps of verify-reuse, as a push to main would, against the fake gh and sleep. */
function runPush(s: Scenario): PushRun {
  const dir = join(SCRATCH, `push-${String(++runCount)}`);
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, 'state.json');
  const ghLog = join(dir, 'gh.log');
  const sleepLog = join(dir, 'sleep.log');
  writeFileSync(
    stateFile,
    JSON.stringify({
      repo: GH_REPO,
      repos: [OWN, FORK, LOOKALIKE],
      baseSha: BASE_SHA,
      pulls: { [PUSH_SHA]: s.pulls },
      runs: [selfRun(), ...s.runs],
      fail: s.fail ?? [],
      failAt: s.failAt ?? null,
    }),
  );
  const stepsCtx: Record<string, GhValue> = {};
  const ctx: Record<string, GhValue> = {
    github: pushGithub(PUSH_SHA, TREE, CHECKOUT),
    runner: { temp: dir, os: 'Linux', arch: 'X64' },
    secrets: { GITHUB_TOKEN: 'not-a-real-token' },
    env: {},
    vars: {},
    job: { status: 'success' },
    steps: stepsCtx,
    inputs: {},
  };
  const body = requireJob('verify-reuse');
  const jobEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(mapping(entry(body, 'env', 4)))) {
    jobEnv[k] = interpolate(v, ctx);
  }
  let status: number | null = 0;
  let out = '';
  for (const [i, st] of steps('verify-reuse').entries()) {
    if (st.run === null) continue;
    if (st.cond !== null) {
      const cond = expressionOf(st.cond) ?? st.cond;
      if (!ghTruthy(ghEvaluate(cond, ctx))) continue;
    }
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
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_SHA: PUSH_SHA,
          GITHUB_REPOSITORY: GH_REPO,
          GITHUB_RUN_ID: String(RUN_ID),
          GITHUB_API_URL: 'https://api.invalid',
          RUNNER_TEMP: dir,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          ...jobEnv,
          ...env,
          // The ledger's limit and interval: a wait taken by mistake reaches the fake sleep.
          [WAIT_VAR]: '3600',
          [POLL_VAR]: '60',
          FAKE_GH_STATE: stateFile,
          FAKE_GH_LOG: ghLog,
          FAKE_SLEEP_LOG: sleepLog,
        },
      },
    );
    out += `${res.stdout}\n${res.stderr}`;
    status = res.status;
    const outputs = readOutputs(output);
    if (st.id !== null) {
      stepsCtx[st.id] = {
        outputs,
        outcome: status === 0 ? 'success' : 'failure',
        conclusion: status === 0 ? 'success' : 'failure',
      };
    }
    if (status !== 0) break;
  }
  const outputsDecl = mapping(entry(body, 'outputs', 4));
  expect(outputsDecl['reuse'], 'verify-reuse declares the output reuse').toBeDefined();
  const reuse = interpolate(outputsDecl['reuse'] ?? '', ctx);
  const lines = (file: string): string[] =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return {
    status,
    out,
    reuse,
    sleeps: lines(sleepLog).length,
    calls: lines(ghLog).map((l) => JSON.parse(l) as Call),
  };
}

function expectFullRun(r: PushRun): void {
  expect(r.status, `the step exits 0\n${r.out}`).toBe(0);
  expect(r.reuse, `reuse=false\n${r.out}`).toBe('false');
  expect(r.sleeps, 'the push path never sleeps').toBe(0);
  expect(r.out, 'the log says the jobs run in full').toMatch(/in full/i);
}

// --- 2. reuse on a push to main ----------------------------------------------------------------

it('[CT-06zzzzf] push to main: one merged own-repo PR whose final-head ci.yml pull_request run passed all twelve jobs on this very tree -> reuse=true, without waiting', () => {
  const r = runPush(good());
  expect(r.status, r.out).toBe(0);
  expect(r.reuse, r.out).toBe('true');
  expect(r.sleeps, 'the push path never sleeps').toBe(0);
  // The pull request is looked up from the pushed commit.
  expect(
    r.calls.some(
      (c) => c.kind === 'pulls' && c.path.startsWith(`repos/${GH_REPO}/commits/${PUSH_SHA}/pulls`),
    ),
    JSON.stringify(r.calls),
  ).toBe(true);
  // The decision reads the pull request, the runs, their jobs and their artifacts.
  const kinds = new Set(r.calls.map((c) => c.kind));
  for (const k of ['pulls', 'runs', 'jobs', 'artifacts']) expect(kinds.has(k), k).toBe(true);
  // The log names the pull request and the run whose passes are reused.
  expect(r.out).toContain(String(PR_NUMBER));
  expect(r.out).toContain('5001');
});

it('[CT-06zzzzf] push to main: a job whose first attempt failed and whose latest attempt passed counts as passed -> reuse=true', () => {
  const s = good();
  s.runs = [
    ...noise(),
    codeRun(5001, {
      attempts: [jobsAll('success', { 'verify-unit': 'failure' }), jobsAll('success')],
    }),
    labelRun(5002),
  ];
  const r = runPush(s);
  expect(r.status, r.out).toBe(0);
  expect(r.reuse, r.out).toBe('true');
  expect(r.sleeps).toBe(0);
});

// --- 4. no waiting on a push -------------------------------------------------------------------

it('[CT-06zzzzf] push to main never takes the label-event wait: unfinished ci.yml runs on the PR head and elsewhere do not make it sleep', () => {
  const s = good();
  s.runs = [...s.runs, labelRun(5003, { pending: true })];
  const r = runPush(s);
  expect(r.status, r.out).toBe(0);
  expect(r.sleeps, 'sleep is never called on a push').toBe(0);
  expect(r.out).not.toMatch(/waiting for/i);
  expect(r.out).not.toMatch(/wait limit/i);
  expect(r.reuse, r.out).toBe('true');
});

// --- 3. every other case runs in full ----------------------------------------------------------

type Case = { name: string; make: () => Scenario };

function withRuns(runs: () => FakeRun[], pulls?: () => Pr[]): () => Scenario {
  return () => ({ pulls: pulls === undefined ? [pull()] : pulls(), runs: [...noise(), ...runs()] });
}

const FULL_RUN_CASES: Case[] = [
  // a. forks
  {
    name: 'a: the pull request comes from a fork (head.repo evil/r), and so do its runs',
    make: withRuns(
      () => [codeRun(5001, { headRepo: FORK.id }), labelRun(5002, { headRepo: FORK.id })],
      () => [pull({ headRepo: FORK })],
    ),
  },
  {
    name: 'a: the pull request comes from a fork although its runs name this repository',
    make: withRuns(
      () => [codeRun(5001), labelRun(5002)],
      () => [pull({ headRepo: FORK })],
    ),
  },
  {
    name: 'a: the head repository of the pull request is evil/r, not marked as a fork',
    make: withRuns(
      () => [codeRun(5001), labelRun(5002)],
      () => [pull({ headRepo: LOOKALIKE })],
    ),
  },
  {
    name: 'a: the head repository of the pull request is gone (null)',
    make: withRuns(
      () => [codeRun(5001), labelRun(5002)],
      () => [pull({ headRepo: null })],
    ),
  },
  {
    name: 'a: own-repo pull request, but the run that carries the artifacts has a fork as head_repository',
    make: withRuns(() => [codeRun(5001, { headRepo: FORK.id }), labelRun(5002)]),
  },
  {
    name: 'a: own-repo pull request, but the run that carries the artifacts has head_repository evil/r (not marked fork)',
    make: withRuns(() => [codeRun(5001, { headRepo: LOOKALIKE.id }), labelRun(5002)]),
  },
  {
    name: 'a: the passing run on the final head is another workflow file, not ci.yml',
    make: withRuns(() => [codeRun(5001, { workflow: 'other.yml' }), labelRun(5002)]),
  },
  // b. trees
  {
    name: 'b: every artifact names a tree that differs in its last character',
    make: withRuns(() => [
      codeRun(5001, { artifacts: verified(oneCharOff(TREE)) }),
      labelRun(5002),
    ]),
  },
  {
    name: 'b: every artifact names this tree plus one more character',
    make: withRuns(() => [codeRun(5001, { artifacts: verified(`${TREE}0`) }), labelRun(5002)]),
  },
  {
    name: 'b: every artifact names this tree without its last character',
    make: withRuns(() => [
      codeRun(5001, { artifacts: verified(TREE.slice(0, -1)) }),
      labelRun(5002),
    ]),
  },
  {
    name: 'b: only the artifact of verify-props-sha-2 names a tree one character off',
    make: withRuns(() => [
      codeRun(5001, {
        artifacts: verified(undefined, { 'verify-props-sha-2': { tree: oneCharOff(TREE) } }),
      }),
      labelRun(5002),
    ]),
  },
  {
    name: 'b: this tree was verified on an earlier head of the pull request; the final head has another tree',
    make: withRuns(() => [
      codeRun(4500, { head: OLD_HEAD }),
      codeRun(5001, { artifacts: verified(oneCharOff(TREE)) }),
      labelRun(5002),
    ]),
  },
  {
    name: "b: this tree was verified in another pull request's run (another head_sha); the final head has another tree",
    make: withRuns(() => [
      codeRun(6100, { head: OTHER_HEAD, pr: 2900 }),
      codeRun(5001, { artifacts: verified(oneCharOff(TREE)) }),
      labelRun(5002),
    ]),
  },
  {
    name: 'b: this tree was verified by an earlier push run on main; the final head has no artifacts',
    make: withRuns(() => [
      codeRun(3001, { event: 'push', head: 'd'.repeat(40), pr: null }),
      codeRun(5001, { artifacts: [] }),
      labelRun(5002),
    ]),
  },
  // c. expired or missing
  {
    name: 'c: every artifact is expired',
    make: withRuns(() => [
      codeRun(5001, { artifacts: verified().map((a) => ({ ...a, expired: true })) }),
      labelRun(5002),
    ]),
  },
  {
    name: 'c: only the artifact of verify-unit is expired',
    make: withRuns(() => [
      codeRun(5001, { artifacts: verified(undefined, { 'verify-unit': { expired: true } }) }),
      labelRun(5002),
    ]),
  },
  {
    name: 'c: no artifact at all',
    make: withRuns(() => [codeRun(5001, { artifacts: [] }), labelRun(5002)]),
  },
  {
    name: 'c: only the artifact of verify-int-2 is missing',
    make: withRuns(() => [
      codeRun(5001, { artifacts: verified(undefined, { 'verify-int-2': { missing: true } }) }),
      labelRun(5002),
    ]),
  },
  // d. a job that did not pass
  ...(['failure', 'cancelled', 'skipped'] as const).map((c) => ({
    name: `d: the latest attempt of verify-spec-2 is ${c} (its artifact is there)`,
    make: withRuns(() => [
      codeRun(5001, { attempts: [jobsAll('success', { 'verify-spec-2': c })] }),
      labelRun(5002),
    ]),
  })),
  {
    name: 'd: verify-unit passed in attempt 1 but its latest attempt failed (the artifact of attempt 1 is there)',
    make: withRuns(() => [
      codeRun(5001, {
        attempts: [jobsAll('success'), jobsAll('success', { 'verify-unit': 'failure' })],
      }),
      labelRun(5002),
    ]),
  },
  // e. which pull request
  {
    name: 'e: no pull request is associated with the pushed commit',
    make: withRuns(
      () => [codeRun(5001), labelRun(5002)],
      () => [],
    ),
  },
  {
    name: 'e: two merged own-repo pull requests are associated with the pushed commit, both with passes on this tree',
    make: withRuns(
      () => [codeRun(5001), labelRun(5002), codeRun(6200, { head: OTHER_HEAD, pr: 2818 })],
      () => [pull(), pull({ number: 2818, head: OTHER_HEAD })],
    ),
  },
  {
    name: 'e: the pull request is still open (not merged)',
    make: withRuns(
      () => [codeRun(5001), labelRun(5002)],
      () => [pull({ merged: false, open: true })],
    ),
  },
  {
    name: 'e: the pull request was closed without merging',
    make: withRuns(
      () => [codeRun(5001), labelRun(5002)],
      () => [pull({ merged: false })],
    ),
  },
  {
    name: 'e: the pull request was merged into release, not main',
    make: withRuns(
      () => [codeRun(5001), labelRun(5002)],
      () => [pull({ base: 'release' })],
    ),
  },
  // g. all or nothing
  {
    name: 'g: six jobs qualify, the other six each fail one condition',
    make: withRuns(() => [
      codeRun(5001, {
        attempts: [
          jobsAll('success', {
            'verify-props-3': 'cancelled',
            'verify-props-sha-1': 'failure',
            'verify-int-2': 'skipped',
          }),
        ],
        artifacts: verified(undefined, {
          'verify-props-sha-2': { expired: true },
          'verify-props-sha-3': { missing: true },
          'verify-int-1': { tree: oneCharOff(TREE) },
        }),
      }),
      labelRun(5002),
    ]),
  },
  {
    name: 'g: eleven jobs qualify, verify-static has no artifact',
    make: withRuns(() => [
      codeRun(5001, { artifacts: verified(undefined, { 'verify-static': { missing: true } }) }),
      labelRun(5002),
    ]),
  },
];

it.each(FULL_RUN_CASES)(
  '[CT-06zzzzf] push to main runs in full (reuse=false, exit 0, no sleep) when $name',
  ({ make }) => {
    expectFullRun(runPush(make()));
  },
);

// --- 3f. API errors ----------------------------------------------------------------------------

it.each(['pulls', 'runs', 'jobs', 'artifacts'].map((kind) => ({ kind })))(
  '[CT-06zzzzf] push to main runs in full (reuse=false, exit 0) when every $kind API call fails',
  ({ kind }) => {
    const r = runPush({ ...good(), fail: [kind] });
    expect(
      r.calls.some((c) => c.kind === kind),
      `a ${kind} call was made\n${JSON.stringify(r.calls)}`,
    ).toBe(true);
    expectFullRun(r);
  },
);

it('[CT-06zzzzf] push to main runs in full (reuse=false, exit 0) when only the first or only the last API call fails', () => {
  const ok = runPush(good());
  expect(ok.reuse, ok.out).toBe('true');
  const total = ok.calls.length;
  expect(total).toBeGreaterThanOrEqual(2);
  for (const failAt of [1, total]) {
    const r = runPush({ ...good(), failAt });
    expect(r.calls.length, `call ${String(failAt)} was reached`).toBeGreaterThanOrEqual(failAt);
    expectFullRun(r);
  }
});

// --- 6b. ci-gate: the Summarise decision and the required check names are unchanged ------------

/** The env variable of each verify job in Summarise, in the order it is checked. */
const GATE_VARS: [string, VerifyJob][] = [
  ['STATIC', 'verify-static'],
  ['UNIT', 'verify-unit'],
  ['SPEC1', 'verify-spec-1'],
  ['SPEC2', 'verify-spec-2'],
  ['PROPS1', 'verify-props-1'],
  ['PROPS2', 'verify-props-2'],
  ['PROPS3', 'verify-props-3'],
  ['PROPSSHA1', 'verify-props-sha-1'],
  ['PROPSSHA2', 'verify-props-sha-2'],
  ['PROPSSHA3', 'verify-props-sha-3'],
  ['INT1', 'verify-int-1'],
  ['INT2', 'verify-int-2'],
];
// Spelled from its parts: test-guard (no-skip-only) matches the dot-only text.
const LEDGER_OUTPUT = ['needs.ledger-only-detect.outputs', 'only'].join('.');

/** The decision lines of Summarise as they were before CT-06zzzzf (comments and echo left out). */
const GATE_DECISION = [
  'reused() { [ "$REUSE_RESULT" = success ] && [ "$REUSE" = true ] && [ "$1" = skipped ]; }',
  'ledger_only() {',
  '[ "$EVENT" = pull_request ] && [ "$LEDGER_RESULT" = success ] &&',
  '[ "$LEDGER_ONLY" = true ] && [ "$1" = skipped ]',
  '}',
  ...GATE_VARS.map(([v]) =>
    v === 'STATIC'
      ? `[ "$${v}" = success ] || reused "$${v}" || exit 1`
      : `[ "$${v}" = success ] || reused "$${v}" || ledger_only "$${v}" || exit 1`,
  ),
  'if [ "$EVENT" = pull_request ]; then',
  '[ "$GUARD" = success ] || exit 1',
  'else',
  '[ "$GUARD" = skipped ] || [ "$GUARD" = success ] || exit 1',
  'fi',
];

function summarise(): Step {
  const s = steps('ci-gate').find((x) => x.name === 'Summarise');
  expect(s, 'ci-gate has the step Summarise').toBeDefined();
  expect(s?.run, 'Summarise has a run script').not.toBeNull();
  return s as Step;
}

it('[CT-06zzzzf] ci-gate keeps if: always(), its needs, the Summarise env and the Summarise decision lines', () => {
  expect(jobIf('ci-gate')).toBe('always()');
  const needs = (entry(requireJob('ci-gate'), 'needs', 4)?.block ?? [])
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
  expect(new Set(needs)).toEqual(
    new Set([...VERIFY_JOBS, 'guard-git', 'verify-reuse', 'ledger-only-detect']),
  );
  const s = summarise();
  const expectedEnv: Record<string, string> = {};
  for (const [v, job] of GATE_VARS) expectedEnv[v] = `\${{ needs.${job}.result }}`;
  expectedEnv['GUARD'] = '${{ needs.guard-git.result }}';
  expectedEnv['REUSE_RESULT'] = '${{ needs.verify-reuse.result }}';
  expectedEnv['REUSE'] = '${{ needs.verify-reuse.outputs.reuse }}';
  expectedEnv['EVENT'] = '${{ github.event_name }}';
  expectedEnv['LEDGER_RESULT'] = '${{ needs.ledger-only-detect.result }}';
  expectedEnv['LEDGER_ONLY'] = `\${{ ${LEDGER_OUTPUT} }}`;
  expect(s.env).toEqual(expectedEnv);
  const decision = (s.run ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('echo '));
  expect(decision).toEqual(GATE_DECISION);
});

it('[CT-06zzzzf] the required status check of ci.yml is still ci-gate', () => {
  const bp = JSON.parse(readFileSync(join(REPO, 'ops/branch-protection.json'), 'utf8')) as {
    rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
  };
  const contexts = bp.rules
    .flatMap((r) => r.parameters?.required_status_checks ?? [])
    .map((c) => c.context);
  expect(contexts).toContain('ci-gate');
  expect(requireJob('ci-gate').length).toBeGreaterThan(0);
});

type Gate = {
  name: string;
  event: string;
  reuse: [string, string];
  verify: Partial<Record<string, string>> & { all: string };
  guard: string;
  ledger: [string, string];
  pass: boolean;
};

const GATES: Gate[] = [
  {
    name: 'push, reuse=true, every verify job skipped, guard-git skipped',
    event: 'push',
    reuse: ['success', 'true'],
    verify: { all: 'skipped' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: true,
  },
  {
    name: 'push, reuse=true, verify-static ran and passed, the others skipped, guard-git skipped',
    event: 'push',
    reuse: ['success', 'true'],
    verify: { all: 'skipped', STATIC: 'success' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: true,
  },
  {
    name: 'push, reuse=true, every verify job skipped, guard-git success',
    event: 'push',
    reuse: ['success', 'true'],
    verify: { all: 'skipped' },
    guard: 'success',
    ledger: ['skipped', ''],
    pass: true,
  },
  {
    name: 'push, reuse=false, every verify job skipped',
    event: 'push',
    reuse: ['success', 'false'],
    verify: { all: 'skipped' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: false,
  },
  {
    name: 'push, reuse=false, one verify job skipped, the others passed',
    event: 'push',
    reuse: ['success', 'false'],
    verify: { all: 'success', INT2: 'skipped' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: false,
  },
  {
    name: 'push, verify-reuse failed (no output), every verify job skipped',
    event: 'push',
    reuse: ['failure', ''],
    verify: { all: 'skipped' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: false,
  },
  {
    name: 'push, verify-reuse failed although its output says true, every verify job skipped',
    event: 'push',
    reuse: ['failure', 'true'],
    verify: { all: 'skipped' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: false,
  },
  {
    name: 'push, verify-reuse failed, every verify job ran and passed',
    event: 'push',
    reuse: ['failure', ''],
    verify: { all: 'success' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: true,
  },
  {
    name: 'push, reuse=false, every verify job ran and passed',
    event: 'push',
    reuse: ['success', 'false'],
    verify: { all: 'success' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: true,
  },
  {
    name: 'push, reuse=true, one verify job failed',
    event: 'push',
    reuse: ['success', 'true'],
    verify: { all: 'skipped', UNIT: 'failure' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: false,
  },
  {
    name: 'push, reuse=true, verify-static cancelled',
    event: 'push',
    reuse: ['success', 'true'],
    verify: { all: 'skipped', STATIC: 'cancelled' },
    guard: 'skipped',
    ledger: ['skipped', ''],
    pass: false,
  },
  {
    name: 'push, reuse=true, guard-git failed',
    event: 'push',
    reuse: ['success', 'true'],
    verify: { all: 'skipped' },
    guard: 'failure',
    ledger: ['skipped', ''],
    pass: false,
  },
  {
    name: 'push, reuse=false, a ledger-only detection that said true does not cover a push',
    event: 'push',
    reuse: ['success', 'false'],
    verify: { all: 'skipped', STATIC: 'success' },
    guard: 'skipped',
    ledger: ['success', 'true'],
    pass: false,
  },
  {
    name: 'labeled pull_request, reuse=true, every verify job skipped, guard-git success',
    event: 'pull_request',
    reuse: ['success', 'true'],
    verify: { all: 'skipped' },
    guard: 'success',
    ledger: ['success', 'false'],
    pass: true,
  },
  {
    name: 'labeled pull_request, reuse=true, every verify job skipped, guard-git skipped',
    event: 'pull_request',
    reuse: ['success', 'true'],
    verify: { all: 'skipped' },
    guard: 'skipped',
    ledger: ['success', 'false'],
    pass: false,
  },
];

it.each(GATES)('[CT-06zzzzf] ci-gate Summarise: $name -> pass=$pass', (g) => {
  const s = summarise();
  const env: Record<string, string> = {};
  for (const [v] of GATE_VARS) env[v] = g.verify[v] ?? g.verify.all;
  env['GUARD'] = g.guard;
  env['REUSE_RESULT'] = g.reuse[0];
  env['REUSE'] = g.reuse[1];
  env['EVENT'] = g.event;
  env['LEDGER_RESULT'] = g.ledger[0];
  env['LEDGER_ONLY'] = g.ledger[1];
  const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', s.run ?? ''], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  const out = `${res.stdout}\n${res.stderr}`;
  if (g.pass) expect(res.status, out).toBe(0);
  else expect(res.status, out).not.toBe(0);
});

// --- 7. the workflow rules still hold ----------------------------------------------------------

it('[CT-06zzzzf] check-workflows reports no problem for the workflows as they are', () => {
  expect(checkWorkflows(REPO)).toEqual([]);
});
