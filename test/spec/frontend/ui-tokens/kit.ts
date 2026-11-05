import { existsSync, readFileSync } from 'node:fs';
import type { DesignTokens } from '@couli/ui-tokens';
import { expect } from 'vitest';

const moduleUrl = import.meta.url;
export const SOURCE_COMMIT = 'f088f0473230d1e70232b8a246b92ef53d723929';
export const ROOT = new URL('../../../../', moduleUrl);

// JSON is copied byte for byte from this planning commit, not the implementation snapshot.
// CSS preserves the old fixture plus the seven additions derived from the generation rules.
export function baseline(): DesignTokens {
  return JSON.parse(
    readFileSync(new URL('./fixtures/design-tokens.f088f04.json', moduleUrl), 'utf8'),
  ) as DesignTokens;
}

export function requiredText(path: string): string {
  const url = new URL(path, ROOT);
  // Missing implementation assets must fail an assertion, never throw ENOENT at collection time.
  expect(existsSync(url), `${path} must be generated/committed`).toBe(true);
  return readFileSync(url, 'utf8');
}

export function snapshot(): DesignTokens {
  return JSON.parse(requiredText('contracts/design-tokens.json')) as DesignTokens;
}

export function record(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

export function tokenLeaves(node: unknown, path: string[] = []): [string, string][] {
  const object = record(node);
  if ('type' in object && 'value' in object) {
    expect(typeof object.type).toBe('string');
    return [[`--${path.join('-')}`, object.type as string]];
  }
  return Object.entries(object).flatMap(([key, child]) => tokenLeaves(child, [...path, key]));
}

export function themeLeaves(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  return Object.values(record(node)).flatMap(themeLeaves);
}

export function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function block(css: string, selector: RegExp): string {
  const matches = [...withoutComments(css).matchAll(selector)];
  expect(matches).toHaveLength(1);
  return matches[0]![1]!;
}

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

export function rootDeclarations(css: string): Map<string, string> {
  return declarations(block(css, /:root\s*\{([^{}]*)\}/g));
}

export function baselineDeclarations(): Map<string, string> {
  return rootDeclarations(
    readFileSync(new URL('./fixtures/variables.f088f04.css', moduleUrl), 'utf8'),
  );
}
