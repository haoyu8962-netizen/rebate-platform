// Ledger single-writer guard (CT-06zzzzzx, D10-2219 / 2223 / 2267 / 2270).
// AGENTS.md §4 rule 2: only the ledger module changes balances; BR-FUND-16: entries are
// insert-only. This check fails when a tracked `.ts` or `.sql` file writes one of the three
// ledger tables (see LEDGER_TABLES) outside the allowlist ledger-writers.allow.txt.
//
// Scanned: the files of the tree listing ending in `.ts` or `.sql`, except anything under
// node_modules, generated `*.gen.ts` files and db/schema.sql. With git, run.ts passes the
// tracked files only (trackedFiles): an untracked local draft does not fail the check; without
// .git (verify container) the walked tree is scanned. Comments are blanked first (`//`,
// `/* */` in TypeScript; `--`, nested `/* */` in SQL files and in the SQL of every TypeScript
// string and template, quoted SQL text kept, line numbers kept), so a table named in a comment
// is no hit and a comment between a keyword and the table does not hide a write.
//
// Counted as a write (case-insensitive, across lines; the table may carry the `app.` schema,
// with whitespace or comments around the dot, double quotes and an alias):
// - Kysely insertInto / updateTable / deleteFrom / mergeInto / replaceInto whose argument is
//   a string literal naming the table;
// - in TypeScript strings and templates (including `sql` tagged templates) and in SQL files:
//   INSERT INTO, UPDATE, DELETE FROM, MERGE INTO, TRUNCATE [TABLE] (every listed table),
//   COPY <table> … FROM.
// Not counted: triggers (`BEFORE UPDATE OR DELETE ON`), grants (`GRANT … INSERT ON`), DDL,
// selectFrom, reads in FROM / JOIN, `SELECT … FOR UPDATE` (a read lock), COPY … TO.
//
// Allowlist (read from the inspected tree): one path per line, a Tab, then the reason; lines
// starting with `#` are comments. A file entry allows that file only; a directory entry ends
// with `/` and allows the files below it. Wildcards are rejected. An entry whose path no
// longer exists is a problem; an existing entry without any hit is a notice.
//
// Known limits: a table name assembled at run time (a variable, string concatenation,
// `sql.table(...)` / `sql.id(...)`, Kysely `withSchema` plus a table held in a variable) is
// not recognised. A scan of main on 2026-11-20 found no such write to the ledger tables.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tryGit } from '../lib/git.ts';
import { result } from './lib/cli.ts';
import type { CheckResult } from './lib/cli.ts';
import type { TreeListing } from './lib/tree.ts';

export const LEDGER_WRITERS_CHECK = 'ledger-writers';
export const LEDGER_WRITERS_ALLOWLIST = 'tools/guard/ledger-writers.allow.txt';
export const LEDGER_TABLES = ['ledger_entries', 'ledger_vouchers', 'account_balances'] as const;

const ADVICE =
  '只能经 ledger 模块记账函数写（apps/api/src/modules/ledger/infra/store.ts）；' +
  '确需新增写入点是门禁改动，要经负责人（改 ' +
  LEDGER_WRITERS_ALLOWLIST +
  '）';

export type LedgerWrite = { line: number; table: string; operation: string };

// ---------------------------------------------------------------------------------------------
// Comment blanking. Offsets and line breaks are kept, so positions map to the original lines.

function blank(text: string, from: number, to: number, out: string[]): void {
  for (let i = from; i < to; i++) out[i] = text[i] === '\n' ? '\n' : ' ';
}

/** Characters after which a `/` in TypeScript starts a regular expression literal. */
const REGEX_PREFIX = new Set([...'(,=:[!&|?{};+-*%<>~^'.split(''), '']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void']);

function previousToken(text: string, at: number): string {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i] ?? '')) i--;
  if (i < 0) return '';
  const ch = text[i] ?? '';
  if (!/[\w$]/.test(ch)) return ch;
  let start = i;
  while (start > 0 && /[\w$]/.test(text[start - 1] ?? '')) start--;
  return text.slice(start, i + 1);
}

function regexStarts(text: string, at: number): boolean {
  const token = previousToken(text, at);
  if (token.length <= 1 && !/[\w$]/.test(token)) return REGEX_PREFIX.has(token);
  return REGEX_KEYWORDS.has(token);
}

/** Skips a regular expression literal starting at `at` (a `/`); returns the index after it. */
function skipRegex(text: string, at: number): number {
  let inClass = false;
  for (let i = at + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '\n') return i;
    else if (inClass) inClass = ch !== ']';
    else if (ch === '[') inClass = true;
    else if (ch === '/') return i + 1;
  }
  return text.length;
}

