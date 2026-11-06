// B1-04zv（BR-CALC-03，D10-522 ⑤，D10-570）：CallCtx.rowErrors: 'collect' 下，逐行映射错误进
// Page.rejected，好行照常返回，nextCursor 与全好时相同。detail 只含字段名与原因，不含报文取值。
// 真实 jd、pdd、taobao 适配器 + 假传输，报文全部合成。
import { expect, it } from 'vitest';
import { govern, inner, reply as jdReply, wire } from '../jd-orders/kit.ts';
import {
  FOREIGN_ADZONE,
  num,
  pageData,
  reply as taobaoReply,
  row as taobaoRow,
  rowOf,
  setup as taobaoSetup,
  win as taobaoWin,
} from '../taobao-orders/kit.ts';
import { row as pddRow } from '../pdd-orders/kit.ts';
import { pdd, reply as pddReply } from '../orders-shape/kit.ts';
import {
  BAD_AMOUNT,
  fieldNamed,
  jdFinished,
  JD,
  PDD,
  rejectedOf,
  resolved,
  TAOBAO,
  WIRES,
  type Wire,
} from './wires.ts';

interface BrokenAmount {
  readonly label: string;
  readonly w: Wire;
  readonly field: string;
  readonly rawStatus: string;
  readonly row: (index: number) => Record<string, unknown>;
}

/** undefined leaves the field out of the fixture: a missing field, not a bad one. */
function amount(
  w: Wire,
  field: string,
  value: unknown,
  base: (index: number) => Record<string, unknown> = (index) => w.good(index),
  rawStatus: string = w.rawStatus,
): BrokenAmount {
  const wording = value === undefined ? '缺失' : '非数字';
  return {
    label: `${w.name} ${rawStatus} ${field} ${wording}`,
    w,
    field,
    rawStatus,
    row: (index) => ({ ...base(index), [field]: value }),
  };
}

// BR-CALC-03：字段缺失或非数字，不得按 0 处理。各平台读哪个佣金字段见 BR-CALC-03 细则的表；京东 17 读 actualFee。
const BROKEN_AMOUNTS: readonly BrokenAmount[] = [
  amount(JD, 'estimateFee', undefined),
  amount(JD, 'estimateFee', BAD_AMOUNT),
  amount(JD, 'actualFee', undefined, jdFinished, '17'),
  amount(JD, 'actualFee', BAD_AMOUNT, jdFinished, '17'),
  amount(PDD, 'promotion_amount', undefined),
  amount(PDD, 'promotion_amount', BAD_AMOUNT),
  amount(TAOBAO, 'pub_share_pre_fee', undefined),
  amount(TAOBAO, 'pub_share_pre_fee', BAD_AMOUNT),
];

it.each(WIRES)(
  '[AC-B1-04zv#1] $name：三行中间一行坏，collect 下 items 2、rejected 1，单号取到，nextCursor 不变，raw_payload_id 是这页的',
  async (w) => {
    const page = await resolved(() =>
      w
        .adapter([w.good(1), w.bad(2), w.good(3)], { payloadId: '70101', more: true })
        .listOrders(w.win, {}, w.collect),
    );
    expect(page.items.map((order) => order.sub_order_id)).toEqual([w.idOf(1), w.idOf(3)]);
    const rejected = rejectedOf(page);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      sub_order_id: w.idOf(2),
      raw_status: w.rawStatus,
      raw_payload_id: '70101',
    });
    expect(rejected[0]!.detail).toMatch(fieldNamed(w.brokenField));

    const clean = await resolved(() =>
      w
        .adapter([w.good(1), w.good(2), w.good(3)], { payloadId: '70102', more: true })
        .listOrders(w.win, {}, w.collect),
    );
    expect(clean.items).toHaveLength(3);
    expect(rejectedOf(clean)).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor).toBe(clean.nextCursor);
  },
);

it.each(WIRES)(
  '[AC-B1-04zv#1] $name：一页全坏，items 空、rejected 全部，nextCursor 仍与全好时相同',
  async (w) => {
    const rows = [w.bad(1), w.bad(2)];
    const page = await resolved(() =>
      w.adapter(rows, { payloadId: '70103', more: true }).listOrders(w.win, {}, w.collect),
    );
    expect(page.items).toEqual([]);
    expect(rejectedOf(page).map((row) => row.sub_order_id)).toEqual([w.idOf(1), w.idOf(2)]);
    const clean = await resolved(() =>
      w.adapter([w.good(1), w.good(2)], { more: true }).listOrders(w.win, {}, w.collect),
    );
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor).toBe(clean.nextCursor);
  },
);

it.each(BROKEN_AMOUNTS)(
  '[AC-B1-04zv#1] $label：collect 下进 rejected，不按 0 留在 items',
  async ({ w, field, rawStatus, row }) => {
    const page = await resolved(() =>
      w
        .adapter([w.good(1), row(2), w.good(3)], { payloadId: '70106' })
        .listOrders(w.win, {}, w.collect),
    );
    expect(page.items.map((order) => order.sub_order_id)).toEqual([w.idOf(1), w.idOf(3)]);
    const rejected = rejectedOf(page);
    expect(rejected).toEqual([
      expect.objectContaining({
        sub_order_id: w.idOf(2),
        raw_status: rawStatus,
        raw_payload_id: '70106',
        detail: expect.stringMatching(fieldNamed(field)),
      }),
    ]);
    expect(rejected[0]!.detail).not.toContain(BAD_AMOUNT);
  },
);

