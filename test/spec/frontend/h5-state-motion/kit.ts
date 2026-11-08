// Node-side helpers of the DSX-48 rule tests: repository files and CSS text. Missing files and
// missing keys fail an assertion, never throw at collection time.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root (this file is test/spec/frontend/h5-state-motion/kit.ts). */
export const ROOT = resolve(HERE, '../../../..');

export function repoPath(path: string): string {
  return resolve(ROOT, path);
}

export function requiredText(path: string): string {
  const file = repoPath(path);
  expect(existsSync(file), `${path} must exist`).toBe(true);
  return readFileSync(file, 'utf8');
}

export function requiredJson(path: string): Record<string, unknown> {
  return record(JSON.parse(requiredText(path)), path);
}

export function record(value: unknown, label: string): Record<string, unknown> {
  expect(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  ).toBe(true);
  return value as Record<string, unknown>;
}

/** Follows a dot path through nested objects; a missing step fails an assertion. */
export function at(root: unknown, path: string, label: string): unknown {
  let node: unknown = root;
  for (const key of path.split('.')) {
    const object = record(node, `${label}: parent of ${key} in ${path}`);
    expect(Object.hasOwn(object, key), `${label} has ${path}`).toBe(true);
    node = object[key];
  }
  return node;
}

/** Leaf tokens under `node` (a node with `type` or `value` is a token), keyed by dot path. */
export function tokenLeaves(node: unknown, prefix: string): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const walk = (value: unknown, path: string): void => {
    const object = record(value, path);
    if ('type' in object || 'value' in object) {
      result.set(path, object);
      return;
    }
    for (const [key, child] of Object.entries(object)) walk(child, `${path}.${key}`);
  };
  walk(node, prefix);
  return result;
}

export function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** `name: value` declarations of a rule body (no nested blocks); duplicates fail. */
export function declarations(body: string): Map<string, string> {
  const entries = body
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): [string, string] => {
      const colon = part.indexOf(':');
      expect(colon, `CSS declaration: ${part}`).toBeGreaterThan(0);
      return [
        part.slice(0, colon).trim(),
        part
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, ' '),
      ];
    });
  const result = new Map(entries);
  expect(result.size, 'duplicate CSS declarations').toBe(entries.length);
  return result;
}

/** Body of the first bare `:root { … }` rule (the light token block of tokens.gen.css). */
export function lightDeclarations(css: string): Map<string, string> {
  const match = /:root\s*\{([^{}]*)\}/.exec(withoutComments(css));
  expect(match, 'a :root { … } block').not.toBeNull();
  return declarations(match?.[1] ?? '');
}

/** Same selectors as tokens.gen.css's two dark blocks (packages/ui-tokens/src/generate.ts). */
export const SYSTEM_DARK =
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^{}]*)\}\s*\}/g;
export const EXPLICIT_DARK = /:root\[data-theme="dark"\]\s*\{([^{}]*)\}/g;

export interface MediaRule {
  condition: string;
  body: string;
}

/** Every `@media … { … }` rule of a CSS text (comments removed), with its balanced body. */
export function mediaRules(css: string): MediaRule[] {
  const text = withoutComments(css);
  const rules: MediaRule[] = [];
  const opener = /@media\s*([^{]*)\{/g;
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < text.length && depth > 0) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') depth -= 1;
      index += 1;
    }
    const body = text.slice(opener.lastIndex, index - 1);
    rules.push({ condition: (match[1] ?? '').trim(), body });
  }
  return rules;
}

/** Bodies of the media rules whose condition matches and that hold a rule with a declaration. */
export function nonEmptyMedia(css: string, condition: RegExp): string[] {
  return mediaRules(css)
    .filter((rule) => condition.test(rule.condition))
    .map((rule) => rule.body)
    .filter((body) => /\{[^{}]*?[a-z-]+\s*:\s*[^;{}\s][^;{}]*/i.test(body));
}

/** Files under `dir` (repository relative), recursively, as repository-relative paths. */
export function filesUnder(dir: string): string[] {
  const start = repoPath(dir);
  expect(existsSync(start), `${dir} must exist`).toBe(true);
  const result: string[] = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else result.push(relative(ROOT, full).split('\\').join('/'));
    }
  };
  walk(start);
  return result.sort();
}
