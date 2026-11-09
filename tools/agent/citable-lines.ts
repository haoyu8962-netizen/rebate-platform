// citable-lines.ts — the lines a money review may cite in its checklist (CT-06zzzzn, D10-1119).
//
// validate-output.ts --money --diff-base <base> --cwd <worktree> rejects a whole review output
// whose checklist cites a file:line outside the diff (gitLineChecker). It is not relaxed; instead
// codex-run.sh hands the reviewer, as data, the very ranges that checker accepts:
//   - every file of `git diff --name-only <base>` (changed, deleted, emptied, a new file in the
//     index): the hunks of `git diff --no-color --no-ext-diff -U3 <base> -- <file>` by
//     validate-output's own parseHunks (new side; the old side for a hunk without new lines);
//   - every untracked file that is not in the base either: the whole file, 1..N with N the
//     '\n'-split segments of its content.
// The per-file decision (in the base? tracked?) is the same git calls gitLineChecker makes.
//
// Usage: node tools/agent/citable-lines.ts --base <commit> --cwd <worktree>
// Prints the body of the prompt section (an opening sentence, then one `- <path>: a-b, c-d` line
// per file). Exit 0; 2 on a usage error or when git cannot be read (the caller then says the
// lines could not be computed).
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { git } from '../lib/git.ts';
import { type LineRange, parseHunks } from './validate-output.ts';

export type CitableEntry = { path: string; ranges: LineRange[]; problem: string };

function gitOrNull(args: readonly string[], cwd: string): string | null {
  try {
    return git(args, { cwd });
  } catch {
    return null;
  }
}

/** NUL-separated git output as a list of paths (the raw names, never quoted). */
function pathList(args: readonly string[], cwd: string): string[] {
  return git(['-c', 'core.quotepath=false', ...args], { cwd })
    .split('\0')
    .filter((path) => path !== '');
}

/** validate-output's isSafeRelativePath: a path it never resolves is never citable. */
function isSafeRelativePath(file: string): boolean {
  if (file === '' || isAbsolute(file) || file.includes('\\') || file.includes('\0')) return false;
  return !file.split('/').some((segment) => segment === '..' || segment === '');
}

/** The ranges gitLineChecker accepts for one file, or why it accepts none. */
function rangesOf(base: string, cwd: string, file: string): CitableEntry {
  if (!isSafeRelativePath(file)) {
    return { path: file, ranges: [], problem: 'not a path validate-output resolves' };
  }
  const inBase = gitOrNull(['cat-file', '-e', `${base}:${file}`], cwd) !== null;
  const tracked = gitOrNull(['ls-files', '--error-unmatch', '--', file], cwd) !== null;
  if (!inBase && !tracked) {
    if (!existsSync(join(cwd, file))) {
      return { path: file, ranges: [], problem: 'exists neither in the base nor in the worktree' };
    }
    try {
      const lines = readFileSync(join(cwd, file), 'utf8').split('\n').length;
      return { path: file, ranges: [{ start: 1, end: lines }], problem: '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { path: file, ranges: [], problem: `cannot be read (${message})` };
    }
  }
  const diff = gitOrNull(['diff', '--no-color', '--no-ext-diff', '-U3', base, '--', file], cwd);
  if (diff === null) return { path: file, ranges: [], problem: 'git diff failed' };
  const ranges = parseHunks(diff);
  return {
    path: file,
    ranges,
    problem: ranges.length > 0 ? '' : 'no diff hunks (binary or mode change only)',
  };
}

/**
 * Every changed file (against `base`) and every untracked file of the worktree `cwd`, each once,
 * changed files first, with the line ranges validate-output accepts for a checklist citation.
 */
export function citableLines(base: string, cwd: string): CitableEntry[] {
  if (gitOrNull(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd) === null) {
    throw new Error(`--base ${base}: not a commit in ${cwd}`);
  }
  const seen = new Set<string>();
  const files: string[] = [];
  const changed = pathList(['diff', '--name-only', '-z', '--no-ext-diff', base, '--'], cwd);
  const untracked = pathList(['ls-files', '-z', '--others', '--exclude-standard'], cwd);
  for (const file of [...changed, ...untracked]) {
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files.map((file) => rangesOf(base, cwd, file));
}

/** A path as one line of the section: JSON-quoted only when it holds a line break. */
function shownPath(path: string): string {
  return /[\r\n]/.test(path) ? JSON.stringify(path) : path;
}

/** The section body: the opening sentence, then one line per file. */
export function formatCitable(entries: readonly CitableEntry[], base: string): string {
  const head = [
    'Each money checklist entry must cite a file:line inside one of the ranges below. They are',
    `exactly the lines validate-output accepts: the -U3 hunks of \`git diff ${base}\` (new side;`,
    'the old side for a hunk without new lines) and every untracked file whole; one citation',
    'outside them invalidates the whole review. An item with no relevant change in this round is',
    'marked na and still cites one line inside these ranges, with a note saying why the item does',
    'not apply there.',
    '',
  ];
  if (entries.length === 0) return [...head, '(no changed or untracked files)'].join('\n');
  const lines = entries.map((e) =>
    e.ranges.length > 0
      ? `- ${shownPath(e.path)}: ${e.ranges.map((r) => `${r.start}-${r.end}`).join(', ')}`
      : `- ${shownPath(e.path)}: (no citable lines: ${e.problem})`,
  );
  return [...head, ...lines].join('\n');
}

export function main(argv: readonly string[]): number {
  let base = '';
  let cwd = '';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === '--base' || flag === '--cwd') && value !== undefined) {
      if (flag === '--base') base = value;
      else cwd = value;
      i++;
    } else {
      process.stderr.write(`citable-lines.ts: unknown or incomplete argument: ${flag ?? ''}\n`);
      return 2;
    }
  }
  if (base === '' || base.startsWith('-') || cwd === '') {
    process.stderr.write('usage: citable-lines.ts --base <commit> --cwd <worktree>\n');
    return 2;
  }
  process.stdout.write(`${formatCitable(citableLines(base, cwd), base)}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`citable-lines.ts: ${message}\n`);
    process.exitCode = 2;
  }
}
