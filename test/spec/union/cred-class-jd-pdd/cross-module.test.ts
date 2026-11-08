import { expect, it } from 'vitest';
import { createPoolSource } from '../../../../apps/api/src/modules/catalog/application/pool-source.ts';
import { getProduct } from '../../../../apps/api/src/modules/catalog/detail.ts';
import type { PlatformRecord } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import { createUnionDetailUpstream } from '../../../../apps/api/src/modules/catalog/infra/detail-wiring.ts';
import {
  createParsing,
  ParsingError,
  parseUrl,
} from '../../../../apps/api/src/modules/parsing/index.ts';
import { createRootLogger, FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { NOW, fixture as detailFixture, productRef } from '../../catalog/detail/kit.ts';
import { CTX, URL_C, fixture as parsingFixture } from '../../parsing/core/kit.ts';
import { outcome, scheduler } from '../cred-class/cred-kit.ts';
import * as jdGoods from '../jd-goods/kit.ts';
import { govern as governJd, jsonText, num } from '../jd-orders/kit.ts';
import { endpoint as pddEndpoint } from '../pdd-core/kit.ts';
import * as pddGoods from '../pdd-goods/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzc#n]) name this task's acceptance points, not business rules.
// D10-1073 / 编排者补充第 7 点：跨模块各一条，经真实装配。新码按 BR-PROD-05 结果分类③暂时失败：
// 京东详情遇内层 403 → 50401，不出 30143 ref_expired、不按 30141 下架；商品池入库 / 复核同一映射，抛 50401、
// 不判下架也不判引用失效。拼多多解析遇 20031 → 暂时码 50301，不是 50001，也不是 30131 / 30132。
// 联盟一侧是治理后的真实京东 / 拼多多适配器，传输是内存替身；值全部合成。

/** BR-PROD-03, item mode: jd:i_<second segment of the union itemId>. */
const JD_KEY = 'jd:i_Bseg';

/** The governed live JD adapter whose goods.query answers inner 403 (number or string form). */
function permissionRefusedJd(code: unknown = num('403')) {
  const h = jdGoods.wire(() =>
    jdGoods.reply(jsonText({ code, message: 'cc-jd-text', requestId: 'cc-jd-request' })),
  );
  return { ...h, governed: governJd(h.adapter, () => true) };
}

it.each([
  ['数字', num('403')],
  ['字符串', '403'],
] as const)(
  '[AC-B1-04zzzzc#21] catalog 商品详情：京东详情遇内层 403（%s写法）→ 50401，不出 30143 ref_expired、不按 30141 下架、不写 product_refs、不报价，只发 1 次请求、告警一次',
  async (_form, code) => {
    const h = permissionRefusedJd(code);
    const f = detailFixture();
    f.readProductRef.mockResolvedValue(
      productRef({ platform: 'jd', productKey: JD_KEY, rawItemId: jdGoods.wholeItemId }),
    );
    const failure = await outcome(() =>
      getProduct(
        { product_key: JD_KEY },
        {
          ...f.options,
          upstream: createUnionDetailUpstream({ union: { adapter: () => h.governed } }),
        },
      ),
    );
    expect(failure).not.toMatchObject({ code: 30143 });
    expect(failure).not.toMatchObject({ code: 30141 });
    expect(failure).toMatchObject({ code: 50401 });
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.requests[0]).toMatchObject({ itemIds: [jdGoods.wholeItemId] });
    expect(h.warn.mock.calls).toEqual([[{ method: jdGoods.method, code: '403' }]]);
    expect(f.registerProductRef).not.toHaveBeenCalled();
    expect(f.quote).not.toHaveBeenCalled();
    expect(f.rows).toEqual([]);
  },
);

const PLATFORMS: readonly PlatformRecord[] = (['taobao', 'jd', 'pdd'] as const).map((code) => ({
  code,
  key_prefix: code === 'taobao' ? 'tb' : code,
  key_stability: 'unverified',
  search_support: 'supported',
  convert_support: 'supported',
  order_sync_support: 'supported',
  stage: 'M',
}));
const APP_ID = 'cc-pool-app';
const TITLE = '合成京东商品';

