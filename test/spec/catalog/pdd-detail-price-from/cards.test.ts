// B1-04zzn (S-19, D10-728 ②, BR-PROD-04): only the pinduoduo product detail priced from the union
// detail answer narrows to price_from. Pinduoduo cards built by the shared card path for search,
// feed, pool, rank, parse, tlj_pool and Agent stay spec_uncertain (their price is not the union
// detail answer); the B1-05zh kit (read only) builds them, the detail use case builds the detail.
import { expect, it } from 'vitest';
import { assembler, refOf, requestOf } from '../price-spec-hint/kit.ts';
import { PDD_KEY, expectHint, pddFixture } from './kit.ts';

it.each([
  { scene: '搜索（search）', entrySource: 'search', source: 'search', stale: false },
  { scene: '首页物料（feed，池行）', entrySource: 'feed', source: 'pool', stale: false },
  { scene: '商品池回退（pool，stale）', entrySource: 'pool', source: 'pool', stale: true },
  { scene: '热销榜（rank）', entrySource: 'rank', source: 'search', stale: false },
  { scene: '粘贴识别（parse）', entrySource: 'parse', source: 'parse', stale: false },
  { scene: '淘礼金池（tlj_pool）', entrySource: 'tlj_pool', source: 'pool', stale: false },
  { scene: 'Agent 检索（agent）', entrySource: 'agent', source: 'search', stale: false },
] as const)(
  '[AC-B1-04zzn#19][BR-PROD-04] 拼多多 $scene 卡仍 spec_uncertain；同一商品的联盟详情才是 price_from',
  async ({ entrySource, source, stale }) => {
    const list = assembler();
    const prepared = await list.service.prepare(
      requestOf('pdd', { entrySource, stale, ref: refOf('pdd', { source }) }),
    );
    expectHint(prepared.card, 'spec_uncertain');
    expectHint(await prepared.commit(), 'spec_uncertain');

    const detail = await pddFixture().getPdd();
    expect(detail.product_key).toBe(PDD_KEY);
    expectHint(detail, 'price_from');
  },
);
