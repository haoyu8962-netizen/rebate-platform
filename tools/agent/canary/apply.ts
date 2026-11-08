// Review canary (埋雷抽查, 规划/11 §3.3; FU-REVIEW-CANARY, D10-886 / D10-1011), first version:
// record only. One mutation of the fixed list (mutations.json, next to this file) is applied to
// the added lines of the change in a throwaway worktree; a fresh session of the same reviewer
// reviews it, and whether it reported the mutation is written to meta.canary.json and one CSV
// line. Nothing here changes the verdict or exit code of the real review.
//
//   node apply.ts apply  --worktree <dir> --base <sha> --round <n> --out <file>
//                        [--trusted <dir> --compile-from <dir>] [--mutations <file>]
//        exit 0: one mutation applied; 3: none lands (n/a, reason in --out); 2: usage / error
//   node apply.ts judge  --mutation <file> --review <file>
//   node apply.ts record --csv <file> --meta-out <file> --task <id> --round <n> --engine <e>
//                        --model <m> --effort <e> --review-type <t> --duration <s>
//                        [--mutation <file>] [--review <file>] [--reason <text>] [--run <n>]
//
// Choice (plan §1): the list is fixed; only the landing follows the diff. A pattern is evaluated
// on the added lines of `git diff <base>` plus the untracked files only, in files that match the
// mutation's file_glob and none of exclude_globs; the first match is replaced once. Order: for a
// money path change (a file under MONEY_PATHS of tools/ci/evidence-check.ts, the one list of the
// funds paths) the seven money categories first, rotated by round, then generic, rotated by
// round; otherwise the whole list rotated by round. A mutation whose package no longer compiles
// (tsc --noEmit of the nearest tsconfig.json, only when the unmutated tree compiles) is undone
// and the next one is tried. The compiler is the trusted root's typescript only (--trusted, as
// format-tests.ts takes eslint and prettier): nothing under the reviewed worktree or its
// node_modules is ever executed; without it the check is unavailable and the first landing is
// taken (the reason is in `compile`). The reviewed worktree's node_modules (--compile-from) are
// only linked in as type declarations to read.
// Hit (D10-886 ①): an S0 / S1 finding in the mutated file within ±15 lines of the mutated line,
// or naming an identifier the mutation removed or introduced (keywords left out); a mutation
// that changes no identifier (an operator or an argument order) is judged by the window alone.
// Only Node built-ins and the repository's own tools are used.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MONEY_PATHS } from '../../ci/evidence-check.ts';
import { matchesAny } from '../../lib/glob.ts';

export type Mutation = {
  id: string;
  category: string;
  file_glob: string;
  pattern: string;
  replacement: string;
  note?: string;
};

export type MutationList = { version: number; exclude_globs: string[]; mutations: Mutation[] };

export type AddedLine = { line: number; text: string };

export type Landing = {
  mutation_id: string;
  category: string;
  file: string;
  line: number;
  before: string;
  after: string;
};

export type Applied = Landing & {
  tried: { mutation_id: string; reason: string }[];
  compile: string;
};

export type NotApplied = {
  mutation_id: null;
  reason: string;
  tried: { mutation_id: string; reason: string }[];
};

export const HIT_WINDOW = 15;
export const GENERIC = 'generic';
export const CSV_HEADER =
  'date,task,round,engine,model,effort,review_type,mutation_id,category,file,line,hit,s0s1_count,duration_s,reason';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Glob to RegExp: `**` (any depth), `*`, `?`, `{a,b}` (no nesting). Paths use `/`. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  let inBrace = false;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? '';
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      inBrace = true;
      out += '(?:';
    } else if (c === '}' && inBrace) {
      inBrace = false;
      out += ')';
    } else if (c === ',' && inBrace) out += '|';
    else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** A funds path: MONEY_PATHS of tools/ci/evidence-check.ts, matched as it matches them. */
export function isMoneyPath(file: string): boolean {
  return matchesAny(file, MONEY_PATHS);
}

