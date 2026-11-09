// DSX-48d Node-side helpers: repository files, TypeScript AST reads and CSS text of the H5
// sources (in the style of h5-state-motion/kit.ts and h5-image/node-kit.ts, copied so this
// directory stands on its own). Missing files fail an assertion, never throw at collection time.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect } from 'vitest';
import { REQUIRED_TOKENS } from './contract.ts';

/** This test directory. */
export const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root (this file is test/spec/frontend/h5-transitions/node-kit.ts). */
export const REPO = resolve(HERE, '../../../..');

/** Repo-relative POSIX path of an absolute path. */
export function repoPath(path: string): string {
  return relative(REPO, path).split(sep).join('/');
}

export function readRepo(path: string): string {
  const file = resolve(REPO, path);
  expect(existsSync(file), `${path} exists`).toBe(true);
  return readFileSync(file, 'utf8');
}

/** Files under `dir` (repository relative), recursively, as repository-relative paths. */
export function filesUnder(dir: string): string[] {
  const start = resolve(REPO, dir);
  expect(existsSync(start), `${dir} exists`).toBe(true);
  const result: string[] = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) visit(full);
      else result.push(repoPath(full));
    }
  };
  visit(start);
  return result.sort();
}

/** Non-test TS / TSX / CSS sources under the directories (generated files left out). */
export function sourcesUnder(dirs: readonly string[]): string[] {
  return dirs
    .flatMap((dir) => filesUnder(dir))
    .filter(
      (file) =>
        /\.(?:ts|tsx|css)$/.test(file) && !/\.test\.tsx?$/.test(file) && !/\.gen\./.test(file),
    );
}

export function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function parse(path: string, text: string): ts.SourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

/** Calls `visit` on the node and every descendant, depth first. */
export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

/** Literal text of a string, template or JSX text node; template holes read as `var(--x)`. */
export function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
      'var(--x)',
    );
  }
  return null;
}

/** Items of a comma-separated CSS value (commas inside parentheses do not split). */
export function listItems(value: string): string[] {
  return value
    .split(/,(?![^(]*\))/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Words of one CSS list item (spaces inside parentheses do not split). */
function words(item: string): string[] {
  return item.split(/\s+(?![^(]*\))/).filter((word) => word !== '');
}

const NOT_A_PROPERTY = new Set([
  'ease',
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
  'allow-discrete',
  'normal',
]);

/**
 * Property names a `transition` shorthand (or `transition-property` value) lists; an item that
 * names none transitions `all`.
 */
export function transitionProperties(value: string, shorthand: boolean): string[] {
  return listItems(value).map((item) => {
    if (!shorthand) return item.toLowerCase();
    const name = words(item).find(
      (word) => /^-?[a-z][a-z-]*$/i.test(word) && !NOT_A_PROPERTY.has(word.toLowerCase()),
    );
    return (name ?? 'all').toLowerCase();
  });
}

export interface CssBlock {
  name: string;
  body: string;
}

/** Blocks opened by `opener` (a global regex whose group 1 is the name), with balanced bodies. */
export function cssBlocks(css: string, opener: RegExp): CssBlock[] {
  const blocks: CssBlock[] = [];
  for (let match = opener.exec(css); match !== null; match = opener.exec(css)) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth += 1;
      else if (css[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push({ name: match[1] ?? '', body: css.slice(opener.lastIndex, index - 1) });
  }
  return blocks;
}

/**
 * The Tailwind utility of a class token: the part after its last variant colon outside brackets
 * (`motion-reduce:transition-none` → `transition-none`).
 */
export function utilityOf(token: string): string {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (char === ':' && depth === 0) cut = index;
  }
  return token.slice(cut + 1).replace(/^!/, '');
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** CSS text (no comments), or the strings, templates, JSX text and identifiers of a TS source. */
export function searchableTexts(file: string): string[] {
  const source = readRepo(file);
  if (file.endsWith('.css')) return [withoutComments(source)];
  const texts: string[] = [];
  walk(parse(file, source), (node) => {
    const text = literalText(node);
    if (text !== null) texts.push(text);
    else if (ts.isIdentifier(node)) texts.push(node.text);
  });
  return texts;
}

/** REQUIRED_TOKENS that no source under `dirs` references in any of their spellings. */
export function missingTokens(dirs: readonly string[]): string[] {
  const texts = sourcesUnder(dirs).flatMap(searchableTexts);
  return REQUIRED_TOKENS.filter(
    ({ aliases }) =>
      !aliases.some((alias) => {
        const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`);
        return texts.some((text) => pattern.test(text));
      }),
  ).map(({ token, aliases }) => `${token} (${aliases.join(' / ')})`);
}
