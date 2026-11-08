import { expect, it, vi } from 'vitest';
import { getProduct, upstreamFailure } from '../../../../apps/api/src/modules/catalog/detail.ts';
import { createUnionDetailUpstream } from '../../../../apps/api/src/modules/catalog/infra/detail-wiring.ts';
import {
  createParsing,
  ParsingError,
  parseUrl,
} from '../../../../apps/api/src/modules/parsing/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionAdapter,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { PRODUCT_KEY, fixture as detailFixture, productRef } from '../../catalog/detail/kit.ts';
import { CTX, URL_A, fixture as parsingFixture } from '../../parsing/core/kit.ts';
import { DETAIL } from '../taobao-goods/kit.ts';
import { govern, live, outcome, PERMISSION_SUB_CODE, topFailure, topOk } from './cred-kit.ts';

// 编排者补充第 10 条（D10-967 ③）：catalog 商品详情与 parsing 各一行映射。两个新码按 BR-PROD-05 结果分类③
// 暂时失败：详情回 50401（不出 30143 ref_expired、不按 30141 下架、不写 product_refs）；解析回现有暂时码
// 50301（不落成 50001 未知错误、不写 parse_hit_failed 告警）。各一条经真实模块装配：catalog 的 getProduct +
// createUnionDetailUpstream、parsing 的 createParsing / parseUrl，联盟一侧是治理后的真实淘宝适配器（TOP 答
// code 11）；TOP 给不出的 site_auth_invalid 由治理后的合成适配器抛出。

const SITE_AUTH = (): UnionError =>
  new UnionError('site_auth_invalid', 'synthetic site authorisation refused', 'taobao');

/** The live Taobao adapter whose TOP detail answers code 11 (no API permission). */
function permissionRefusedTaobao() {
  return live({
    top: (method) => (method === DETAIL ? topFailure(11, PERMISSION_SUB_CODE) : topOk(method)),
  });
}

/** A governed synthetic Taobao adapter whose getItem throws `error`. */
function refusingAdapter(error: () => UnionError) {
  const getItem = vi.fn<UnionAdapter['getItem']>(async () => {
    throw error();
  });
  const raw: UnionAdapter = {
    platform: 'taobao',
    getItem,
    searchItems: vi.fn<UnionAdapter['searchItems']>(),
    resolveLink: vi.fn<UnionAdapter['resolveLink']>(),
    convert: vi.fn<UnionAdapter['convert']>(),
    listOrders: vi.fn<UnionAdapter['listOrders']>(),
  };
  return { adapter: govern(raw).adapter, getItem };
}

it('[AC-B1-04zzzx#15] catalog 商品详情：联盟两新码按暂时失败回 50401，不出 30143 ref_expired、不按 30141 下架、不写 product_refs、不报价', async () => {
  const h = permissionRefusedTaobao();
  const governed = govern(h.adapter).adapter;
  const f = detailFixture();
  f.readProductRef.mockResolvedValue(productRef());
  const tbFailure = await outcome(() =>
    getProduct(
      { product_key: PRODUCT_KEY },
      { ...f.options, upstream: createUnionDetailUpstream({ union: { adapter: () => governed } }) },
    ),
  );
  expect(h.topTransport).toHaveBeenCalledTimes(1);
  expect(h.warn).toHaveBeenCalledTimes(1);
  expect(f.registerProductRef).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.rows).toEqual([]);
  expect(tbFailure).not.toMatchObject({ code: 30143 });
  expect(tbFailure).not.toMatchObject({ code: 30141 });
  expect(tbFailure).toMatchObject({ code: 50401 });

  const s = refusingAdapter(SITE_AUTH);
  const g = detailFixture();
  g.readProductRef.mockResolvedValue(productRef());
  const siteUpstream = createUnionDetailUpstream({ union: { adapter: () => s.adapter } });
  const siteFailure = await outcome(() =>
    getProduct({ product_key: PRODUCT_KEY }, { ...g.options, upstream: siteUpstream }),
  );
  expect(s.getItem).toHaveBeenCalledTimes(1);
  expect(g.registerProductRef).not.toHaveBeenCalled();
  expect(g.quote).not.toHaveBeenCalled();
  expect(siteFailure).toMatchObject({ code: 50401 });

  // The one mapping the detail route and the pool's re-check share.
  for (const code of ['upstream_misconfigured', 'site_auth_invalid'] as const) {
    expect(upstreamFailure(new UnionError(code, 'synthetic refusal', 'taobao'))).toMatchObject({
      code: 50401,
    });
  }
});

