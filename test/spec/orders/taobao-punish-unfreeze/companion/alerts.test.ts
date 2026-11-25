// B1-04zzac 伴随测试（FU-B1-04ZZAB-SPEC-R3-GAP；08 BR-FUND-22 决-06 实测前 A：「解冻」是映射表之外的信号，按
// BR-FUND-02 进待处理表并告警、留下证据）：punish.window 中途失败时告警不能丢（资金评审 r2 修出来的行为）。
// - 待处理写入失败（含窗口里第一条就失败，或一类已落库之后另一类的第一条失败，两种先后都钉）：写入失败的那一类
//   照样一条 warn，计数只算已落库的（第一条就失败时为 0），并标出没记下的 1 条与窗口没跑完；另一类有已落库的
//   也各一条 warn，计数如实；原错误原样外抛。
// - 不是待处理写入失败（写入方抛错、取页抛错）：已落库的类别照样各一条 warn，计数如实，原错误外抛。
// - 告警只在 warn 级，不带订单号、违规单号与金额。
// 会抛的调用先 settle 再用普通断言判。用例全部是顶层 it。
import { expect, it } from 'vitest';
import { handlePunishWindow } from '../../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import type { UnionPunish } from '../../../../../apps/api/src/modules/union/domain/types.ts';
import {
  PUNISH_JOB,
  UNFREEZE_COUNT,
  UNFREEZE_EVENT,
  UNMAPPED_COUNT,
  UNMAPPED_EVENT,
  fixture,
  frozen,
  job,
  leaksIn,
  markersOf,
  punishItem,
  punishWindow,
  signalOf,
  targetOf,
  unfrozen,
  type Fixture,
} from '../kit.ts';

const WINDOW = punishWindow();

/** A run's outcome, read after it settles (no .resolves / .rejects). */
async function settle(run: Promise<void>): Promise<PromiseSettledResult<void>> {
  const [out] = await Promise.allSettled([run] as const);
  return out;
}

/** The run threw `error` itself (not a wrapped or another one). */
function expectThrown(out: PromiseSettledResult<void>, error: Error) {
  expect(out.status).toBe('rejected');
  expect(out.status === 'rejected' ? out.reason : undefined).toBe(error);
}

/**
 * The warn lines of both kinds. Checked on the way: neither event shows up at another level, and no
 * logged value holds an order number, a punishment id or an amount (no amount field either).
 */
function alertsOf(f: Fixture, rows: readonly UnionPunish[]) {
  expect([...f.elsewhere(UNFREEZE_EVENT), ...f.elsewhere(UNMAPPED_EVENT)]).toEqual([]);
  expect(leaksIn([f.logger.info, f.logger.warn, f.logger.error], markersOf(rows))).toEqual({
    values: [],
    amountKeys: [],
  });
  return { unfreeze: f.warned(UNFREEZE_EVENT), unmapped: f.warned(UNMAPPED_EVENT) };
}

it.each([
  ['解冻', '1', UNFREEZE_EVENT, UNFREEZE_COUNT, UNMAPPED_EVENT],
  ['表外值', '2', UNMAPPED_EVENT, UNMAPPED_COUNT, UNFREEZE_EVENT],
] as const)(
  '[AC-B1-04zzac#8] 窗口里第一条待处理写入（%s 行）就失败：该类照样一条 warn，计数 0、没记下 1 条、窗口没跑完；另一类不告警；原错误外抛，其后的冻结行不交写入方',
  async (_name, raw, failedEvent, failedCount, otherEvent) => {
    const failing = frozen(1, { punish_status: raw });
    const after = frozen(2);
    const f = fixture({ punishPages: [[failing, after]] });
    const broken = new Error('synthetic order_sync_pending failure');
    f.record.mockRejectedValueOnce(broken);

    const out = await settle(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler));
    expectThrown(out, broken);

    expect(f.write).not.toHaveBeenCalled();
    alertsOf(f, [failing, after]);
    const warns = f.warned(failedEvent);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ [failedCount]: 0, not_recorded: 1, window_complete: false });
    expect(f.warned(otherEvent)).toEqual([]);
  },
);

it('[AC-B1-04zzac#9] 第二页上一条解冻的待处理写入失败（第一页已落库解冻 1 条、表外值 1 条）：两类各一条 warn，解冻计数 1、没记下 1 条，表外值计数 1、没记下 0 条，窗口没跑完；原错误外抛', async () => {
  const u1 = unfrozen(1);
  const odd2 = frozen(2, { punish_status: '2' });
  const z3 = frozen(3);
  const u4 = unfrozen(4);
  const f = fixture({ punishPages: [[u1, odd2, z3], [u4]] });
  const broken = new Error('synthetic order_sync_pending failure');
  f.record.mockImplementation(async (signal) => {
    if (signal.sub_order_id === u4.order_id) throw broken;
  });

  const out = await settle(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler));
  expectThrown(out, broken);

  expect(f.signals()).toEqual([
    signalOf(u1, 'UNFREEZE_SIGNAL', '1'),
    signalOf(odd2, 'UNMAPPED_STATUS', '2'),
    signalOf(u4, 'UNFREEZE_SIGNAL', '1'),
  ]);
  expect(f.writes()).toEqual([{ target: targetOf(z3), item: punishItem(z3) }]);
  const { unfreeze, unmapped } = alertsOf(f, [u1, odd2, z3, u4]);
  expect(unfreeze).toHaveLength(1);
  expect(unfreeze[0]).toMatchObject({
    [UNFREEZE_COUNT]: 1,
    not_recorded: 1,
    window_complete: false,
  });
  expect(unmapped).toHaveLength(1);
  expect(unmapped[0]).toMatchObject({
    [UNMAPPED_COUNT]: 1,
    not_recorded: 0,
    window_complete: false,
  });
});

