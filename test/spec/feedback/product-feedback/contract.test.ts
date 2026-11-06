// B1-28p: submitProductFeedback leaves planned (brief §9.2 ⑤): no x-implementation mark, out of the
// generated planned list, its request schema generated for the route; the operation's shape
// (optional auth, signed, idempotent, version gate, error codes) and the body that only carries the
// BR-ID-30 细则「商品反馈记录」 fields stay as CT-26q declared them. No database.
import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { PATH, contract } from './kit.ts';

it('[AC-B1-28p#29] 契约 submitProductFeedback 去掉 planned、生成请求 schema；鉴权、签名、幂等、版本门禁与错误码不变', async () => {
  const doc = await contract();
  const op = doc.paths[PATH]?.post;
  expect(op).toBeDefined();
  expect(op).not.toHaveProperty('x-implementation');
  expect(plannedOperations.has('submitProductFeedback')).toBe(false);
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('submitProductFeedback');
  expect(op).toMatchObject({
    operationId: 'submitProductFeedback',
    'x-auth': 'optional',
    'x-signed': true,
    'x-idempotent': true,
    'x-min-version-gate': true,
    'x-error-codes': [30145, 20001, 30144, 42901, 10405],
  });
  const body = (
    op as unknown as {
      requestBody: { content: Record<string, { schema: Record<string, unknown> }> };
    }
  ).requestBody.content['application/json']?.schema;
  expect(body?.['additionalProperties']).toBe(false);
  expect(Object.keys((body?.['properties'] ?? {}) as object).sort()).toEqual([
    'item_ref',
    'link_id',
    'note',
    'platform',
    'quoted_at',
    'reason',
    'shown_final_price_fen',
    'shown_rebate_fen',
  ]);
});
