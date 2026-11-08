// CT-06zzzze (D10-1023 / D10-1024, ci-load-plan §2 A / B1): the concurrency of
// .github/workflows/ci.yml and the bounded wait of verify-reuse, read from the real file.
//
// A: labeled / unlabeled events get a concurrency group of their own (`ci-<ref>-label`), so an
//    owner label added while the code run of the same ref is still going no longer cancels it.
//    The label run's verify-reuse first waits, up to a limit, for every other ci.yml run on the
//    same head to finish, then reuses by the old rule (same tree, each job success, artifact);
//    a run that never finishes within the limit, or does not pass, means a full run.
// B1: a push to main is never cancelled by the next push (cancel-in-progress false); the code
//    events of a pull request still cancel the older run.
//
// The `group` and `cancel-in-progress` values are evaluated with a small evaluator of the GitHub
// expression language (literals, context properties, ! == != < <= > >= && ||, contains /
// startsWith / endsWith / format / join / toJSON / fromJSON), under the contexts of several
// events. The run steps of verify-reuse are executed with bash, with a fake `gh` and a fake
// `sleep` first on PATH. The fake gh answers `gh api` for the Actions REST endpoints from a
// scenario file and implements a subset of jq for `--jq` (the verify image has no jq); every
// other gh command, an unknown endpoint or a jq feature outside the subset fails loudly.
// The YAML helpers are line-based (no YAML dependency), as in ci-ledger-only-workflow.test.ts.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkWorkflows } from './check-workflows.ts';

const REPO = resolve(import.meta.dirname, '../..');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const LINES = CI.split('\n');
const SCRATCH = join(REPO, '.tmp', `ci-concurrency-workflow-${process.pid}`);

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);
const RUN_ID = 9000;
const GH_REPO = 'o/r';
/** The wait limit and poll interval the workflow is to set (ledger: 60 minutes, once a minute). */
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

function jobIf(id: string): string {
  const e = entry(requireJob(id), 'if', 4);
  return e === null ? '' : value(e).replace(/\s+/g, ' ');
}

type Step = {
  id: string | null;
  name: string | null;
  uses: string | null;
  run: string | null;
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
      env: mapping(entry(lines, 'env', 8)),
    };
  });
}

/** `${{ expr }}` -> expr, or null when the value is not a single expression. */
function expressionOf(text: string): string | null {
  const m = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(text.trim());
  return m ? (m[1] ?? null) : null;
}

/** Replaces every `${{ expr }}` in `text` by `values[expr]`; an unknown expression throws. */
function expand(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expr: string) => {
    const v = values[expr];
    if (v === undefined) throw new Error(`no scenario value for \${{ ${expr} }}`);
    return v;
  });
}

function stepEnv(step: Step, values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env)) env[k] = expand(v, values);
  return env;
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

