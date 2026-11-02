// B1-02zp §9 #11: the three reverify operations are implemented (no x-implementation: planned) and
// their generated artefacts follow. Read from the contract and the generated files only.
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire, ROOT } from '../../risk/signature/kit.ts';

const OPERATIONS = ['getReverify', 'reverifyByIdNumber', 'reverifyByOauth'] as const;

type Operation = { operationId?: string; 'x-implementation'?: string };

async function operations(): Promise<Map<string, Operation>> {
  const parser = apiRequire('@readme/openapi-parser') as {
    parse(path: string): Promise<{ paths: Record<string, { get?: Operation; post?: Operation }> }>;
  };
  const document = await parser.parse(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  const found = new Map<string, Operation>();
  for (const item of Object.values(document.paths)) {
    for (const operation of [item.get, item.post]) {
      if (operation?.operationId !== undefined) found.set(operation.operationId, operation);
    }
  }
  return found;
}

it.each(OPERATIONS)(
  '[AC-B1-02zp#1] 契约 %s 去掉 x-implementation: planned',
  async (operationId) => {
    const operation = (await operations()).get(operationId);
    expect(operation).toMatchObject({ operationId });
    expect(operation).not.toHaveProperty('x-implementation');
  },
);

it.each(OPERATIONS)(
  '[AC-B1-02zp#2] %s 进 route-schemas、出 planned-operations（生成物随契约）',
  async (operationId) => {
    const routes = (await import(
      new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
    )) as { CONTRACT_ROUTE_SCHEMAS: Record<string, unknown> };
    expect(Object.hasOwn(routes.CONTRACT_ROUTE_SCHEMAS, operationId)).toBe(true);
    const planned = (await import(
      new URL('packages/contracts-ts/src/planned-operations.gen.ts', ROOT).href
    )) as { plannedOperations: ReadonlySet<string> };
    expect(planned.plannedOperations.has(operationId)).toBe(false);
  },
);
