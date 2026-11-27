import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

type Mapping = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', root));
const parser = apiRequire('@readme/openapi-parser') as {
  parse(path: string): Promise<unknown>;
  dereference(path: string): Promise<unknown>;
};

export function mapping(value: unknown, label: string): Mapping {
  expect(value, label).not.toBeNull();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as Mapping;
}

export function at(value: unknown, ...keys: string[]): Mapping {
  return keys.reduce(
    (current, key) => mapping(current[key], keys.join('.')),
    mapping(value, keys.join('.')),
  );
}

export function list(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function file(path: string): string {
  const url = new URL(path, root);
  expect(existsSync(url), `缺少 ${path}`).toBe(true);
  return fileURLToPath(url);
}

export async function readMapping(path: string): Promise<Mapping> {
  return mapping(await parser.parse(file(path)), path);
}

export async function readOpenApi(): Promise<Mapping> {
  const path = 'contracts/openapi.yaml';
  return mapping(await parser.dereference(file(path)), path);
}
