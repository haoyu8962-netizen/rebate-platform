// DSX-47 test support: repo paths and TypeScript AST helpers for static scans of the H5 sources.
// Nothing here imports lint/style or the H5 code: the scans read the committed source text.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect } from 'vitest';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** All H5 sources (shared icons may live anywhere under here outside the entries). */
export const H5_SRC = 'apps/h5/src';
/** Page entries; the shared icon definitions must not sit under this directory. */
export const H5_ENTRIES = 'apps/h5/src/entries';
/** The App entry whose pages this task migrates (the conformance entry is separate). */
export const APP_ENTRY = 'apps/h5/src/entries/app';

const NOT_SOURCE = /\.(?:test|spec)\.tsx?$|\.d\.ts$|\.gen\.ts$/;

/** Repo-relative POSIX paths of the non-test .ts / .tsx sources under a repo-relative root. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(REPO, root), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(REPO, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (/\.tsx?$/.test(path) && !NOT_SOURCE.test(path)) out.push(path);
  }
  out.sort();
  expect(out.length, `${root} has .ts / .tsx sources`).toBeGreaterThan(0);
  return out;
}

export function readRepo(path: string): string {
  return readFileSync(resolve(REPO, path), 'utf8');
}

export function parse(path: string): ts.SourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, readRepo(path), ts.ScriptTarget.Latest, true, kind);
}

/** 1-based line of the node's first token. */
export function lineAt(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Calls `visit` on the node and every descendant, depth first. */
export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

/** True when `path` lies under the repo-relative directory `root`. */
export function isUnder(path: string, root: string): boolean {
  return path.startsWith(`${root}/`);
}