/**
 * Added lines per file from a `git diff --unified=0` text (new-file line numbers). Deleted files
 * and binary changes give nothing.
 */
export function parseAddedLines(diff: string): Map<string, AddedLine[]> {
  const files = new Map<string, AddedLine[]>();
  let current: AddedLine[] | null = null;
  let next = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4);
      if (name === '/dev/null') {
        current = null;
      } else {
        const file = name.startsWith('b/') ? name.slice(2) : name;
        current = files.get(file) ?? [];
        files.set(file, current);
      }
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (current === null) continue;
    if (raw.startsWith('+')) {
      current.push({ line: next, text: raw.slice(1) });
      next += 1;
    } else if (raw.startsWith(' ')) {
      next += 1;
    }
  }
  return files;
}

/** Every line of an untracked file is an added line. */
export function untrackedAsAdded(text: string): AddedLine[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((t, i) => ({ line: i + 1, text: t }));
}

function rotate<T>(items: readonly T[], round: number): T[] {
  if (items.length === 0) return [];
  const start = (((round - 1) % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** The order in which mutations are tried (plan §1; see the header). */
export function orderMutations(
  mutations: readonly Mutation[],
  round: number,
  moneyPath: boolean,
): Mutation[] {
  if (!moneyPath) return rotate(mutations, round);
  const specific = mutations.filter((m) => m.category !== GENERIC);
  const generic = mutations.filter((m) => m.category === GENERIC);
  return [...rotate(specific, round), ...rotate(generic, round)];
}

/** Added lines left after exclude_globs, files in path order. */
export function eligible(
  added: Map<string, AddedLine[]>,
  excludes: readonly string[],
): [string, AddedLine[]][] {
  const ex = excludes.map(globToRegExp);
  return [...added.entries()]
    .filter(([file, lines]) => lines.length > 0 && !ex.some((r) => r.test(file)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every landing of one mutation on the added lines, in file and line order. */
export function landingsOf(m: Mutation, files: readonly [string, AddedLine[]][]): Landing[] {
  const glob = globToRegExp(m.file_glob);
  const re = new RegExp(m.pattern);
  const out: Landing[] = [];
  for (const [file, lines] of files) {
    if (!glob.test(file)) continue;
    for (const l of lines) {
      if (!re.test(l.text)) continue;
      const after = l.text.replace(re, m.replacement);
      if (after === l.text) continue;
      out.push({
        mutation_id: m.id,
        category: m.category,
        file,
        line: l.line,
        before: l.text,
        after,
      });
    }
  }
  return out;
}

export type SelectOptions = {
  list: MutationList;
  added: Map<string, AddedLine[]>;
  round: number;
  /** Writes the landing into the tree; returns a function that undoes it. */
  write: (landing: Landing) => () => void;
  /** null: no compile check available; otherwise whether the tree compiles with the landing. */
  compiles: ((landing: Landing) => boolean) | null;
  /** Why `compiles` is null, recorded in `compile`. */
  compileUnavailable?: string;
};

/** Picks and applies the first landing that compiles (plan §1). */
export function selectMutation(opts: SelectOptions): Applied | NotApplied {
  const files = eligible(opts.added, opts.list.exclude_globs);
  const tried: { mutation_id: string; reason: string }[] = [];
  if (files.length === 0) {
    return {
      mutation_id: null,
      reason: 'no added lines outside tests, generated files and migrations',
      tried,
    };
  }
  const money = files.some(([f]) => isMoneyPath(f));
  for (const m of orderMutations(opts.list.mutations, opts.round, money)) {
    const landings = landingsOf(m, files);
    if (landings.length === 0) continue;
    const landing = landings[0] as Landing;
    const undo = opts.write(landing);
    if (opts.compiles !== null && !opts.compiles(landing)) {
      undo();
      tried.push({
        mutation_id: m.id,
        reason: `does not compile at ${landing.file}:${landing.line}`,
      });
      continue;
    }
    const compile =
      opts.compiles !== null
        ? 'ok'
        : `unavailable${opts.compileUnavailable === undefined ? '' : `: ${opts.compileUnavailable}`}`;
    return { ...landing, tried, compile };
  }
  return { mutation_id: null, reason: 'no mutation of the list lands on the added lines', tried };
}

type Finding = {
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  key?: unknown;
  rule?: unknown;
  scenario?: unknown;
  suggestion?: unknown;
};

/** TS / JS keywords and the type names every file uses: never a changed symbol. */
const KEYWORDS = new Set(
  (
    'abstract any as async await bigint boolean break case catch class const continue debugger ' +
    'declare default delete do else enum export extends false finally for from function get if ' +
    'implements import in infer instanceof interface keyof let new never null number object of ' +
    'package private protected public readonly return satisfies set static string super switch ' +
    'symbol this throw true try type typeof undefined unique unknown var void while with yield'
  ).split(' '),
);

/**
 * Identifiers (3+ characters, keywords left out) that the mutation removed or introduced. Empty
 * when none differs (an operator, an argument order): then only the line window decides.
 */
export function changedSymbols(before: string, after: string): string[] {
  const ids = (s: string) =>
    new Set((s.match(/[A-Za-z_$][\w$]{2,}/g) ?? []).filter((x) => !KEYWORDS.has(x)));
  const a = ids(before);
  const b = ids(after);
  const out = new Set<string>();
  for (const x of a) if (!b.has(x)) out.add(x);
  for (const x of b) if (!a.has(x)) out.add(x);
  return [...out];
}

const norm = (f: string) => f.replace(/^\.\//, '');

/** D10-886 ①: S0 / S1 in the same file, within ±15 lines or naming a changed symbol. */
export function judge(
  landing: Landing,
  review: { findings?: unknown },
): { hit: boolean; s0s1_count: number } {
  const findings = (Array.isArray(review.findings) ? review.findings : []) as Finding[];
  const severe = findings.filter((f) => f.severity === 'S0' || f.severity === 'S1');
  const symbols = changedSymbols(landing.before, landing.after);
  const hit = severe.some((f) => {
    if (typeof f.file !== 'string' || norm(f.file) !== norm(landing.file)) return false;
    if (typeof f.line === 'number' && Math.abs(f.line - landing.line) <= HIT_WINDOW) return true;
    const text = [f.key, f.rule, f.scenario, f.suggestion]
      .filter((t) => typeof t === 'string')
      .join('\n');
    return symbols.some((s) => text.includes(s));
  });
  return { hit, s0s1_count: severe.length };
}

export function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: readonly (string | number)[]): string {
  return values.map(csvField).join(',');
}

// ---- git and file system (apply) ----

function git(cwd: string, args: readonly string[]): string {
  const res = spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

export function addedLinesOf(worktree: string, base: string): Map<string, AddedLine[]> {
  const added = parseAddedLines(
    git(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', base, '--']),
  );
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  for (const file of untracked) {
    let text: string;
    try {
      text = readFileSync(join(worktree, file), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    added.set(file, untrackedAsAdded(text));
  }
  return added;
}

function writeInTree(worktree: string): (landing: Landing) => () => void {
  return (landing) => {
    const path = join(worktree, landing.file);
    const original = readFileSync(path, 'utf8');
    const lines = original.split('\n');
    if (lines[landing.line - 1] !== landing.before)
      throw new Error(`line ${landing.file}:${landing.line} is not the diff's`);
    lines[landing.line - 1] = landing.after;
    writeFileSync(path, lines.join('\n'));
    return () => writeFileSync(path, original);
  };
}

/** Nearest directory with a tsconfig.json from the file up to the worktree root, or null. */
export function projectOf(worktree: string, file: string): string | null {
  let dir = dirname(resolve(worktree, file));
  const root = resolve(worktree);
  for (;;) {
    if (existsSync(join(dir, 'tsconfig.json'))) return dir;
    if (dir === root || relative(root, dir).startsWith('..')) return null;
    dir = dirname(dir);
  }
}

/** The compiler of the trusted root, never one of a reviewed worktree (review r1 S1). */
export function trustedTsc(trusted: string | undefined): { tsc: string } | { reason: string } {
  if (trusted === undefined || trusted === '') return { reason: 'no trusted root given' };
  const tsc = join(resolve(trusted), 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) return { reason: `no typescript in the trusted root (${tsc})` };
  return { tsc };
}

/**
 * tsc --noEmit of the nearest project with the trusted root's compiler; the node_modules of
 * `from` (the reviewed worktree) are linked in as declarations to read, since a fresh worktree has
 * none. `check` is null when the trusted compiler is missing (reason given); it returns true (says
 * nothing) when the unmutated project does not compile.
 */
export function compileCheck(
  worktree: string,
  trusted: string | undefined,
  from: string | undefined,
): { check: ((landing: Landing) => boolean) | null; reason?: string } {
  const found = trustedTsc(trusted);
  if ('reason' in found) return { check: null, reason: found.reason };
  const tsc = found.tsc;
  const baseline = new Map<string, boolean>();
  const run = (project: string): boolean => {
    for (const dir of from === undefined ? [] : [worktree, project]) {
      const rel = relative(worktree, dir);
      const src = join(from as string, rel, 'node_modules');
      const dst = join(dir, 'node_modules');
      if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst);
    }
    const res = spawnSync(
      process.execPath,
      [tsc, '-p', join(project, 'tsconfig.json'), '--noEmit'],
      {
        cwd: project,
        encoding: 'utf8',
        timeout: 300_000,
      },
    );
    return res.status === 0;
  };
  const check = (landing: Landing): boolean => {
    const project = projectOf(worktree, landing.file);
    if (project === null) return true;
    if (!baseline.has(project)) {
      // The baseline is taken with the landing undone: write it back afterwards.
      const path = join(worktree, landing.file);
      const mutated = readFileSync(path, 'utf8');
      const lines = mutated.split('\n');
      lines[landing.line - 1] = landing.before;
      writeFileSync(path, lines.join('\n'));
      baseline.set(project, run(project));
      writeFileSync(path, mutated);
    }
    if (baseline.get(project) !== true) return true;
    return run(project);
  };
  return { check };
}

export function readList(file: string): MutationList {
  const list = JSON.parse(readFileSync(file, 'utf8')) as MutationList;
  if (!Array.isArray(list.mutations) || !Array.isArray(list.exclude_globs)) {
    throw new Error(`${file}: not a mutation list`);
  }
  return list;
}

function need(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== 'string' || v === '') throw new Error(`--${name} is required`);
  return v;
}

function positive(v: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`--${name} must be a positive integer`);
  return Number(v);
}

function cmdApply(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      worktree: { type: 'string' },
      base: { type: 'string' },
      round: { type: 'string' },
      out: { type: 'string' },
      'compile-from': { type: 'string' },
      trusted: { type: 'string' },
      mutations: { type: 'string' },
    },
  });
  const worktree = need(values, 'worktree');
  const base = need(values, 'base');
  const round = positive(need(values, 'round'), 'round');
  const out = need(values, 'out');
  const list = readList(values.mutations ?? join(HERE, 'mutations.json'));
  const untracked = () =>
    git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const before = new Set(untracked());
  const compile = compileCheck(worktree, values.trusted, values['compile-from']);
  const result = selectMutation({
    list,
    added: addedLinesOf(worktree, base),
    round,
    write: writeInTree(worktree),
    compiles: compile.check,
    ...(compile.reason === undefined ? {} : { compileUnavailable: compile.reason }),
  });
  // What the compile check left behind (node_modules links, build info) is not part of the
  // change the canary review sees.
  for (const file of untracked())
    if (!before.has(file)) rmSync(join(worktree, file), { force: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  return result.mutation_id === null ? 3 : 0;
}

function readJson(file: string | undefined): Record<string, unknown> | null {
  if (file === undefined || file === '' || !existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function landingFrom(m: Record<string, unknown> | null): Landing | null {
  if (m === null || typeof m['mutation_id'] !== 'string') return null;
  return m as unknown as Landing;
}

function cmdJudge(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { mutation: { type: 'string' }, review: { type: 'string' } },
  });
  const landing = landingFrom(readJson(need(values, 'mutation')));
  const review = readJson(need(values, 'review'));
  if (landing === null || review === null) throw new Error('mutation or review not readable');
  process.stdout.write(JSON.stringify(judge(landing, review)) + '\n');
  return 0;
}

/**
 * hit column: 1 / 0 judged; n/a nothing landed; error anything else (apply failure, review
 * without output, quota). Only 1 and 0 count towards the rate (tools/ops/canary-rate.ts).
 */
function cmdRecord(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      csv: { type: 'string' },
      'meta-out': { type: 'string' },
      task: { type: 'string' },
      round: { type: 'string' },
      engine: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'review-type': { type: 'string' },
      duration: { type: 'string' },
      mutation: { type: 'string' },
      review: { type: 'string' },
      reason: { type: 'string' },
      run: { type: 'string' },
      date: { type: 'string' },
    },
  });
  const csv = need(values, 'csv');
  const mutationJson = readJson(values.mutation);
  const landing = landingFrom(mutationJson);
  const review = readJson(values.review);
  let reason = values.reason ?? '';
  let hit = 'error';
  let s0s1: number | string = '';
  if (landing === null) {
    if (mutationJson !== null && mutationJson['mutation_id'] === null) {
      hit = 'n/a';
      reason = reason || String(mutationJson['reason'] ?? 'n/a');
    } else {
      reason = reason || 'no mutation applied';
    }
  } else if (review === null) {
    reason = reason || 'the canary review left no usable output';
  } else if (reason === '') {
    const j = judge(landing, review);
    hit = j.hit ? '1' : '0';
    s0s1 = j.s0s1_count;
  }
  const date = values.date ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const row = [
    date,
    need(values, 'task'),
    values.round ?? '',
    need(values, 'engine'),
    values.model ?? '',
    values.effort ?? '',
    values['review-type'] ?? '',
    landing?.mutation_id ?? '',
    landing?.category ?? '',
    landing?.file ?? '',
    landing?.line ?? '',
    hit,
    s0s1,
    values.duration ?? '',
    reason,
  ];
  mkdirSync(dirname(csv), { recursive: true });
  if (!existsSync(csv) || readFileSync(csv, 'utf8').trim() === '')
    writeFileSync(csv, CSV_HEADER + '\n');
  appendFileSync(csv, csvLine(row) + '\n');
  const metaOut = values['meta-out'];
  if (metaOut !== undefined) {
    const meta = {
      task: row[1],
      round: row[2],
      engine: row[3],
      model: row[4],
      effort: row[5],
      review_type: row[6],
      run: values.run ?? null,
      date,
      mutation: mutationJson,
      hit: hit === '1' ? true : hit === '0' ? false : hit,
      s0s1_count: s0s1 === '' ? null : s0s1,
      duration_s: values.duration === undefined ? null : Number(values.duration),
      reason: reason === '' ? null : reason,
      // First version (CT-06zzzza): recorded only, the real review's verdict is unchanged.
      gating: false,
    };
    writeFileSync(metaOut, JSON.stringify(meta, null, 2) + '\n');
  }
  return 0;
}

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'apply') return cmdApply(rest);
    if (cmd === 'judge') return cmdJudge(rest);
    if (cmd === 'record') return cmdRecord(rest);
    console.error('usage: apply.ts apply|judge|record ... (see the header of this file)');
    return 2;
  } catch (err) {
    console.error(`canary: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