/** One character of SQL text and the source offsets it was read from (an escape spans two). */
type SqlChar = { c: string; from: number; to: number };

/**
 * Blanks the SQL comments (`--` to the end of the line, `/* … *\/`, nested as in PostgreSQL)
 * of one SQL text: a `.sql` file, or the content of one TypeScript string or template literal.
 * Text in single quotes (literals) and double quotes (identifiers) is kept.
 */
function blankSqlStream(text: string, chars: readonly SqlChar[], out: string[]): void {
  const blankRange = (a: number, b: number): void => {
    for (let k = a; k < b; k++) {
      const ch = chars[k];
      if (ch !== undefined) blank(text, ch.from, ch.to, out);
    }
  };
  const at = (k: number): string => chars[k]?.c ?? '';
  let k = 0;
  while (k < chars.length) {
    const ch = at(k);
    const next = at(k + 1);
    if (ch === '-' && next === '-') {
      let end = k + 2;
      while (end < chars.length && at(end) !== '\n') end++;
      blankRange(k, end);
      k = end;
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      let end = k + 2;
      while (end < chars.length && depth > 0) {
        if (at(end) === '/' && at(end + 1) === '*') {
          depth++;
          end += 2;
        } else if (at(end) === '*' && at(end + 1) === '/') {
          depth--;
          end += 2;
        } else end++;
      }
      blankRange(k, end);
      k = end;
    } else if (ch === "'" || ch === '"') {
      let end = k + 1;
      while (end < chars.length && at(end) !== ch) end++;
      k = end + 1;
    } else k++;
  }
}

/** The character an escape `\x` in a TypeScript string stands for, as SQL sees it. */
function unescaped(ch: string): string {
  if (ch === 'n' || ch === 'r' || ch === '\n') return '\n';
  if (ch === 't') return ' ';
  return ch;
}

/**
 * TypeScript source with comments replaced by spaces. Strings and templates are kept, but the
 * SQL comments inside each of them are blanked too (`'-- UPDATE …'` is no write, and
 * `UPDATE /* … *\/ app.<table>` still is one).
 */
export function blankTsComments(text: string): string {
  const out = text.split('');
  // Each frame is a template literal (`tpl`, with its SQL text so far) or a `${ … }`
  // substitution (brace depth).
  type Frame = { kind: 'tpl'; sql: SqlChar[] } | { kind: 'sub'; depth: number };
  const stack: Frame[] = [];
  let i = 0;
  // `\n`, `\r`, `\t` in a string separate words (`'…\nTRUNCATE …'`): blank them as spaces.
  const escape = (at: number, sql: SqlChar[]): number => {
    if (/[nrt]/.test(text[at + 1] ?? '')) out[at] = out[at + 1] = ' ';
    sql.push({ c: unescaped(text[at + 1] ?? ''), from: at, to: Math.min(at + 2, text.length) });
    return at + 2;
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    const top = stack.at(-1);
    if (top?.kind === 'tpl') {
      if (ch === '\\') i = escape(i, top.sql);
      else if (ch === '`') {
        blankSqlStream(text, top.sql, out);
        stack.pop();
        i++;
      } else if (ch === '$' && text[i + 1] === '{') {
        // The substitution becomes a query parameter: a placeholder of no width.
        top.sql.push({ c: '0', from: i, to: i });
        stack.push({ kind: 'sub', depth: 0 });
        i += 2;
      } else {
        top.sql.push({ c: ch, from: i, to: i + 1 });
        i++;
      }
      continue;
    }
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(text, i, stop, out);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(text, i, stop, out);
      i = stop;
    } else if (ch === '/' && regexStarts(text, i)) {
      i = skipRegex(text, i);
    } else if (ch === "'" || ch === '"') {
      const sql: SqlChar[] = [];
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== '\n') {
        if (text[j] === '\\') j = escape(j, sql);
        else {
          sql.push({ c: text[j] ?? '', from: j, to: j + 1 });
          j++;
        }
      }
      blankSqlStream(text, sql, out);
      i = j + 1;
    } else if (ch === '`') {
      stack.push({ kind: 'tpl', sql: [] });
      i++;
    } else {
      if (top?.kind === 'sub') {
        if (ch === '{') top.depth++;
        else if (ch === '}') {
          if (top.depth === 0) stack.pop();
          else top.depth--;
        }
      }
      i++;
    }
  }
  // An unterminated template still has its SQL comments blanked.
  for (const frame of stack) if (frame.kind === 'tpl') blankSqlStream(text, frame.sql, out);
  return out.join('');
}

/**
 * SQL text with `--` and `/* … *\/` comments replaced by spaces; quoted text is kept. The same
 * rules as for the SQL inside TypeScript strings and templates.
 */