// 已结算的判据是 tk_earning_time 合法：这时 pub_share_fee 就是 N（BR-CALC-02 取值阶段、BR-CALC-03），坏了不能
// 留成 settle_commission_fen 为 null 再按预估算。未结算行不读它，所以同样的值不算坏行；不开 collect 的
// 老行为（null 加 warn）由冻结用例 AC-B1-04f#32 钉着，这里只看同一页两种开关的差别。
const BROKEN_SETTLE_FEES: readonly {
  readonly wording: string;
  readonly value: string | undefined;
}[] = [
  { wording: '非数字', value: BAD_AMOUNT },
  { wording: '缺失', value: undefined },
];

it.each(BROKEN_SETTLE_FEES)(
  '[AC-B1-04zv#1] 淘宝已结算行 pub_share_fee_for_commission $wording：collect 下进 rejected，未结算行照常；不开 collect 仍是 null 加 warn',
  async ({ value }) => {
    const rows = [
      { ...rowOf(1), pub_share_fee_for_commission: '8.00' },
      { ...rowOf(2), pub_share_fee_for_commission: value },
      {
        ...rowOf(3),
        pub_share_fee_for_commission: value,
        tk_status: num('12'),
        tk_earning_time: '--',
      },
    ];
    const collected = await resolved(() =>
      TAOBAO.adapter(rows, { payloadId: '70107' }).listOrders(TAOBAO.win, {}, TAOBAO.collect),
    );
    expect(collected.items.map((order) => order.sub_order_id)).toEqual([
      TAOBAO.idOf(1),
      TAOBAO.idOf(3),
    ]);
    expect(rejectedOf(collected)).toEqual([
      expect.objectContaining({
        sub_order_id: TAOBAO.idOf(2),
        raw_status: TAOBAO.rawStatus,
        raw_payload_id: '70107',
        detail: expect.stringMatching(fieldNamed('pub_share_fee_for_commission')),
      }),
    ]);

    const s = taobaoSetup(() => taobaoReply(pageData(rows)));
    const plain = await resolved(() => s.adapter.listOrders(TAOBAO.win, {}, TAOBAO.ctx));
    expect(plain.items.map((order) => order.sub_order_id)).toEqual([
      TAOBAO.idOf(1),
      TAOBAO.idOf(2),
      TAOBAO.idOf(3),
    ]);
    expect(plain.items[0]).toMatchObject({ settle_commission_fen: 700n });
    expect(plain.items[1]).toMatchObject({ commission_fen: 724n, settle_commission_fen: null });
    expect(Object.hasOwn(plain, 'rejected')).toBe(false);
    expect(s.orderWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'taobao_order_field_invalid',
        field: 'pub_share_fee_for_commission',
      }),
    );
  },
);

it('[AC-B1-04zv#1] pdd pay_time：一批全坏时迭代器照常往下走，不把空 items 当成翻完', async () => {
  const batch = (rows: readonly unknown[]) =>
    pdd(async () =>
      pddReply(
        { order_list_get_response: { order_list: rows, last_order_id: 'rq-next-batch' } },
        '70104',
      ),
    );
  const options = { queryMode: 'pay_time' as const };
  const page = await resolved(() =>
    batch([PDD.bad(1), PDD.bad(2)]).listOrders(PDD.win, options, PDD.collect),
  );
  expect(page.items).toEqual([]);
  expect(rejectedOf(page).map((row) => row.sub_order_id)).toEqual([PDD.idOf(1), PDD.idOf(2)]);
  const clean = await resolved(() =>
    batch([PDD.good(1)]).listOrders(PDD.win, options, PDD.collect),
  );
  expect(page.nextCursor).not.toBeNull();
  expect(page.nextCursor).toBe(clean.nextCursor);
});

// worker 经治理包装调 listOrders（worker-runtime 的 createGovernedSyncAdapter），包装会重建 CallCtx；
// orders 的 worker-harness 把这层换成了裸适配器，所以开关与 rejected 穿过它这件事只在这里看。
it('[AC-B1-04zv#1] 经治理包装：rowErrors 传到适配器，rejected 带回调用方', async () => {
  const { adapter } = wire(() =>
    jdReply(inner([JD.good(1), JD.bad(2), JD.good(3)], false), '70105'),
  );
  const page = await resolved(() => govern(adapter, () => true).listOrders(JD.win, {}, JD.collect));
  expect(page.items.map((order) => order.sub_order_id)).toEqual([JD.idOf(1), JD.idOf(3)]);
  expect(rejectedOf(page)).toEqual([
    expect.objectContaining({ sub_order_id: JD.idOf(2), raw_payload_id: '70105' }),
  ]);
});