it('[AC-B1-04zzzx#16] parsing：详情遇两新码按暂时失败回 50301，不落成 50001 未知错误、不写 parse_hit_failed；parseUrl 同口径', async () => {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );

  const h = permissionRefusedTaobao();
  const f = parsingFixture();
  f.getItem.mockImplementation((ref, context) => h.adapter.getItem(ref, context));
  const tbResults = await createParsing({ ...f.options, logger }).parseInput(URL_A, CTX);
  expect(h.topTransport).toHaveBeenCalledTimes(1);
  expect(h.warn).toHaveBeenCalledTimes(1);
  expect(f.assemble).not.toHaveBeenCalled();
  expect(tbResults).toHaveLength(1);

  const s = parsingFixture();
  s.getItem.mockRejectedValue(SITE_AUTH());
  const siteResults = await createParsing({ ...s.options, logger }).parseInput(URL_A, CTX);
  expect(s.getItem).toHaveBeenCalledTimes(1);
  expect(siteResults).toHaveLength(1);

  const u = parsingFixture();
  u.getItem.mockRejectedValue(SITE_AUTH());
  const rejected = await outcome(() => parseUrl(u.options, URL_A, CTX));

  const codes: unknown[] = [tbResults[0], siteResults[0]].map((result) =>
    result?.kind === 'error' ? result.error_code : result?.kind,
  );
  expect(codes).not.toContain(50001);
  expect(lines.join('\n')).not.toContain('parse_hit_failed');
  expect(codes).toEqual([50301, 50301]);
  expect(rejected).toBeInstanceOf(ParsingError);
  expect(rejected).toMatchObject({ code: 50301 });
});

it('[AC-B1-04zzzx#17] 映射之外不变：catalog 仍把 upstream_rejected 记 30143、upstream_unavailable 记 50401；parsing 仍把 upstream_rejected 记 30132、rate_limited 记 50301；两新码各得暂时码', async () => {
  const unchanged: [UnionErrorCode, number, number][] = [
    ['upstream_rejected', 30143, 30132],
    ['upstream_unavailable', 50401, 50301],
    ['rate_limited', 50401, 50301],
    ['item_unavailable', 30141, 30141],
  ];
  const refined: [UnionErrorCode, number, number][] = [
    ['upstream_misconfigured', 50401, 50301],
    ['site_auth_invalid', 50401, 50301],
  ];
  // The parse mapping alone, without the governor: the parsing kit's governor waits on a manual
  // scheduler, so a retried code (upstream_unavailable / rate_limited) would never settle there.
  // Retries and the breaker are covered in governance.test.ts.
  async function parseCodeOf(code: UnionErrorCode): Promise<unknown> {
    const p = parsingFixture();
    p.getItem.mockRejectedValue(new UnionError(code, 'synthetic', 'taobao'));
    const direct: Pick<UnionAdapter, 'resolveLink' | 'getItem'> = {
      resolveLink: p.resolveLink,
      getItem: p.getItem,
    };
    const results = await createParsing({
      ...p.options,
      getGovernedAdapter: () => direct,
    }).parseInput(URL_A, CTX);
    expect(p.getItem).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    const [result] = results;
    return result?.kind === 'error' ? result.error_code : result?.kind;
  }

  // The two new codes first: each gets the temporary code on both sides.
  for (const [code, detailCode, parseCode] of refined) {
    expect(upstreamFailure(new UnionError(code, 'synthetic', 'taobao'))).toMatchObject({
      code: detailCode,
    });
    expect(await parseCodeOf(code)).toBe(parseCode);
  }
  // Everything outside the mapping keeps its code.
  for (const [code, detailCode, parseCode] of unchanged) {
    expect(upstreamFailure(new UnionError(code, 'synthetic', 'taobao'))).toMatchObject({
      code: detailCode,
    });
    expect(await parseCodeOf(code)).toBe(parseCode);
  }
});