export function blankSqlComments(text: string): string {
  const out = text.split('');
  const chars: SqlChar[] = [];
  for (let i = 0; i < text.length; i++) chars.push({ c: text[i] ?? '', from: i, to: i + 1 });
  blankSqlStream(text, chars, out);
  return out.join('');
}

// ---------------------------------------------------------------------------------------------
// Write detection.

// An optional double quote, also escaped (`\"`) inside a TypeScript string.
const Q = '(?:\\\\?")?';
const NAMES = LEDGER_TABLES.join('|');
/**
 * A ledger table reference; group 1 is the bare table name. Whitespace (comments are blanked to
 * whitespace before) may stand between the schema, the dot and the name; a name qualified by
 * another schema (`other.<table>`, also `other . <table>`) is no hit.
 */
const TABLE = `(?<![\\w$."]|\\.\\s*)${Q}(?:app${Q}\\s*\\.\\s*${Q})?(${NAMES})${Q}(?![\\w$])`;
/** One identifier: bare, or double-quoted (the quotes escaped inside a TypeScript string). */
const IDENT = `(?:\\\\?"[^"\\\\\\n]*\\\\?"|[\\w$]+)`;
/** Any table reference of a TRUNCATE list: `[ONLY] [schema .] name [*]`, spaces allowed. */
const ANY_TABLE = `(?:only\\s+)?${IDENT}(?:\\s*\\.\\s*${IDENT})?(?:\\s*\\*)?`;

const SQL_WRITES: { operation: string; pattern: RegExp }[] = [
  { operation: 'INSERT INTO', pattern: new RegExp(`\\binsert\\s+into\\s+${TABLE}`, 'giu') },
  { operation: 'UPDATE', pattern: new RegExp(`\\bupdate\\s+(?:only\\s+)?${TABLE}`, 'giu') },
  {
    operation: 'DELETE FROM',
    pattern: new RegExp(`\\bdelete\\s+from\\s+(?:only\\s+)?${TABLE}`, 'giu'),
  },
  { operation: 'MERGE INTO', pattern: new RegExp(`\\bmerge\\s+into\\s+${TABLE}`, 'giu') },
  {
    operation: 'COPY … FROM',
    pattern: new RegExp(`\\bcopy\\s+${TABLE}\\s*(?:\\([^)]*\\)\\s*)?from\\b`, 'giu'),
  },
];

const KYSELY_WRITE = new RegExp(
  `\\b(insertInto|updateTable|deleteFrom|mergeInto|replaceInto)\\s*(?:<[^>()]*>\\s*)?\\(\\s*['"\`]\\s*${TABLE}`,
  'giu',
);

const TRUNCATE_LIST = new RegExp(
  `\\btruncate\\s+(?:table\\s+)?(${ANY_TABLE}(?:\\s*,\\s*${ANY_TABLE})*)`,
  'giu',
);
const TABLE_ONLY = new RegExp(TABLE, 'giu');

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Writes to the ledger tables in a `.ts` or `.sql` source, one per table reference. */
export function findLedgerWrites(path: string, text: string): LedgerWrite[] {
  const isSql = path.endsWith('.sql');
  const code = isSql ? blankSqlComments(text) : blankTsComments(text);
  const starts = lineStarts(code);
  const writes: LedgerWrite[] = [];
  const add = (offset: number, table: string, operation: string): void => {
    writes.push({ line: lineAt(starts, offset), table: table.toLowerCase(), operation });
  };
  const tableOffset = (match: RegExpExecArray, table: string): number =>
    match.index + match[0].toLowerCase().indexOf(table.toLowerCase());

  for (const { operation, pattern } of SQL_WRITES) {
    for (const match of code.matchAll(pattern)) {
      const table = match[1] ?? '';
      add(tableOffset(match, table), table, operation);
    }
  }
  for (const match of code.matchAll(TRUNCATE_LIST)) {
    const list = match[1] ?? '';
    const listStart = match.index + match[0].length - list.length;
    for (const hit of list.matchAll(TABLE_ONLY)) {
      add(
        listStart + hit.index + hit[0].toLowerCase().indexOf((hit[1] ?? '').toLowerCase()),
        hit[1] ?? '',
        'TRUNCATE',
      );
    }
  }
  if (!isSql) {
    for (const match of code.matchAll(KYSELY_WRITE)) {
      const table = match[2] ?? '';
      add(tableOffset(match, table), table, match[1] ?? '');
    }
  }
  return writes.sort((a, b) => a.line - b.line || a.table.localeCompare(b.table));
}

