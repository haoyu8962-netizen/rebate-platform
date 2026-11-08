// DSX-48c node-side helpers: repository paths and TypeScript AST reads of the H5 sources (in the
// style of h5-retry-bundle/support.ts, copied so this directory stands on its own). Missing files
// fail an assertion, never throw at collection time.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect } from 'vitest';
import { IMAGE_EXPORT } from './contract.ts';

/** Repository root (this file is test/spec/frontend/h5-image/node-kit.ts). */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** This test directory. */
export const HERE = dirname(fileURLToPath(import.meta.url));

export const BASE_INDEX = 'apps/h5/src/components/base/index.ts';
export const ARTICLE_BODY = 'apps/h5/src/components/article-body/article-body.tsx';
export const INVITE_PAGE = 'apps/h5/src/entries/app/pages/invite/invite-page.tsx';

/** Repo-relative POSIX path of an absolute path. */
export function repoPath(path: string): string {
  return relative(REPO, path).split(sep).join('/');
}

export function readRepo(path: string): string {
  const file = resolve(REPO, path);
  expect(existsSync(file), `${path} exists`).toBe(true);
  return readFileSync(file, 'utf8');
}

export function parse(path: string): ts.SourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, readRepo(path), ts.ScriptTarget.Latest, true, kind);
}

/** Calls `visit` on the node and every descendant, depth first. */
export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

/**
 * Repo-relative path of the module base/index.ts re-exports AsyncImage from
 * (`export { AsyncImage, … } from './X.tsx'`), or null when it does not.
 */
export function imageModule(): string | null {
  const index = parse(BASE_INDEX);
  for (const statement of index.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    const names = statement.exportClause.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => element.name.text);
    if (!names.includes(IMAGE_EXPORT)) continue;
    const path = posix.normalize(
      posix.join(posix.dirname(BASE_INDEX), statement.moduleSpecifier.text),
    );
    expect(existsSync(resolve(REPO, path)), `${path} (re-exported by ${BASE_INDEX}) exists`).toBe(
      true,
    );
    return path;
  }
  return null;
}
