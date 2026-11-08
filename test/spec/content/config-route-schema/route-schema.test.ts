// F1-02zzzi: GET /v1/config registers the contract's getConfig route schema directly, without the
// try/catch fallback that was kept while getConfig was still `x-implementation: planned`.
// One case only: the new rule (no fallback in the source) comes first, then the unchanged
// behaviour (the mounted schema is the contract's own object) as a control in the same case.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { ConfigController } from '../../../../apps/api/src/modules/content/http/public/config.controller.ts';
import { contractRouteSchema } from '../../../../apps/api/src/modules/platform/index.ts';

const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
// @nestjs/platform-fastify's FASTIFY_ROUTE_SCHEMA_METADATA (not on the package's public entry).
const ROUTE_SCHEMA_METADATA = '__fastify_route_schema__';
const CONTROLLER = 'apps/api/src/modules/content/http/public/config.controller.ts';

it('[AC-F1-02zzzi#1] 控制器直接注册 getConfig 的契约 schema：源码无 planned 回落，注册的 schema 仍是契约那一份且非空', () => {
  // New rule: no try/catch fallback, no planned TODO, no cast or empty-schema branch.
  const source = readFileSync(new URL(CONTROLLER, ROOT), 'utf8');
  expect(source).not.toMatch(/\bcatch\b/);
  expect(source).not.toContain('x-implementation: planned');
  expect(source).not.toContain('as ContractOperationId');
  expect(source).not.toContain('Record<string, never>');
  expect(source).toMatch(/RouteSchema\(\s*contractRouteSchema\('getConfig'\)\s*\)/);

  // Control (no behaviour change): the mounted route schema is the contract's own object.
  apiRequire('reflect-metadata');
  const metadata = Reflect as typeof Reflect & {
    getMetadata(key: string, target: object): unknown;
  };
  const contract = contractRouteSchema('getConfig');
  const mounted = metadata.getMetadata(ROUTE_SCHEMA_METADATA, ConfigController.prototype.read);
  expect(mounted).toBe(contract);
  expect(typeof mounted).toBe('object');
  expect(mounted).not.toBeNull();
  expect(Object.keys(mounted as object).length).toBeGreaterThan(0);
});
