import { expect, it } from 'vitest';
import openapi from '../../../../../contracts/openapi.yaml?raw';
import {
  anonymousOperations,
  isAnonymousOperation,
  isNoneAuthOperation,
  isOptionalAuthOperation,
  noneAuthOperations,
  optionalAuthOperations,
} from './anonymous.ts';

type Auth = 'none' | 'optional' | 'bearer';

/** Line reader for the contract layout (2-space paths, 4-space methods, 6-space security). */
function contractAuth(): Map<string, Auth | 'undeclared'> {
  const result = new Map<string, Auth | 'undeclared'>();
  const lines = openapi.split('\n');
  let path: string | null = null;
  let operation: string | null = null;
  lines.forEach((line, index) => {
    const pathMatch = /^ {2}(\/[^:]+):$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1]!.startsWith('/admin/') ? null : pathMatch[1]!;
      operation = null;
      return;
    }
    if (/^\S/.test(line)) path = null;
    const methodMatch = /^ {4}(get|post|put|patch|delete|head|options):$/.exec(line);
    if (methodMatch && path !== null) {
      operation = `${methodMatch[1]!.toUpperCase()} ${path}`;
      result.set(operation, 'undeclared');
      return;
    }
    if (operation === null || !line.startsWith('      security:')) return;
    const inline = line.slice('      security:'.length).trim();
    const items: string[] = [];
    for (let next = index + 1; lines[next]?.startsWith('        - ') === true; next += 1) {
      items.push(lines[next]!.trim().slice(2));
    }
    if (inline === '[]') result.set(operation, 'none');
    else if (items.includes('{}')) result.set(operation, 'optional');
    else if (inline === '' && items.length === 1 && items[0] === 'bearerAuth: []') {
      result.set(operation, 'bearer');
    } else throw new Error(`unexpected security on ${operation}: ${line} ${items.join(',')}`);
  });
  return result;
}

it('none and optional lists equal the contract operations with security [] and optional {}', () => {
  const auth = contractAuth();
  expect(auth.size).toBeGreaterThan(0);
  expect([...auth].filter(([, kind]) => kind === 'undeclared')).toEqual([]);
  const of = (kind: Auth) => [...auth].filter(([, k]) => k === kind).map(([op]) => op);
  expect([...noneAuthOperations].sort()).toEqual(of('none').sort());
  expect([...optionalAuthOperations].sort()).toEqual(of('optional').sort());
  expect([...anonymousOperations].sort()).toEqual([...of('none'), ...of('optional')].sort());
  expect(auth.get('GET /v1/articles')).toBe('none');
  expect(auth.get('GET /v1/products/{product_key}')).toBe('optional');
  expect(auth.get('GET /v1/me')).toBe('bearer');
});

it('matches method and path template exactly', () => {
  expect(isAnonymousOperation('GET', '/v1/articles/{article_id}')).toBe(true);
  expect(isAnonymousOperation('get', '/v1/articles')).toBe(true);
  expect(isAnonymousOperation('get', '/v1/rank/hot')).toBe(true);
  expect(isAnonymousOperation('POST', '/v1/articles')).toBe(false);
  expect(isAnonymousOperation('GET', '/v1/articles/fixture-article')).toBe(false);
  expect(isAnonymousOperation('GET', '/v1/me')).toBe(false);
  expect(isNoneAuthOperation('get', '/v1/articles')).toBe(true);
  expect(isNoneAuthOperation('GET', '/v1/rank/hot')).toBe(false);
  expect(isOptionalAuthOperation('post', '/v1/events')).toBe(true);
  expect(isOptionalAuthOperation('GET', '/v1/articles')).toBe(false);
  expect(isOptionalAuthOperation('GET', '/v1/me')).toBe(false);
});
