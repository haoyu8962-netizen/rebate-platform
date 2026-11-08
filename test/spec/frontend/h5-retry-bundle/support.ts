// DSX-47a test support: repo paths and TypeScript AST helpers for static reads of the H5 sources
// and of lint/style/baseline.json. Copied in the style of h5-base-migration/support.ts so this
// directory stands on its own; nothing here imports the H5 code or lint/style.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect } from 'vitest';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** All H5 sources. */
export const H5_SRC = 'apps/h5/src';
/** The base components (Button and friends). */
export const BASE_DIR = 'apps/h5/src/components/base';
/** The H5 load-failure page this task moves onto the base Button. */
export const RETRY_PAGE = 'apps/h5/src/components/retry/retry-page.tsx';
export const BASELINE = 'lint/style/baseline.json';
export const RAW_PRESSABLE_RULE = 'couli-style/no-raw-pressable';

const NOT_SOURCE = /\.(?:test|spec)\.tsx?$|\.d\.ts$|\.gen\.ts$/;

/** Repo-relative POSIX path of an absolute path. */
export function repoPath(path: string): string {
  return relative(REPO, path).split(sep).join('/');
}

/** Repo-relative POSIX paths of the non-test .ts / .tsx sources under a repo-relative root. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(REPO, root), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = repoPath(join(entry.parentPath, entry.name));
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

/** True when the repo-relative `path` lies under the repo-relative directory `root`. */
export function isUnder(path: string, root: string): boolean {
  return path.startsWith(`${root}/`);
}
