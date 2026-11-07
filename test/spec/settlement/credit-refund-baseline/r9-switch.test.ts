// B1-08zi（D10-814 ⑥）：京东「已退件数大于入账定格」驱动 R9 挂开关 orders.jd.refunded_quantity_r9_enabled，
// 默认关。关：不作为 R9 触发、不动钱，只写告警（alert_only，其余判定照常）；开：照现行 R9。其他平台不挂开关，
// 增加照旧 R9。增加的口径是 (refunded_quantity ?? 0) > (refunded_quantity_at_credit ?? 0)。
// 开关登记在 content 的配置项注册表：boolean、config.business。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { configItemSpecOf } from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  jdRefundR9Enabled,
  refundQuantityRoute,
  type RefundQuantityFacts,
  type RefundQuantityRoute,
} from '../../../../apps/api/src/modules/settlement/clawback/clawback-order.ts';

const SWITCH = 'orders.jd.refunded_quantity_r9_enabled';

function facts(
  platform: string,
  refunded: number | null,
  atCredit: number | null,
): RefundQuantityFacts {
  return { platform, refunded_quantity: refunded, refunded_quantity_at_credit: atCredit };
}

type RouteCase = readonly [string, RefundQuantityFacts, RefundQuantityRoute, RefundQuantityRoute];

/** [name, facts, route with the switch off, route with the switch on]. */
const ROUTES: readonly RouteCase[] = [
  ['京东 2 > 1', facts('jd', 2, 1), 'alert_only', 'r9'],
  ['京东定格为空、已退 1', facts('jd', 1, null), 'alert_only', 'r9'],
  ['京东相等', facts('jd', 1, 1), 'none', 'none'],
  ['京东已退为空', facts('jd', null, 0), 'none', 'none'],
  ['京东两列为空', facts('jd', null, null), 'none', 'none'],
  ['京东已退小于定格', facts('jd', 1, 2), 'none', 'none'],
  ['拼多多 1 > 0（不挂开关）', facts('pdd', 1, 0), 'r9', 'r9'],
  ['淘宝 3 > 1（不挂开关）', facts('taobao', 3, 1), 'r9', 'r9'],
  ['拼多多相等', facts('pdd', 0, 0), 'none', 'none'],
];

it.each(ROUTES)('[AC-B1-08zi#24] %s：开关关 → %s，开关开 → %s', (_name, order, off, on) => {
  expect(refundQuantityRoute(order, false)).toBe(off);
  expect(refundQuantityRoute(order, true)).toBe(on);
});

it('[AC-B1-08zi#25] 任意件数：none 恰在未增加时；京东开关关从不 r9；非京东从不 alert_only', () => {
  const count = fc.option(fc.integer({ min: 0, max: 20 }), { nil: null });
  const platform = fc.constantFrom('jd', 'pdd', 'taobao', 'meituan');
  expect(() =>
    fc.assert(
      fc.property(platform, count, count, fc.boolean(), (code, refunded, atCredit, enabled) => {
        const route = refundQuantityRoute(facts(code, refunded, atCredit), enabled);
        const increased = (refunded ?? 0) > (atCredit ?? 0);
        let expected: RefundQuantityRoute = 'none';
        if (increased) expected = code !== 'jd' || enabled ? 'r9' : 'alert_only';
        expect(route).toBe(expected);
        return true;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

it('[AC-B1-08zi#26] 开关读值：只有 JSON true 为开；未设置与其他值都是关（默认关）', () => {
  expect(jdRefundR9Enabled(true)).toBe(true);
  const offValues: readonly unknown[] = [undefined, null, false, 0, 1, '', 'false', 'off', {}, []];
  for (const value of offValues) {
    expect(jdRefundR9Enabled(value)).toBe(false);
  }
});

it('[AC-B1-08zi#27] 开关登记为配置项：boolean、config.business', () => {
  expect(configItemSpecOf(SWITCH)).toMatchObject({
    key: SWITCH,
    valueType: 'boolean',
    permission: 'config.business',
    options: null,
  });
  // 未设置即关：注册表不带默认值，读值一侧把未设置当关。
  expect(jdRefundR9Enabled(undefined)).toBe(false);
});