/** createPoolSource as the admin route builds it, over in-memory catalog reads and the JD adapter. */
function poolSource(governed: ReturnType<typeof governJd>) {
  const union = { adapter: () => governed };
  return createPoolSource({
    clock: new FixedClock(NOW),
    config: { configValue: async () => null },
    catalog: {
      listPlatforms: async () => PLATFORMS,
      resolveProductKey: async (key) => key,
      readProductRef: async () => null,
      takeRawItemId: async () => ({ rawItemId: jdGoods.wholeItemId, source: 'link' as const }),
    },
    itemRefs: {
      read: (_itemRef, appId) => ({
        appId,
        platform: 'jd',
        productKey: JD_KEY,
        rawItemId: jdGoods.wholeItemId,
        fetchedAt: NOW,
        source: 'item_ref',
      }),
    },
    union,
    upstream: createUnionDetailUpstream({ union }),
    links: {
      candidates: () => [],
      parse: () => Promise.reject(new Error('cred-class-jd-pdd: no link is parsed here')),
    },
  });
}

it('[AC-B1-04zzzzc#22] 商品池：复核与按 item_ref 入库遇京东内层 403 → 抛 50401（暂时查不到），不判下架（off_shelf）也不判引用失效（not_passed / ref_expired），各只发 1 次请求', async () => {
  const runs = [
    (source: ReturnType<typeof poolSource>) =>
      source.recheck({
        appId: APP_ID,
        platform: 'jd',
        productKey: JD_KEY,
        rawItemId: jdGoods.wholeItemId,
        fetchedAt: NOW,
        title: TITLE,
      }),
    (source: ReturnType<typeof poolSource>) => source.fromItemRef(APP_ID, 'cc-synthetic-item-ref'),
  ];
  for (const run of runs) {
    const h = permissionRefusedJd();
    const result = await outcome(() => run(poolSource(h.governed)));
    expect(result).not.toMatchObject({ kind: 'off_shelf' });
    expect(result).not.toMatchObject({ kind: 'not_passed' });
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ code: 50401 });
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls).toEqual([[{ method: jdGoods.method, code: '403' }]]);
  }
});

/** The governed live PDD adapter: goods.search finds nothing, url.short.parse answers `code`. */
function shortParseRefusedPdd(code: number | string) {
  const h = pddGoods.setup((body) =>
    body.type === pddGoods.shortParse
      ? { error_response: { error_code: code } }
      : pddGoods.envelope(body.type, []),
  );
  const governed = createGovernedAdapter(h.adapter, {
    endpoint: pddEndpoint,
    scheduler,
    quota: { bucketKey: pddEndpoint.quotaKey, tryAcquire: () => true },
  });
  return { ...h, governed };
}

it.each([20031, '20031'])(
  '[AC-B1-04zzzzc#23] parsing：拼多多链接解析遇短链展开 %j → 暂时码 50301，不落成 50001、不是 30131 / 30132，不写 parse_hit_failed；parseUrl 同口径',
  async (code) => {
    const lines: string[] = [];
    const logger = createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    );

    const h = shortParseRefusedPdd(code);
    const p = parsingFixture();
    const results = await createParsing({
      ...p.options,
      logger,
      getGovernedAdapter: () => h.governed,
    }).parseInput(URL_C, CTX);
    expect(results).toHaveLength(1);
    const [result] = results;
    const parsed = result?.kind === 'error' ? result.error_code : result?.kind;
    expect(parsed).not.toBe(50001);
    expect(parsed).not.toBe(30131);
    expect(parsed).not.toBe(30132);
    expect(parsed).toBe(50301);
    expect(h.requests.map((body) => body.type)).toEqual([pddGoods.search, pddGoods.shortParse]);
    expect(h.warn.mock.calls).toEqual([[{ error_code: '20031', type: pddGoods.shortParse }]]);
    expect(p.assemble).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain('parse_hit_failed');

    const u = shortParseRefusedPdd(code);
    const q = parsingFixture();
    const rejected = await outcome(() =>
      parseUrl({ ...q.options, getGovernedAdapter: () => u.governed }, URL_C, CTX),
    );
    expect(rejected).toBeInstanceOf(ParsingError);
    expect(rejected).toMatchObject({ code: 50301 });
  },
);
