// B1-04zzh（D10-692 S1-B）：读不出推广位 ≠ 别家推广位。adzone_id 缺失、非法（非正整数 / 非十进制数字串）
// 或整行不是对象的订单行是坏行：collect 下进 rejected（detail 点名 adzone_id，不带取值），不计入
// taobao_order_foreign_slot，也不静默丢弃；合法 adzone_id 而不属我方的行照旧丢弃并计数（冻结的
// AC-B1-04f#36 钉着，这里只在同页对照）。一页 ≥1 行且全部读不出推广位 → listOrders 抛
// upstream_unavailable（格式变化），不返回空页，水位不动。
import { expect, it } from 'vitest';
import { FOREIGN_ADZONE, num, OUR_ADZONE, rejection, win } from '../taobao-orders/kit.ts';
import {
  COLLECT,
  fieldNamed,
  foreignCounts,
  good,
  guarded,
  idOf,
  MODES,
  PLAIN,
  rejectedOf,
  resolvedPage,
  warned,
} from './guard-kit.ts';

/** A value that must never reach `detail` or a warning. */
const BAD_ADZONE = 'sg-not-an-adzone-31415';

/** adzone_id values that say nothing about whose order it is; undefined leaves the key out. */
const UNREADABLE: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: '缺失', value: undefined },
  { label: 'JSON null', value: null },
  { label: '「--」', value: '--' },
  { label: '空串', value: '' },
  { label: '非数字串', value: BAD_ADZONE },
  { label: '小数', value: num(`${OUR_ADZONE}.5`) },
  { label: '负数', value: num(`-${OUR_ADZONE}`) },
  { label: '零（非正整数）', value: num('0') },
  { label: '带空格的数字串', value: ` ${OUR_ADZONE}` },
  { label: '对象', value: { id: num(OUR_ADZONE) } },
  { label: '布尔', value: true },
];

function unreadable(index: number, value: unknown): Record<string, unknown> {
  return { ...good(index), adzone_id: value };
}

it.each(UNREADABLE)(
  '[AC-B1-04zzh#1] collect：adzone_id $label → 该行进 rejected（detail 点名 adzone_id、不带取值），不计入 taobao_order_foreign_slot，同页好行照常',
  async ({ value }) => {
    const s = guarded([good(1), unreadable(2, value), good(3)], { payloadId: '80101' });
    const page = await resolvedPage(() => s.adapter.listOrders(win, {}, COLLECT));
    expect(page.items.map((order) => order.sub_order_id)).toEqual([idOf(1), idOf(3)]);
    const rejected = rejectedOf(page);
    expect(rejected).toEqual([
      expect.objectContaining({
        sub_order_id: idOf(2),
        raw_status: '3',
        raw_payload_id: '80101',
        detail: expect.stringMatching(fieldNamed('adzone_id')),
      }),
    ]);
    for (const secret of [BAD_ADZONE, OUR_ADZONE, '88.80', '7.99']) {
      expect(rejected[0]!.detail).not.toContain(secret);
    }
    expect(foreignCounts(s.orderWarn)).toEqual([]);
  },
);

it('[AC-B1-04zzh#1] collect：别家推广位、读不出推广位、非对象行同页：只有别家的行计入 foreign（count 1），读不出的两行都进 rejected', async () => {
  const foreign = { ...good(2), adzone_id: num(FOREIGN_ADZONE) };
  const s = guarded([good(1), foreign, unreadable(3, undefined), 'sg-not-an-order-row', good(5)], {
    payloadId: '80102',
  });
  const page = await resolvedPage(() => s.adapter.listOrders(win, {}, COLLECT));
  expect(page.items.map((order) => order.sub_order_id)).toEqual([idOf(1), idOf(5)]);
  expect(foreignCounts(s.orderWarn)).toEqual([1]);
  const rejected = rejectedOf(page);
  expect(rejected).toHaveLength(2);
  expect(rejected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sub_order_id: idOf(3),
        raw_payload_id: '80102',
        detail: expect.stringMatching(fieldNamed('adzone_id')),
      }),
      expect.objectContaining({ sub_order_id: null, raw_status: null, raw_payload_id: '80102' }),
    ]),
  );
  // 别家的行不是我们的坏行：不进 rejected。
  expect(rejected.map((row) => row.sub_order_id)).not.toContain(idOf(2));
});

