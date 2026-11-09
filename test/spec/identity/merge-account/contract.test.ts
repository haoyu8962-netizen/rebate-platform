// B1-20c: mergeAccount is implemented (no x-implementation: planned) and its generated artefacts
// follow the contract (task title「去掉 mergeAccount 的 planned」); D10-1103 adds 10010 to its error
// codes. Read from the contract and the generated files only.
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire, ROOT } from '../../risk/signature/kit.ts';

type Operation = {
  operationId?: string;
  'x-implementation'?: string;
  'x-signed'?: boolean;
  'x-idempotent'?: boolean;
  'x-min-version-gate'?: boolean;
  'x-auth'?: string;
  'x-error-codes'?: number[];
};

async function mergeOperation(): Promise<Operation | undefined> {
  const parser = apiRequire('@readme/openapi-parser') as {
    parse(path: string): Promise<{ paths: Record<string, { post?: Operation }> }>;
  };
  const document = await parser.parse(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  return document.paths['/v1/auth/merge']?.post;
}

it('[AC-B1-20c#1] 契约 mergeAccount 去掉 x-implementation: planned，其余标记不变（login、签名、幂等、版本门）', async () => {
  const operation = await mergeOperation();
  expect(operation).toMatchObject({
    operationId: 'mergeAccount',
    'x-auth': 'login',
    'x-signed': true,
    'x-idempotent': true,
    'x-min-version-gate': true,
  });
  expect(operation).not.toHaveProperty('x-implementation');
});

it('[AC-B1-20c#46] D10-1103 mergeAccount 的 x-error-codes 含 10010（目标待加验、本设备未加验），原有的 20001 / 30411 / 50001 / 10405 仍在', async () => {
  const operation = await mergeOperation();
  expect(operation?.['x-error-codes']).toEqual(
    expect.arrayContaining([10010, 20001, 30411, 50001, 10405]),
  );
});

it('[AC-B1-20c#2] mergeAccount 进 route-schemas、出 planned-operations（生成物随契约）', async () => {
  const planned = (await import(
    new URL('packages/contracts-ts/src/planned-operations.gen.ts', ROOT).href
  )) as { plannedOperations: ReadonlySet<string> };
  expect(planned.plannedOperations.has('mergeAccount')).toBe(false);
  const routes = (await import(
    new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
  )) as { CONTRACT_ROUTE_SCHEMAS: Record<string, unknown> };
  expect(Object.hasOwn(routes.CONTRACT_ROUTE_SCHEMAS, 'mergeAccount')).toBe(true);
});
