import { expect, it } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { JdUnionAdapter } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import type { UnionTransportResponse } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { expectRedacted, unionFailure } from '../jd-core/kit.ts';
import * as convert from '../jd-convert/kit.ts';
import * as goods from '../jd-goods/kit.ts';
import * as orders from '../jd-orders/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzc#n]) name this task's acceptance points, not business rules.
// D10-1073：京东各端口经真实适配器——商品三端口（goods.query）与 sku 模式的 jingfen 链接遇内层 403、转链遇
// 403 / 2001403 / 2001602、订单遇 403 / 2002403 → upstream_misconfigured，只发 1 次请求，恰好告警一次
// { method, code }；各接口细分表里的其他码不变。报文全部合成。

const UPSTREAM = 'cc-jd-upstream-text';
const UPSTREAM_REQUEST = 'cc-jd-upstream-request';
const KEYWORD = 'cc-jd-keyword-marker';
const LINK = 'https://u.jd.com/cc-link-marker';
const JINGFEN = `https://jingfen.jd.com/detail/${goods.wholeItemId}.html`;

type Form = 'number' | 'string';
const FORMS: readonly Form[] = ['number', 'string'];

/** The code as a JSON number literal or as the same text in a JSON string. */
function wireCode(code: string, form: Form): unknown {
  return form === 'number' ? orders.num(code) : code;
}

/** A goods.query answer: outer "0", inner `code` with upstream text and a request id. */
function goodsFailure(code: string, form: Form): UnionTransportResponse {
  return goods.reply(
    orders.jsonText({ code: wireCode(code, form), message: UPSTREAM, requestId: UPSTREAM_REQUEST }),
  );
}

function call(adapter: JdUnionAdapter, port: goods.Port): Promise<unknown> {
  if (port === 'search') return adapter.searchItems({ keyword: KEYWORD }, goods.ctx);
  if (port === 'detail') return adapter.getItem(goods.itemRef, goods.ctx);
  return adapter.resolveLink(LINK, goods.ctx);
}

const portForms = goods.ports.flatMap((port) => FORMS.map((form) => [port, form] as const));

it.each(portForms)(
  '[AC-B1-04zzzzc#6] 京东 %s 遇内层 403（%s写法）→ upstream_misconfigured，只发 1 次请求，恰好告警一次 { method: goods.query, code: "403" }，错误与告警不带关键词、链接、商品号与上游文案',
  async (port, form) => {
    const h = goods.wire(() => goodsFailure('403', form));
    const error = await unionFailure(() => call(h.adapter, port), 'upstream_misconfigured');
    expect(h.requests).toHaveLength(1);
    expect(h.warn.mock.calls).toEqual([[{ method: goods.method, code: '403' }]]);
    expectRedacted(
      [error, h.warn.mock.calls],
      [KEYWORD, 'cc-link-marker', goods.wholeItemId, UPSTREAM, UPSTREAM_REQUEST],
    );
  },
);

it.each(FORMS)(
  '[AC-B1-04zzzzc#7] sku 模式的 jingfen 链接走 goods.query 遇内层 403（%s写法）→ upstream_misconfigured：上游失败不算取不到，只发 1 次请求、告警一次；item 模式仍直接得 itemId 不调上游',
  async (form) => {
    const h = goods.wire(() => goodsFailure('403', form), goods.mode('sku'));
    const error = await unionFailure(
      () => h.adapter.resolveLink(JINGFEN, goods.ctx),
      'upstream_misconfigured',
    );
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ keyword: JINGFEN, sceneId: 1 });
    expect(h.warn.mock.calls).toEqual([[{ method: goods.method, code: '403' }]]);
    expectRedacted(error, [goods.wholeItemId, UPSTREAM]);

    const item = goods.wire(() => goodsFailure('403', form), goods.mode('item'));
    expect((await item.adapter.resolveLink(JINGFEN, goods.ctx)).item).toMatchObject({
      platform: 'jd',
      item_id: goods.wholeItemId,
    });
    expect(item.transport).not.toHaveBeenCalled();
  },
);

/** Each goods port's own table, unchanged; 'empty' is search's empty page. */
const PORT_TABLES: Readonly<
  Record<goods.Port, readonly (readonly [string, UnionErrorCode | 'empty'])[]>
> = {
  search: [
    ['429', 'rate_limited'],
    ['410', 'link_unrecognized'],
    ['411', 'link_unrecognized'],
    ['201', 'empty'],
    ['999', 'upstream_rejected'],
  ],
  detail: [
    ['429', 'rate_limited'],
    ['410', 'link_unrecognized'],
    ['201', 'item_unavailable'],
    ['999', 'upstream_rejected'],
  ],
  link: [
    ['429', 'rate_limited'],
    ['410', 'link_unrecognized'],
    ['201', 'link_unrecognized'],
    ['999', 'upstream_rejected'],
  ],
};