const NOT_OBJECTS: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: '字符串', value: 'sg-not-an-order-row' },
  { label: 'JSON 数字', value: num('7') },
  { label: 'JSON null', value: null },
  { label: '数组', value: [num(OUR_ADZONE)] },
];

it.each(NOT_OBJECTS)(
  '[AC-B1-04zzh#1] collect：整行是$label → 进 rejected（单号、状态为 null），不计入 taobao_order_foreign_slot',
  async ({ value }) => {
    const s = guarded([good(1), value, good(3)], { payloadId: '80103' });
    const page = await resolvedPage(() => s.adapter.listOrders(win, {}, COLLECT));
    expect(page.items.map((order) => order.sub_order_id)).toEqual([idOf(1), idOf(3)]);
    expect(rejectedOf(page)).toEqual([
      expect.objectContaining({
        sub_order_id: null,
        raw_status: null,
        raw_payload_id: '80103',
        detail: expect.any(String),
      }),
    ]);
    expect(foreignCounts(s.orderWarn)).toEqual([]);
  },
);

it.each(UNREADABLE)(
  '[AC-B1-04zzh#1] 不开 collect：adzone_id $label → 该行不返回，但不计入 taobao_order_foreign_slot，另有点名 adzone_id 的告警（不静默丢弃）',
  async ({ value }) => {
    const foreign = { ...good(3), adzone_id: num(FOREIGN_ADZONE) };
    const s = guarded([good(1), unreadable(2, value), foreign, good(4)]);
    const page = await resolvedPage(() => s.adapter.listOrders(win, {}, PLAIN));
    expect(page.items.map((order) => order.sub_order_id)).toEqual([idOf(1), idOf(4)]);
    expect(foreignCounts(s.orderWarn)).toEqual([1]);
    const named = warned(s.orderWarn).filter(
      (event) => event.event !== 'taobao_order_foreign_slot' && event.field === 'adzone_id',
    );
    expect(named.length).toBeGreaterThan(0);
  },
);

interface WholePage {
  readonly label: string;
  readonly rows: readonly unknown[];
}

const WHOLE_PAGES: readonly WholePage[] = [
  { label: '唯一一行缺 adzone_id', rows: [unreadable(1, undefined)] },
  { label: '两行都非法', rows: [unreadable(1, BAD_ADZONE), unreadable(2, num('0'))] },
  {
    label: '缺失、非法、非对象混合',
    rows: [unreadable(1, null), 'sg-not-an-order-row', unreadable(3, num(`${OUR_ADZONE}.5`))],
  },
  {
    label: '六行（≥5）全部缺 adzone_id',
    rows: [1, 2, 3, 4, 5, 6].map((index) => unreadable(index, undefined)),
  },
];

const WHOLE_PAGE_CASES = MODES.flatMap(({ mode, call }) =>
  WHOLE_PAGES.map((page) => ({ mode, call, ...page })),
);

it.each(WHOLE_PAGE_CASES)(
  '[AC-B1-04zzh#2] $mode：整页（$label）都读不出推广位 → upstream_unavailable，不返回空页、不给下一页游标',
  async ({ call, rows }) => {
    const s = guarded(rows, { payloadId: '80201', more: true });
    await rejection(() => s.adapter.listOrders(win, {}, call), 'upstream_unavailable');
    expect(s.transport).toHaveBeenCalledTimes(1);
    expect(foreignCounts(s.orderWarn)).toEqual([]);
  },
);
