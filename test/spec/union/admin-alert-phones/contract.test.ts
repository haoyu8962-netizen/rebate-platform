// B1-22g / BR-ID-24 细则「后台告警手机号与重新授权会话」(D10-152 ④), 01 F-ADM-16, SPEC_REF 3a301d1:
// the three alert phone operations go live (x-implementation planned removed).
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../../admin/auth/kit.ts';

const PATH = '/admin/v1/union-accounts/alert-phones';
const operations = [
  ['get', 'adminListUnionAlertPhones', false],
  ['post', 'adminAddUnionAlertPhone', true],
  ['delete', 'adminRemoveUnionAlertPhone', true],
] as const;

interface OperationDoc {
  operationId: string;
  'x-implementation'?: string;
  'x-auth': string;
  'x-error-codes': number[];
  parameters: { name: string; in: string }[];
}

async function paths() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, Record<string, OperationDoc>> }>;
  };
  const doc = await parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return doc.paths;
}

// 标题沿用原文，二次验证期望以块内断言为准。
it.each(operations)(
  '[B1-22g][BR-ID-24] %s alert-phones (%s) 上线移除 planned；后台身份、无幂等键，只有增删要 step-up',
  async (method, operationId) => {
    const operation = (await paths())[PATH]?.[method];
    expect(operation).toBeDefined();
    expect(operation!.operationId).toBe(operationId);
    expect(operation!['x-implementation']).toBeUndefined();
    expect(operation!['x-auth']).toBe('admin');
    const parameters = operation!.parameters.map((p) => p.name.toLowerCase());
    expect(parameters).not.toContain('idempotency-key');
    expect(operation!['x-error-codes']).toContain(10403);
    expect(parameters).not.toContain('x-step-up-token');
    expect(operation!['x-error-codes']).not.toContain(10003);
    if (method !== 'get') {
      expect(operation!['x-error-codes']).toEqual(expect.arrayContaining([20001, 20902]));
    }
  },
);

it('[B1-22g][D10-152] 删除只在 query 里带 phone_id 与 expected_version，没有请求体', async () => {
  const operation = (await paths())[PATH]?.['delete'] as
    (OperationDoc & { requestBody?: unknown }) | undefined;
  expect(operation).toBeDefined();
  expect(operation!['x-implementation']).toBeUndefined();
  const query = operation!.parameters.filter((p) => p.in === 'query').map((p) => p.name);
  expect(query.sort()).toEqual(['expected_version', 'phone_id']);
  expect(operation!.requestBody).toBeUndefined();
});