it.each([
  ['先落库解冻、表外值', '1', 'UNFREEZE_SIGNAL', '2', 'UNMAPPED_STATUS', [1, 0], [0, 1]],
  ['先落库表外值、解冻', '2', 'UNMAPPED_STATUS', '1', 'UNFREEZE_SIGNAL', [0, 1], [1, 0]],
] as const)(
  '[AC-B1-04zzac#10] %s的第一条待处理写入失败：两类各一条 warn——已落库的一类计数 1、没记下 0 条，写入失败的一类计数 0、没记下 1 条，窗口没跑完；抛出的就是那个写入错误',
  async (_name, firstRaw, firstReason, secondRaw, secondReason, unfreezeIs, unmappedIs) => {
    const first = frozen(1, { punish_status: firstRaw });
    const second = frozen(2, { punish_status: secondRaw });
    const f = fixture({ punishPages: [[first, second]] });
    const broken = new Error('synthetic order_sync_pending failure');
    f.record.mockImplementation(async (signal) => {
      if (signal.sub_order_id === second.order_id) throw broken;
    });

    const out = await settle(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler));
    expectThrown(out, broken);

    expect(f.signals()).toEqual([
      signalOf(first, firstReason, firstRaw),
      signalOf(second, secondReason, secondRaw),
    ]);
    const { unfreeze, unmapped } = alertsOf(f, [first, second]);
    expect(unfreeze).toHaveLength(1);
    expect(unfreeze[0]).toMatchObject({
      [UNFREEZE_COUNT]: unfreezeIs[0],
      not_recorded: unfreezeIs[1],
      window_complete: false,
    });
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]).toMatchObject({
      [UNMAPPED_COUNT]: unmappedIs[0],
      not_recorded: unmappedIs[1],
      window_complete: false,
    });
    expect(f.write).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zzac#11] 写入方在冻结行上抛错（此前已落库解冻 1 条、表外值 1 条）：两类各一条 warn，计数各 1、没记下 0 条，窗口没跑完；写入方的错误原样外抛', async () => {
  const u1 = unfrozen(1);
  const odd2 = frozen(2, { punish_status: '2' });
  const z3 = frozen(3);
  const f = fixture({ punishPages: [[u1, odd2, z3]] });
  const broken = new Error('synthetic rights writer failure');
  f.write.mockRejectedValueOnce(broken);

  const out = await settle(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler));
  expectThrown(out, broken);

  expect(f.signals()).toEqual([
    signalOf(u1, 'UNFREEZE_SIGNAL', '1'),
    signalOf(odd2, 'UNMAPPED_STATUS', '2'),
  ]);
  const { unfreeze, unmapped } = alertsOf(f, [u1, odd2, z3]);
  expect(unfreeze).toHaveLength(1);
  expect(unfreeze[0]).toMatchObject({
    [UNFREEZE_COUNT]: 1,
    not_recorded: 0,
    window_complete: false,
  });
  expect(unmapped).toHaveLength(1);
  expect(unmapped[0]).toMatchObject({
    [UNMAPPED_COUNT]: 1,
    not_recorded: 0,
    window_complete: false,
  });
});

it('[AC-B1-04zzac#12] 取第二页抛错（第一页已落库解冻 2 条、表外值 1 条）：两类各一条 warn，解冻计数 2、表外值计数 1、没记下 0 条，窗口没跑完；取页的错误原样外抛', async () => {
  const u1 = unfrozen(1);
  const u2 = unfrozen(2);
  const odd3 = frozen(3, { punish_status: '7' });
  const f = fixture();
  const broken = new Error('synthetic punish page failure');
  f.listPunishments.mockImplementation((_win, _ctx, opt) =>
    opt?.cursor === undefined
      ? Promise.resolve({ items: [u1, u2, odd3], nextCursor: 'page-1' })
      : Promise.reject(broken),
  );

  const out = await settle(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler));
  expectThrown(out, broken);

  expect(f.listPunishments).toHaveBeenCalledTimes(2);
  expect(f.signals()).toEqual([
    signalOf(u1, 'UNFREEZE_SIGNAL', '1'),
    signalOf(u2, 'UNFREEZE_SIGNAL', '1'),
    signalOf(odd3, 'UNMAPPED_STATUS', '7'),
  ]);
  const { unfreeze, unmapped } = alertsOf(f, [u1, u2, odd3]);
  expect(unfreeze).toHaveLength(1);
  expect(unfreeze[0]).toMatchObject({
    [UNFREEZE_COUNT]: 2,
    not_recorded: 0,
    window_complete: false,
  });
  expect(unmapped).toHaveLength(1);
  expect(unmapped[0]).toMatchObject({
    [UNMAPPED_COUNT]: 1,
    not_recorded: 0,
    window_complete: false,
  });
  expect(f.write).not.toHaveBeenCalled();
});