it.each(goods.ports)(
  '[AC-B1-04zzzzc#8] 京东 %s 的细分表里没有 403：403 是新码并告警；表里的 429 / 410 / 411 / 201 与表外码照旧、不告警',
  async (port) => {
    for (const form of FORMS) {
      const h = goods.wire(() => goodsFailure('403', form));
      await unionFailure(() => call(h.adapter, port), 'upstream_misconfigured');
      expect(h.warn).toHaveBeenCalledTimes(1);
    }
    for (const [code, expected] of PORT_TABLES[port]) {
      for (const form of FORMS) {
        const h = goods.wire(() => goodsFailure(code, form));
        if (expected === 'empty') {
          expect(await call(h.adapter, port)).toEqual({ items: [], nextCursor: null });
        } else {
          await unionFailure(() => call(h.adapter, port), expected);
        }
        expect(h.requests).toHaveLength(1);
        expect(h.warn).not.toHaveBeenCalled();
      }
    }
  },
);

const convertMarkers = [convert.subUnionId, convert.clickUrl, convert.itemId, convert.upstreamText];
const convertForms = ['403', '2001403', '2001602'].flatMap((code) =>
  FORMS.map((form) => [code, form] as const),
);

it.each(convertForms)(
  '[AC-B1-04zzzzc#9] 转链（promotion.common.get）遇内层 %s（%s写法）→ upstream_misconfigured，只发 1 次，恰好告警一次 { method, code }，错误与告警不带 subUnionId / clickURL / itemId / 上游文案',
  async (code, form) => {
    const h = convert.wire(convert.reply(convert.failure(wireCode(code, form))));
    const error = await unionFailure(
      () => h.adapter.convert(convert.req, convert.identity, convert.ctx),
      'upstream_misconfigured',
    );
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls).toEqual([[{ method: convert.method, code }]]);
    expectRedacted([error, h.warn.mock.calls], convertMarkers);
  },
);

it('[AC-B1-04zzzzc#10] 转链其余码不变：2001701 / 2001603 仍 upstream_rejected 且告警一次；2001104 → item_unavailable、2001707 → link_unrecognized、2001609 → upstream_unavailable、429 → rate_limited、表外码 upstream_rejected，都不告警', async () => {
  for (const form of FORMS) {
    const h = convert.wire(convert.reply(convert.failure(wireCode('2001403', form))));
    await unionFailure(
      () => h.adapter.convert(convert.req, convert.identity, convert.ctx),
      'upstream_misconfigured',
    );
  }
  for (const code of ['2001701', '2001603']) {
    for (const form of FORMS) {
      const h = convert.wire(convert.reply(convert.failure(wireCode(code, form))));
      await unionFailure(
        () => h.adapter.convert(convert.req, convert.identity, convert.ctx),
        'upstream_rejected',
      );
      expect(h.transport).toHaveBeenCalledTimes(1);
      expect(h.warn.mock.calls).toEqual([[{ method: convert.method, code }]]);
    }
  }
  const unchanged: readonly (readonly [string, UnionErrorCode])[] = [
    ['2001104', 'item_unavailable'],
    ['2001707', 'link_unrecognized'],
    ['2001609', 'upstream_unavailable'],
    ['429', 'rate_limited'],
    ['2001999', 'upstream_rejected'],
  ];
  for (const [code, expected] of unchanged) {
    for (const form of FORMS) {
      const h = convert.wire(convert.reply(convert.failure(wireCode(code, form))));
      await unionFailure(
        () => h.adapter.convert(convert.req, convert.identity, convert.ctx),
        expected,
      );
      expect(h.transport).toHaveBeenCalledTimes(1);
      expect(h.warn).not.toHaveBeenCalled();
    }
  }
});

const orderForms = ['403', '2002403'].flatMap((code) => FORMS.map((form) => [code, form] as const));

it.each(orderForms)(
  '[AC-B1-04zzzzc#11] 订单（order.row.query）遇内层 %s（%s写法）→ upstream_misconfigured，windowTooLarge 为 false，只发 1 次，恰好告警一次 { method, code }；2002452 仍 upstream_rejected 带 windowTooLarge、不告警',
  async (code, form) => {
    const h = orders.wire(() => orders.reply(orders.inner([], false, wireCode(code, form))));
    const error = await unionFailure(
      () => h.adapter.listOrders(orders.win, {}, orders.ctx),
      'upstream_misconfigured',
    );
    expect(error.windowTooLarge).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(h.warn.mock.calls).toEqual([[{ method: orders.method, code }]]);

    const wide = orders.wire(() =>
      orders.reply(orders.inner([], false, wireCode('2002452', form))),
    );
    const refused = await unionFailure(
      () => wide.adapter.listOrders(orders.win, {}, orders.ctx),
      'upstream_rejected',
    );
    expect(refused.windowTooLarge).toBe(true);
    expect(wide.warn).not.toHaveBeenCalled();
  },
);