function prEvent(action: string, number = 7, ref?: string): Ev {
  const head = { sha: HEAD_SHA, ref: `chore/pr-${String(number)}` };
  return {
    name: `pull_request ${action} on PR #${String(number)}${ref === undefined ? '' : ` (ref ${ref})`}`,
    ctx: {
      github: {
        event_name: 'pull_request',
        ref: ref ?? `refs/pull/${String(number)}/merge`,
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

function pushEvent(ref = 'refs/heads/main'): Ev {
  return {
    name: `push to ${ref}`,
    ctx: {
      github: {
        event_name: 'push',
        ref,
        ref_name: ref.replace(/^refs\/heads\//, ''),
        ref_type: 'branch',
        head_ref: '',
        base_ref: '',
        sha: 'f'.repeat(40),
        repository: GH_REPO,
        workflow: 'ci',
        run_id: String(RUN_ID),
        event: { ref, before: 'd'.repeat(40), after: 'f'.repeat(40) },
      },
    },
  };
}

// --- 1. the workflow-level concurrency block ---------------------------------------------------

function concurrency(): { group: string; cancel: string } {
  const block = entry(LINES, 'concurrency', 0);
  expect(block, 'ci.yml has a workflow-level `concurrency:` block').not.toBeNull();
  const lines = block?.block ?? [];
  const group = entry(lines, 'group', 2);
  const cancel = entry(lines, 'cancel-in-progress', 2);
  expect(group, 'concurrency has a group').not.toBeNull();
  expect(cancel, 'concurrency has cancel-in-progress').not.toBeNull();
  return {
    group: group === null ? '' : value(group).trim(),
    cancel: cancel === null ? '' : value(cancel).trim(),
  };
}

function groupOf(ev: Ev): string {
  return interpolate(concurrency().group, ev.ctx);
}

function cancelOf(ev: Ev): GhValue {
  const text = concurrency().cancel;
  if (text === 'true') return true;
  if (text === 'false') return false;
  const expr = expressionOf(text);
  expect(expr, 'cancel-in-progress is true, false or one ${{ }} expression').not.toBeNull();
  return ghEvaluate(expr ?? '', ev.ctx);
}

it('[CT-06zzzze] ci.yml keeps one workflow-level concurrency block with group and cancel-in-progress', () => {
  const c = concurrency();
  expect(c.group).toMatch(/\S/);
  expect(c.cancel).toMatch(/\S/);
  // The expression evaluator understands the whole group value.
  expect(() => groupOf(prEvent('opened'))).not.toThrow();
});

const GROUPS: [Ev, string][] = [
  [prEvent('opened'), 'ci-refs/pull/7/merge'],
  [prEvent('synchronize'), 'ci-refs/pull/7/merge'],
  [prEvent('reopened'), 'ci-refs/pull/7/merge'],
  [prEvent('labeled'), 'ci-refs/pull/7/merge-label'],
  [prEvent('unlabeled'), 'ci-refs/pull/7/merge-label'],
  [prEvent('synchronize', 8), 'ci-refs/pull/8/merge'],
  [prEvent('labeled', 8), 'ci-refs/pull/8/merge-label'],
  [pushEvent(), 'ci-refs/heads/main'],
];

it.each(GROUPS.map(([ev, group]) => ({ name: ev.name, ctx: ev.ctx, group })))(
  '[CT-06zzzze] concurrency group: $name -> $group',
  ({ name, ctx, group }) => {
    expect(groupOf({ name, ctx })).toBe(group);
  },
);

it('[CT-06zzzze] label events never share a group with code events or a push on the same ref; same-kind events do', () => {
  const code = ['opened', 'synchronize', 'reopened'].map((a) => groupOf(prEvent(a)));
  const label = ['labeled', 'unlabeled'].map((a) => groupOf(prEvent(a)));
  expect(new Set(code).size, 'opened / synchronize / reopened share one group').toBe(1);
  expect(new Set(label).size, 'labeled / unlabeled share one group').toBe(1);
  for (const l of label) {
    for (const c of code) expect(l).not.toBe(c);
    expect(l).not.toBe(groupOf(pushEvent()));
  }
  // Even on the very same ref string, a label event is not in the group of a push.
  const main = 'refs/heads/main';
  expect(groupOf(prEvent('labeled', 7, main))).not.toBe(groupOf(pushEvent(main)));
  expect(groupOf(prEvent('labeled', 7, main))).not.toBe(groupOf(prEvent('synchronize', 7, main)));
  // Two pushes to main share one group (GitHub keeps the latest pending one).
  expect(groupOf(pushEvent())).toBe(groupOf(pushEvent()));
  // Different pull requests never share a group.
  expect(groupOf(prEvent('synchronize', 7))).not.toBe(groupOf(prEvent('synchronize', 8)));
  expect(groupOf(prEvent('labeled', 7))).not.toBe(groupOf(prEvent('labeled', 8)));
});

// --- 2. cancel-in-progress (B1) ----------------------------------------------------------------

const CANCELS: [Ev, boolean][] = [
  [pushEvent(), false],
  [prEvent('opened'), true],
  [prEvent('synchronize'), true],
  [prEvent('reopened'), true],
  [prEvent('synchronize', 8), true],
];

it.each(CANCELS.map(([ev, cancel]) => ({ name: ev.name, ctx: ev.ctx, cancel })))(
  '[CT-06zzzze] cancel-in-progress: $name -> $cancel',
  ({ name, ctx, cancel }) => {
    const v = cancelOf({ name, ctx });
    expect(typeof v, 'cancel-in-progress evaluates to a boolean').toBe('boolean');
    expect(v).toBe(cancel);
  },
);

// --- 3. verify-reuse: runs on label events only, waits with a bound ----------------------------

it('[CT-06zzzze] verify-reuse still runs only on labeled / unlabeled pull_request events', () => {
  const cond = jobIf('verify-reuse');
  expect(cond).toMatch(/\S/);
  const truth = (ev: Ev): boolean => ghTruthy(ghEvaluate(cond, ev.ctx));
  expect(truth(prEvent('labeled'))).toBe(true);
  expect(truth(prEvent('unlabeled'))).toBe(true);
  for (const a of ['opened', 'synchronize', 'reopened']) expect(truth(prEvent(a)), a).toBe(false);
  expect(truth(pushEvent())).toBe(false);
});

/** The env value `name` set on verify-reuse: on the job, or on one of its steps. */
function reuseSetting(name: string): string | undefined {
  const job = mapping(entry(requireJob('verify-reuse'), 'env', 4))[name];
  const fromSteps = steps('verify-reuse')
    .map((s) => s.env[name])
    .filter((v): v is string => v !== undefined);
  return job ?? fromSteps[0];
}

it('[CT-06zzzze] verify-reuse waits at most REUSE_WAIT_SECONDS=3600, polls every REUSE_POLL_SECONDS=60, and its timeout leaves 5 minutes beyond the wait', () => {
  const wait = reuseSetting(WAIT_VAR);
  const poll = reuseSetting(POLL_VAR);
  expect(wait, `verify-reuse sets ${WAIT_VAR}`).toBe('3600');
  expect(poll, `verify-reuse sets ${POLL_VAR}`).toBe('60');
  const timeout = entry(requireJob('verify-reuse'), 'timeout-minutes', 4);
  expect(timeout, 'verify-reuse has timeout-minutes').not.toBeNull();
  const minutes = Number(scalar(timeout?.inline ?? ''));
  expect(Number.isInteger(minutes)).toBe(true);
  expect(minutes * 60).toBeGreaterThanOrEqual(Number(wait) + 5 * 60);
  // The wait applies to the steps that run the reuse decision: a step reads the variables.
  const text = steps('verify-reuse')
    .map((s) => s.run ?? '')
    .join('\n');
  expect(text).toContain(WAIT_VAR);
  expect(text).toContain(POLL_VAR);
});

// The fake gh (CommonJS, run with this Node). Written without template literals on purpose.
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

// ----- the Actions REST endpoints -----
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

const prefix = 'repos/' + state.repo + '/actions/';
if (!p.startsWith(prefix)) die('no route for ' + p);
const rest = p.slice(prefix.length);
let m; let kind; let build;
function findRun(id) { const r = state.runs.find(function (x) { return String(x.id) === String(id); }); if (!r) die('HTTP 404: no run ' + id); return r; }
function isDone(r) { return r.pending !== null && statusCount > r.pending; }
function workflowId(r) { return r.workflow === 'ci.yml' ? 101 : 202; }
function runObj(r) {
  const done = isDone(r);
  return {
    id: r.id, name: r.workflow.replace(/\.yml$/, ''), path: '.github/workflows/' + r.workflow,
    workflow_id: workflowId(r), head_sha: r.head, head_branch: 'chore/x', event: 'pull_request',
    status: done ? 'completed' : 'in_progress', conclusion: done ? r.conclusion : null, run_attempt: 1,
  };
}
function lastPage() { return Number(q.get('page') || '1') > 1; }
function listRuns(runs) {
  let rs = runs.slice().sort(function (a, b) { return b.id - a.id; }).map(runObj);
  if (q.get('head_sha')) rs = rs.filter(function (r) { return r.head_sha === q.get('head_sha'); });
  if (q.get('status')) rs = rs.filter(function (r) { return r.status === q.get('status') || r.conclusion === q.get('status'); });
  if (q.get('event')) rs = rs.filter(function (r) { return r.event === q.get('event'); });
  if (lastPage()) rs = [];
  return { total_count: rs.length, workflow_runs: rs };
}
if ((m = /^workflows\/([^/]+)\/runs$/.exec(rest))) {
  const wf = m[1]; kind = 'status';
  build = function () { return listRuns(state.runs.filter(function (r) { return r.workflow === wf || String(workflowId(r)) === wf; })); };
} else if (rest === 'runs') {
  kind = 'status'; build = function () { return listRuns(state.runs); };
} else if ((m = /^runs\/(\d+)$/.exec(rest))) {
  const r = findRun(m[1]); kind = 'status'; build = function () { return runObj(r); };
} else if ((m = /^runs\/(\d+)(?:\/attempts\/\d+)?\/jobs$/.exec(rest))) {
  const r = findRun(m[1]); kind = 'jobs';
  build = function () {
    const done = isDone(r);
    const jobs = lastPage() ? [] : Object.keys(r.jobs).map(function (name, i) {
      return { id: r.id * 100 + i, run_id: r.id, name: name, head_sha: r.head, status: done ? 'completed' : 'in_progress', conclusion: done ? r.jobs[name] : null };
    });
    return { total_count: jobs.length, jobs: jobs };
  };
} else if ((m = /^runs\/(\d+)\/artifacts$/.exec(rest))) {
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
fs.appendFileSync(logFile, JSON.stringify({ kind: kind, path: p + url.search }) + '\n');
const body = build();
if (jq === null) { process.stdout.write(JSON.stringify(body) + '\n'); }
else {
  let outs;
  try { outs = ev(parse(jq), body); } catch (e) { die('jq: ' + (e && e.message ? e.message : String(e))); }
  process.stdout.write(outs.map(function (v) { return tostr(v) + '\n'; }).join(''));
}
`;

type FakeRun = {
  id: number;
  workflow: string;
  head: string;
  /** Status queries (run lists or single runs) during which the run is in progress; null: never ends. */
  pending: number | null;
  conclusion: 'success' | 'failure' | 'cancelled';
  jobs: Record<string, string>;
  artifacts: string[];
};

let BIN = '';
let CHECKOUT = '';
let TREE = '';
let reuseCount = 0;

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
  const which = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' });
  const realSleep = which.stdout.trim() || '/bin/sleep';
  writeFileSync(
    join(BIN, 'sleep'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_SLEEP_LOG"\nexec '${realSleep}' 0.05\n`,
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

/** This label run itself: always in progress. */
function selfRun(): FakeRun {
  return {
    id: RUN_ID,
    workflow: 'ci.yml',
    head: HEAD_SHA,
    pending: null,
    conclusion: 'success',
    jobs: { 'verify-reuse': 'success' },
    artifacts: [],
  };
}

/** Noise present in every scenario; none of it may hold the wait or count for reuse. */
function noiseRuns(): FakeRun[] {
  return [
    // An earlier run on the same head, cancelled long ago.
    {
      id: 4000,
      workflow: 'ci.yml',
      head: HEAD_SHA,
      pending: 0,
      conclusion: 'cancelled',
      jobs: allJobs('cancelled'),
      artifacts: [],
    },
    // A ci.yml run on another head that never ends.
    {
      id: 6000,
      workflow: 'ci.yml',
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
      head: HEAD_SHA,
      pending: null,
      conclusion: 'success',
      jobs: { 'protected-paths': 'success' },
      artifacts: [],
    },
  ];
}

function codeRun(id: number, pending: number | null, jobs: Record<string, string>): FakeRun {
  const failed = Object.values(jobs).some((c) => c !== 'success');
  return {
    id,
    workflow: 'ci.yml',
    head: HEAD_SHA,
    pending,
    conclusion: failed ? 'failure' : 'success',
    jobs,
    // Uploaded for every verify job, so only the job conclusion can make a difference.
    artifacts: verifiedArtifacts(),
  };
}

type ReuseRun = {
  status: number | null;
  out: string;
  reuse: string[];
  sleeps: number;
  statusQueries: number;
  elapsedMs: number;
};

/** Runs every run step of verify-reuse, in order, against the fake gh and the fake sleep. */
function runReuse(runs: FakeRun[], waitSeconds: number): ReuseRun {
  const dir = join(SCRATCH, `reuse-${++reuseCount}`);
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, 'state.json');
  const ghLog = join(dir, 'gh.log');
  const sleepLog = join(dir, 'sleep.log');
  writeFileSync(stateFile, JSON.stringify({ repo: GH_REPO, runs: [selfRun(), ...runs] }));
  const body = requireJob('verify-reuse');
  const outputs = mapping(entry(body, 'outputs', 4));
  const reuseExpr = expressionOf(outputs['reuse'] ?? '') ?? '';
  const reuseStep = /^steps\.([A-Za-z0-9_-]+)\.outputs\.reuse$/.exec(reuseExpr)?.[1];
  expect(reuseStep, 'verify-reuse outputs reuse from a step').toBeDefined();
  const values: Record<string, string> = {
    'github.token': 'not-a-real-token',
    'github.repository': GH_REPO,
    'github.event.pull_request.head.sha': HEAD_SHA,
    'github.event.pull_request.base.sha': BASE_SHA,
    'github.event.pull_request.number': '7',
    'github.event.pull_request.head.ref': 'chore/x',
    'github.event_name': 'pull_request',
    'github.event.action': 'labeled',
    'github.ref': 'refs/pull/7/merge',
    'github.sha': 'e'.repeat(40),
    'github.run_id': String(RUN_ID),
    'github.run_attempt': '1',
    'github.workspace': CHECKOUT,
    'github.api_url': 'https://api.invalid',
    'runner.temp': dir,
  };
  let status: number | null = 0;
  let out = '';
  let reuse: string[] = [];
  const started = Date.now();
  for (const [i, s] of steps('verify-reuse').entries()) {
    if (s.run === null) continue;
    const output = join(dir, `output-${String(i)}`);
    writeFileSync(output, '');
    const res = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', expand(s.run, values)],
      {
        cwd: CHECKOUT,
        encoding: 'utf8',
        env: {
          PATH: `${BIN}:${process.env['PATH'] ?? ''}`,
          HOME: dir,
          GITHUB_OUTPUT: output,
          GITHUB_WORKSPACE: CHECKOUT,
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_REPOSITORY: GH_REPO,
          GITHUB_RUN_ID: String(RUN_ID),
          RUNNER_TEMP: dir,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          ...stepEnv(s, values),
          [WAIT_VAR]: String(waitSeconds),
          [POLL_VAR]: '1',
          FAKE_GH_STATE: stateFile,
          FAKE_GH_LOG: ghLog,
          FAKE_SLEEP_LOG: sleepLog,
        },
      },
    );
    out += `${res.stdout}\n${res.stderr}`;
    status = res.status;
    if (s.id === reuseStep) {
      reuse = readFileSync(output, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('reuse='));
    }
    if (status !== 0) break;
  }
  const lines = (file: string): string[] =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return {
    status,
    out,
    reuse,
    sleeps: lines(sleepLog).length,
    statusQueries: lines(ghLog).filter((l) => (JSON.parse(l) as { kind: string }).kind === 'status')
      .length,
    elapsedMs: Date.now() - started,
  };
}

it('[CT-06zzzze] verify-reuse with nothing else on this head: decides at once by the old rule, reuse=false', () => {
  const r = runReuse(noiseRuns(), 20);
  expect(r.status, r.out).toBe(0);
  expect(r.reuse, r.out).toEqual(['reuse=false']);
  expect(r.sleeps, 'no wait when no other ci.yml run on this head is unfinished').toBe(0);
});

it('[CT-06zzzze] verify-reuse with an earlier finished pass on this tree: decides at once, reuse=true', () => {
  const r = runReuse([...noiseRuns(), codeRun(5001, 0, allJobs('success'))], 20);
  expect(r.status, r.out).toBe(0);
  expect(r.reuse, r.out).toEqual(['reuse=true']);
  expect(r.sleeps, 'no wait when no other ci.yml run on this head is unfinished').toBe(0);
});

it('[CT-06zzzze] verify-reuse waits for the code run still in progress on this head, then reuses its pass', () => {
  const pending = 2;
  const r = runReuse([...noiseRuns(), codeRun(5001, pending, allJobs('success'))], 20);
  expect(r.status, r.out).toBe(0);
  expect(r.reuse, r.out).toEqual(['reuse=true']);
  expect(r.sleeps, 'it slept between polls').toBeGreaterThanOrEqual(1);
  expect(r.sleeps, 'it stopped waiting once the run completed').toBeLessThanOrEqual(pending + 2);
  expect(r.statusQueries).toBeGreaterThan(pending);
  expect(r.out).toMatch(/waiting/i);
  expect(r.out).toContain('5001');
});

it('[CT-06zzzze] verify-reuse waits for every unfinished run on this head, not only the first to finish', () => {
  // 5001 finishes first (cancelled); 5002, the passing one, only after more polls.
  const r = runReuse(
    [
      ...noiseRuns(),
      { ...codeRun(5001, 1, allJobs('cancelled')), conclusion: 'cancelled', artifacts: [] },
      codeRun(5002, 3, allJobs('success')),
    ],
    20,
  );
  expect(r.status, r.out).toBe(0);
  expect(r.reuse, r.out).toEqual(['reuse=true']);
  expect(r.sleeps).toBeGreaterThanOrEqual(2);
  expect(r.sleeps).toBeLessThanOrEqual(5);
});

it('[CT-06zzzze] verify-reuse waits for the run in progress; when it completes with a failed job, reuse=false', () => {
  const pending = 2;
  const r = runReuse(
    [...noiseRuns(), codeRun(5001, pending, allJobs('success', { 'verify-int-2': 'failure' }))],
    20,
  );
  expect(r.status, r.out).toBe(0);
  expect(r.reuse, r.out).toEqual(['reuse=false']);
  expect(r.sleeps, 'it waited for the run to complete').toBeGreaterThanOrEqual(1);
  expect(r.sleeps).toBeLessThanOrEqual(pending + 2);
  expect(r.statusQueries).toBeGreaterThan(pending);
});

it('[CT-06zzzze] verify-reuse stops at the wait limit when a run never finishes: reuse=false, exit 0', () => {
  const r = runReuse([...noiseRuns(), codeRun(5001, null, allJobs('success'))], 2);
  expect(r.status, r.out).toBe(0);
  expect(r.reuse, r.out).toEqual(['reuse=false']);
  expect(r.sleeps).toBeGreaterThanOrEqual(1);
  expect(r.statusQueries).toBeGreaterThanOrEqual(2);
  expect(r.out).toMatch(/wait limit/i);
  expect(r.elapsedMs, 'the limit is honoured, not exceeded by much').toBeLessThan(20_000);
});

it('[CT-06zzzze] verify-reuse that gives up waiting runs in full even if an earlier pass exists', () => {
  const r = runReuse(
    [...noiseRuns(), codeRun(5001, 0, allJobs('success')), codeRun(5002, null, allJobs('success'))],
    2,
  );
  expect(r.status, r.out).toBe(0);
  expect(r.reuse, r.out).toEqual(['reuse=false']);
  expect(r.sleeps).toBeGreaterThanOrEqual(1);
  expect(r.out).toMatch(/wait limit/i);
});

// --- 4. the workflow rules still hold ----------------------------------------------------------

it('[CT-06zzzze] check-workflows reports no problem for the workflows as they are', () => {
  expect(checkWorkflows(REPO)).toEqual([]);
});
