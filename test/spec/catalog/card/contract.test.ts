// price_unavailable 卡的 link_id 形状待契约同步（BR-PRICE-01 与 ProductCard.link_id 必填冲突），由后续契约任务与 B1-07a 覆盖。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { fixture, quote, request } from './kit.ts';

// B1-05zc (D10-641): pre-order cards no longer carry a compare range; the shapes are a normal
// single amount, a one-fen single amount and no_rebate. A taobao search card (the old compare
// source) is checked too: one amount on the normal basis with rebate_estimate.
it('[AC-B1-05f#22] 普通、一分单值和无返利的带价卡都符合 ProductCard 契约，淘宝搜索卡为单值', async () => {
  const f = fixture();
  const root = new URL('../../../../', import.meta.url);
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  const contract = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  const schema = contract.components.schemas['ProductCard'];
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  for (const value of [
    quote(),
    quote({ rebateMinFen: 1n, rebateMaxFen: 1n, estNetPriceFen: 9999n }),
    quote({ rebateBasis: 'no_rebate', rebateMinFen: 0n, rebateMaxFen: 0n, estNetPriceFen: null }),
  ]) {
    f.quoted.mockResolvedValue(value);
    const card = await f.service.assemble(
      request({ entrySource: value.rebateBasis === 'normal' ? 'pool' : 'search' }),
    );
    const serialized: unknown = JSON.parse(JSON.stringify(card));
    expect(validate(serialized), JSON.stringify(validate.errors)).toBe(true);
    expect(card.link_id).toBe('registered-link');
    expect(card.item_ref).toBe('opaque-item-ref');
  }
  // The default port double answers the basis asked for: a card still asking for
  // price_compare_risk on a search source gets the old 211–433 range and fails here.
  const g = fixture();
  const search = await g.service.assemble(request({ entrySource: 'search' }));
  const serializedSearch: unknown = JSON.parse(JSON.stringify(search));
  expect(validate(serializedSearch), JSON.stringify(validate.errors)).toBe(true);
  expect(search).toMatchObject({
    rebate_basis: 'normal',
    rebate_min_fen: search.rebate_max_fen,
  });
  expect(search.disclaimer_keys).toContain('rebate_estimate');
  expect(search.disclaimer_keys).not.toContain('rebate_compare');
});