/** Whether a listed file is scanned: `.ts` / `.sql`, no dependency or generated file. */
export function isScanned(path: string): boolean {
  if (!path.endsWith('.ts') && !path.endsWith('.sql')) return false;
  if (path.split('/').includes('node_modules')) return false;
  if (path.endsWith('.gen.ts')) return false;
  return path !== 'db/schema.sql';
}

/**
 * The listing narrowed to the files git tracks, for this check only (an untracked local draft
 * is not part of the commit CI checks). A walked tree (no .git) is returned unchanged.
 */
export function trackedFiles(root: string, tree: TreeListing): TreeListing {
  if (tree.mode !== 'git') return tree;
  const listed = tryGit(['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: root });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr}`);
  const tracked = new Set(listed.stdout.split('\0').filter((p) => p !== ''));
  return { files: tree.files.filter((file) => tracked.has(file)), mode: 'git' };
}

// ---------------------------------------------------------------------------------------------
// Allowlist.

export type AllowEntry = { path: string; reason: string; line: number };

export function parseLedgerAllowlist(text: string): { entries: AllowEntry[]; problems: string[] } {
  const entries: AllowEntry[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
    const where = `${LEDGER_WRITERS_ALLOWLIST}:${line}`;
    const tab = raw.indexOf('\t');
    const path = (tab === -1 ? raw : raw.slice(0, tab)).trim();
    const reason = tab === -1 ? '' : raw.slice(tab + 1).trim();
    if (/[*?[\]{}]/.test(path)) {
      problems.push(`${where}: 放行条目 "${path}" 含通配符；只能逐个列出文件或以 / 结尾的目录`);
      return;
    }
    if (
      path === '' ||
      path.startsWith('/') ||
      path.split('/').some((s) => s === '..' || s === '.')
    ) {
      problems.push(`${where}: 放行条目 "${path}" 不是仓库内的相对路径`);
      return;
    }
    if (reason === '') {
      problems.push(`${where}: 放行条目 "${path}" 缺理由（路径后加 Tab 再写理由）`);
      return;
    }
    entries.push({ path, reason, line });
  });
  return { entries, problems };
}

function entryProblem(root: string, entry: AllowEntry): string | null {
  const where = `${LEDGER_WRITERS_ALLOWLIST}:${entry.line}`;
  const full = join(root, entry.path);
  if (!existsSync(full)) {
    return `${where}: 放行条目 "${entry.path}" 在仓库里已不存在；从清单删去这一行`;
  }
  const isDir = statSync(full).isDirectory();
  if (isDir && !entry.path.endsWith('/')) {
    return `${where}: 放行条目 "${entry.path}" 是目录，目录条目要以 / 结尾`;
  }
  if (!isDir && entry.path.endsWith('/')) {
    return `${where}: 放行条目 "${entry.path}" 不是目录`;
  }
  return null;
}

function covers(entry: AllowEntry, file: string): boolean {
  return entry.path.endsWith('/') ? file.startsWith(entry.path) : file === entry.path;
}

// ---------------------------------------------------------------------------------------------
// The check.

export function ledgerWritersCheck(root: string, tree: TreeListing): CheckResult {
  const problems: string[] = [];
  const notices: string[] = [];
  const allowFile = join(root, LEDGER_WRITERS_ALLOWLIST);
  let entries: AllowEntry[] = [];
  if (existsSync(allowFile)) {
    const parsed = parseLedgerAllowlist(readFileSync(allowFile, 'utf8'));
    problems.push(...parsed.problems);
    for (const entry of parsed.entries) {
      const problem = entryProblem(root, entry);
      if (problem === null) entries.push(entry);
      else problems.push(problem);
    }
  } else {
    notices.push(`${LEDGER_WRITERS_ALLOWLIST} 不存在：没有放行条目`);
  }

  const used = new Set<AllowEntry>();
  for (const file of tree.files) {
    if (!isScanned(file)) continue;
    const writes = findLedgerWrites(file, readFileSync(join(root, file), 'utf8'));
    if (writes.length === 0) continue;
    const allowedBy = entries.find((entry) => covers(entry, file));
    if (allowedBy !== undefined) {
      used.add(allowedBy);
      continue;
    }
    for (const write of writes) {
      problems.push(
        `${file}:${write.line}: 直接写账务表，表：${write.table}，写法：${write.operation}。${ADVICE}`,
      );
    }
  }
  entries = entries.filter((entry) => !used.has(entry));
  for (const entry of entries) {
    notices.push(
      `${LEDGER_WRITERS_ALLOWLIST}:${entry.line}: 放行条目 "${entry.path}" 已没有命中的写入；` +
        '确认不再需要后可从清单删去',
    );
  }
  return result(LEDGER_WRITERS_CHECK, problems, notices);
}