it.each(WIRES)(
  '[AC-B1-04zv#4] $name：取不到单号的行 sub_order_id 为 null，detail 不含行里的金额与单号原文',
  async (w) => {
    const page = await resolved(() =>
      w
        .adapter([w.good(1), w.nameless(), w.good(3)], { payloadId: '70401' })
        .listOrders(w.win, {}, w.collect),
    );
    expect(page.items).toHaveLength(2);
    const rejected = rejectedOf(page);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ sub_order_id: null, raw_payload_id: '70401' });
    expect(rejected[0]!.detail).toMatch(fieldNamed(w.idField));
    for (const value of w.privateValues) expect(rejected[0]!.detail).not.toContain(value);
  },
);

it.each(WIRES)(
  '[AC-B1-04zv#4] $name：取得到单号的坏行，detail 只有字段名与原因，不含坏值、单号与金额原文',
  async (w: Wire) => {
    const page = await resolved(() =>
      w.adapter([w.good(1), w.bad(2)]).listOrders(w.win, {}, w.collect),
    );
    const rejected = rejectedOf(page);
    expect(rejected).toHaveLength(1);
    const { detail } = rejected[0]!;
    expect(detail).toMatch(fieldNamed(w.brokenField));
    expect(detail.length).toBeGreaterThan(w.brokenField.length);
    for (const value of [BAD_AMOUNT, w.idOf(2), ...w.privateValues]) {
      expect(detail).not.toContain(value);
    }
  },
);

it.each([JD, PDD])(
  '[AC-B1-04zv#4] $name：不是对象的行也进 rejected，单号与状态都是 null',
  async (w) => {
    const page = await resolved(() =>
      w
        .adapter([w.good(1), 'not-an-order-row', w.good(3)], { payloadId: '70402' })
        .listOrders(w.win, {}, w.collect),
    );
    expect(page.items).toHaveLength(2);
    expect(rejectedOf(page)).toEqual([
      expect.objectContaining({
        sub_order_id: null,
        raw_status: null,
        raw_payload_id: '70402',
        detail: expect.any(String),
      }),
    ]);
  },
);

it('[AC-B1-04zv#4] jd：状态码坏的行单号照取，raw_status 为 null', async () => {
  const page = await resolved(() =>
    JD.adapter([{ ...JD.good(1), validCode: 'rq-bad-code' }], { payloadId: '70403' }).listOrders(
      JD.win,
      {},
      JD.collect,
    ),
  );
  expect(rejectedOf(page)).toEqual([
    expect.objectContaining({ sub_order_id: JD.idOf(1), raw_status: null }),
  ]);
  expect(rejectedOf(page)[0]!.detail).not.toContain('rq-bad-code');
});

it('[AC-B1-04zv#5] 淘宝：缺 trade_id 的行进 rejected 且不另打 taobao_order_row_skipped；别的推广位的行不进 rejected', async () => {
  const s = taobaoSetup(() =>
    taobaoReply(
      pageData([
        { ...rowOf(1), pub_share_fee_for_commission: '8.00' },
        taobaoRow({ trade_id: undefined }),
        taobaoRow({ trade_id: undefined, adzone_id: num(FOREIGN_ADZONE) }),
        { ...rowOf(4, FOREIGN_ADZONE), alipay_total_price: BAD_AMOUNT },
      ]),
      '70501',
    ),
  );
  const page = await resolved(() => s.adapter.listOrders(taobaoWin, {}, TAOBAO.collect));
  expect(page.items.map((order) => order.sub_order_id)).toEqual([rowOf(1).trade_id]);
  expect(page.items[0]).toMatchObject({ settle_commission_fen: 700n });
  const rejected = rejectedOf(page);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ sub_order_id: null, raw_payload_id: '70501' });
  expect(rejected[0]!.detail).toMatch(fieldNamed('trade_id'));
  const warned = s.orderWarn.mock.calls.map(([event]) => event);
  expect(warned.map((event) => event.event)).not.toContain('taobao_order_row_skipped');
  expect(warned.filter((event) => event.event === 'taobao_order_foreign_slot')).toEqual([
    expect.objectContaining({ count: 2 }),
  ]);
});

it('[AC-B1-04zv#5] pdd：超界 goods_id 的行进 rejected，单号取到，detail 不含那串数字', async () => {
  const beyond = '9007199254740993';
  const adapter = pdd(async () => {
    const body = pddReply(
      {
        order_list_get_response: {
          order_list: [PDD.good(1), pddRow({ order_sn: PDD.idOf(2), goods_id: 7 }), PDD.good(3)],
        },
      },
      '70502',
    );
    return { ...body, body: body.body.replace('"goods_id":7,', `"goods_id":${beyond},`) };
  });
  const page = await resolved(() => adapter.listOrders(PDD.win, {}, PDD.collect));
  expect(page.items.map((order) => order.sub_order_id)).toEqual([PDD.idOf(1), PDD.idOf(3)]);
  const rejected = rejectedOf(page);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ sub_order_id: PDD.idOf(2) });
  expect(rejected[0]!.detail).toMatch(fieldNamed('goods_id'));
  expect(rejected[0]!.detail).not.toContain(beyond);
});
