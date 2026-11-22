// punish.window 遇淘宝违规接口的 punish_status（任务书第 9 节 9.2 第 1～6 条；08 BR-FUND-22 决-06 实测前 A、
// BR-FUND-02；规划/12 §1.3 处罚表；编排 D10-2335 (c3) / D10-2412）：
// - '0' 冻结照旧：交写入方 PUNISH / SUCCEEDED，去重号 = 违规单号，发生时间 = 同步时刻，violation_type 进 extras。
// - '1' 解冻：不交写入方（任何 type 都不交），交待处理端口一条 UNFREEZE_SIGNAL（raw_status '1'，detected_at =
//   注入时钟），warn 级告警一条、窗口结束日志单独计数，不混进 applied / not_found / unknown_status。
// - 0 / 1 以外的值：不交写入方，待处理 UNMAPPED_STATUS（raw_status 原值），warn 并单独计数。
// - 缺字段（适配器归一后的 null）：照现状按处罚交写入方，窗口结束日志单独计数缺字段条数；'0' 不计入。
// - 未注入待处理端口时解冻 / 未知值行同样不交写入方；待处理写入失败错误原样外抛、就此停下（同页其后的行
//   不交写入方、不取下一页），重投后补上。
// - detected_at / occurred_at 取注入时钟，不取窗口结束时刻（任务书 11.2 第 5 条）。
// 日志只断言事件名、级别与计数字段，并断言任何字段（递归，字符串化与数值化后）里不出现订单号、违规单号与
// 金额，也没有金额字段。
import { expect, it } from 'vitest';
import { handlePunishWindow } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import type { UnionPunish } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DONE_EVENT,
  MARKED_FEN,
  MISSING_COUNT,
  NOW,
  PUNISH_JOB,
  ROUND_TRIP_INDEXES,
  UNFREEZE_COUNT,
  UNFREEZE_EVENT,
  UNMAPPED_COUNT,
  UNMAPPED_EVENT,
  fixture,
  frozen,
  job,
  lateWindow,
  leaksIn,
  linesOf,
  markersOf,
  missingStatus,
  printed,
  punishItem,
  punishWindow,
  signalOf,
  targetOf,
  unfrozen,
  type Fixture,
} from './kit.ts';

const WINDOW = punishWindow();

/** The one window-end line, its counters. */
function doneOf(f: Fixture): Record<string, unknown> {
  const lines = f.done();
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

/** Every logger call of the window (info, warn, error): no order number, punishment id or amount. */
function expectNoMarkers(f: Fixture, rows: readonly UnionPunish[], extra: readonly string[] = []) {
  const markers = [...markersOf(rows), ...extra];
  const logs = printed(f.logger.info, f.logger.warn, f.logger.error);
  for (const marker of markers) expect(logs).not.toContain(marker);
  expect(leaksIn([f.logger.info, f.logger.warn, f.logger.error], markers)).toEqual({
    values: [],
    amountKeys: [],
  });
}

it('[AC-B1-04zzab#1] 冻结（punish_status 0）照旧：交写入方 PUNISH / SUCCEEDED，违规单号作去重号、发生时间取同步时刻、violation_type 原样进 extras；不写待处理', async () => {
  const one = frozen(1, { violation_type: '2' });
  const f = fixture({ punishPages: [[one]] });
  await handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler);

  expect(f.writesWithExtras()).toEqual([
    { target: targetOf(one), item: punishItem(one), extras: { violation_type: '2' } },
  ]);
  expect(f.record).not.toHaveBeenCalled();
  expect(doneOf(f)).toMatchObject({ applied: 1, [UNFREEZE_COUNT]: 0, [UNMAPPED_COUNT]: 0 });
  expect(f.warned(UNFREEZE_EVENT)).toEqual([]);
});

it('[AC-B1-04zzab#2] 解冻（punish_status 1）：不交写入方，交待处理一条 UNFREEZE_SIGNAL（平台、订单号、raw_status 1、detected_at 取注入时钟）', async () => {
  const one = unfrozen(1, { deduction_fen: MARKED_FEN });
  const f = fixture({ punishPages: [[one]] });
  await expect(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler)).resolves.toBeUndefined();

  expect(f.write).not.toHaveBeenCalled();
  expect(f.signals()).toEqual([signalOf(one, 'UNFREEZE_SIGNAL', '1')]);
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zzab#3] 解冻告警：一条 warn 级日志带本窗解冻条数，窗口结束日志单独计数，不混进 applied / not_found / unknown_status；日志不带订单号、违规单号、金额', async () => {
  const a = unfrozen(1, { deduction_fen: MARKED_FEN });
  const b = unfrozen(2);
  const f = fixture({ punishPages: [[a, b]] });
  await handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler);

  const warns = f.warned(UNFREEZE_EVENT);
  expect(warns).toHaveLength(1);
  expect(warns[0]).toMatchObject({ [UNFREEZE_COUNT]: 2 });
  expect(f.elsewhere(UNFREEZE_EVENT)).toEqual([]);
  expect(doneOf(f)).toMatchObject({
    [UNFREEZE_COUNT]: 2,
    applied: 0,
    duplicate: 0,
    not_found: 0,
    not_applicable: 0,
    unknown_status: 0,
  });
  expectNoMarkers(f, [a, b], [MARKED_FEN.toString()]);
});

it('[AC-B1-04zzab#4] 装配没注入待处理端口：解冻行仍不交写入方（宁可只留日志，不退回成扣回），告警与计数照旧，不抛错', async () => {
  const one = unfrozen(1);
  const f = fixture({ punishPages: [[frozen(2), one]] });
  await expect(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.bare)).resolves.toBeUndefined();

  expect(f.writes().map((w) => w.target.sub_order_id)).toEqual([frozen(2).order_id]);
  expect(f.writes().some((w) => w.target.sub_order_id === one.order_id)).toBe(false);
  expect(f.warned(UNFREEZE_EVENT)).toHaveLength(1);
  expect(f.warned(UNFREEZE_EVENT)[0]).toMatchObject({ [UNFREEZE_COUNT]: 1 });
  expect(doneOf(f)).toMatchObject({ applied: 1, [UNFREEZE_COUNT]: 1 });
});

it('[AC-B1-04zzab#5] 同一页冻结与解冻混排：各走各的；解冻不影响其余行的写入与计数；取页、游标、不推水位、不读维权照旧', async () => {
  const f1 = frozen(1);
  const u2 = unfrozen(2);
  const u3 = unfrozen(3);
  const f4 = frozen(4);
  const f5 = frozen(5);
  const f = fixture({
    punishPages: [
      [f1, u2, f4],
      [u3, f5],
    ],
  });
  f.write.mockImplementation(async (target) =>
    target.sub_order_id === f4.order_id ? { kind: 'not_found' } : { kind: 'applied' },
  );
  await handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler);

  expect(f.listPunishments).toHaveBeenCalledTimes(2);
  expect(f.listPunishments.mock.calls[0]![2]?.cursor).toBeUndefined();
  expect(f.listPunishments.mock.calls[1]![2]).toMatchObject({ cursor: 'page-1' });
  expect(f.writes()).toEqual([
    { target: targetOf(f1), item: punishItem(f1) },
    { target: targetOf(f4), item: punishItem(f4) },
    { target: targetOf(f5), item: punishItem(f5) },
  ]);
  expect(f.signals()).toEqual([
    signalOf(u2, 'UNFREEZE_SIGNAL', '1'),
    signalOf(u3, 'UNFREEZE_SIGNAL', '1'),
  ]);
  expect(doneOf(f)).toMatchObject({
    pages: 2,
    applied: 2,
    not_found: 1,
    [UNFREEZE_COUNT]: 2,
    unknown_status: 0,
  });
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.listRefunds).not.toHaveBeenCalled();
});

it('[AC-B1-04zzab#6] 待处理写入失败：错误外抛（队列重试），不吞掉；重投同一窗口照样交同一条信号、仍不交写入方', async () => {
  const one = unfrozen(1);
  const f = fixture({ punishPages: [[one]] });
  const broken = new Error('synthetic order_sync_pending failure');
  f.record.mockRejectedValueOnce(broken);
  await expect(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler)).rejects.toBe(broken);
  expect(f.write).not.toHaveBeenCalled();

  await expect(handlePunishWindow(job(PUNISH_JOB, WINDOW, 2), f.handler)).resolves.toBeUndefined();
  expect(f.record).toHaveBeenCalledTimes(2);
  expect(f.record.mock.calls[1]).toEqual(f.record.mock.calls[0]);
  expect(f.signals()[1]).toEqual(signalOf(one, 'UNFREEZE_SIGNAL', '1'));
  expect(f.write).not.toHaveBeenCalled();
});

it('[AC-B1-04zzab#7] 同一解冻行反复出现（违规接口每 30 分钟回看 30 天）：每次都交待处理端口、都不交写入方，不抛错（同键 open 只一条由库表唯一索引保证）', async () => {
  const one = unfrozen(1);
  const f = fixture({ punishPages: [[one]] });
  await handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler);
  await expect(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler)).resolves.toBeUndefined();
  expect(f.signals()).toEqual([
    signalOf(one, 'UNFREEZE_SIGNAL', '1'),
    signalOf(one, 'UNFREEZE_SIGNAL', '1'),
  ]);
  expect(f.write).not.toHaveBeenCalled();
});

it.each(['2', '-1'])(
  '[AC-B1-04zzab#8] punish_status 是 0 / 1 以外的值（%j）：不交写入方（不扣回），待处理 UNMAPPED_STATUS、raw_status 原值，warn 并单独计数',
  async (raw) => {
    const odd = frozen(1, { punish_status: raw, deduction_fen: MARKED_FEN });
    const kept = frozen(2);
    const f = fixture({ punishPages: [[odd, kept]] });
    await handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler);

    expect(f.writes()).toEqual([{ target: targetOf(kept), item: punishItem(kept) }]);
    expect(f.signals()).toEqual([signalOf(odd, 'UNMAPPED_STATUS', raw)]);
    const warns = f.warned(UNMAPPED_EVENT);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ [UNMAPPED_COUNT]: 1 });
    expect(f.elsewhere(UNMAPPED_EVENT)).toEqual([]);
    expect(doneOf(f)).toMatchObject({
      applied: 1,
      [UNMAPPED_COUNT]: 1,
      [UNFREEZE_COUNT]: 0,
      unknown_status: 0,
    });
    expect(f.warned(UNFREEZE_EVENT)).toEqual([]);
    expectNoMarkers(f, [odd, kept], [MARKED_FEN.toString()]);
  },
);

it('[AC-B1-04zzab#9] 0 / 1 以外的值且装配没注入待处理端口：同样不交写入方，告警照旧', async () => {
  const odd = frozen(1, { punish_status: '2' });
  const f = fixture({ punishPages: [[odd]] });
  await expect(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.bare)).resolves.toBeUndefined();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.warned(UNMAPPED_EVENT)).toHaveLength(1);
  expect(doneOf(f)).toMatchObject({ [UNMAPPED_COUNT]: 1 });
});

it('[AC-B1-04zzab#10] punish_status 缺失（适配器归一后的 null）：照现状按处罚交写入方，窗口结束日志单独计数缺字段条数；带 0 的行不计入', async () => {
  const nulled = missingStatus(1);
  const other = missingStatus(2);
  const zero = frozen(3);
  const f = fixture({ punishPages: [[nulled, other, zero]] });
  await handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler);

  expect(f.writes()).toEqual([
    { target: targetOf(nulled), item: punishItem(nulled) },
    { target: targetOf(other), item: punishItem(other) },
    { target: targetOf(zero), item: punishItem(zero) },
  ]);
  expect(f.record).not.toHaveBeenCalled();
  expect(doneOf(f)).toMatchObject({
    applied: 3,
    [MISSING_COUNT]: 2,
    [UNFREEZE_COUNT]: 0,
    [UNMAPPED_COUNT]: 0,
  });
  expectNoMarkers(f, [nulled, other, zero]);

  const g = fixture({ punishPages: [[frozen(4), frozen(5)]] });
  await handlePunishWindow(job(PUNISH_JOB, WINDOW), g.handler);
  expect(doneOf(g)).toMatchObject({ applied: 2, [MISSING_COUNT]: 0 });
});

it('[AC-B1-04zzab#11] 解冻、未知值、缺字段、冻结同窗：计数各归各的，写入方只收到冻结与缺字段的行', async () => {
  const u = unfrozen(1);
  const odd = frozen(2, { punish_status: '7' });
  const missing = frozen(3, { punish_status: null });
  const z = frozen(4);
  const f = fixture({
    punishPages: [
      [u, odd],
      [missing, z],
    ],
  });
  await handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler);

  expect(f.writes().map((w) => w.target.sub_order_id)).toEqual([missing.order_id, z.order_id]);
  expect(f.writes().every((w) => w.item.type === 'PUNISH' && w.item.status === 'SUCCEEDED')).toBe(
    true,
  );
  expect(f.signals()).toEqual([
    signalOf(u, 'UNFREEZE_SIGNAL', '1'),
    signalOf(odd, 'UNMAPPED_STATUS', '7'),
  ]);
  expect(doneOf(f)).toMatchObject({
    applied: 2,
    [UNFREEZE_COUNT]: 1,
    [UNMAPPED_COUNT]: 1,
    [MISSING_COUNT]: 1,
    unknown_status: 0,
    not_found: 0,
  });
});

it('[AC-B1-04zzab#21] 窗口结束时刻 ≠ 注入时钟（03:48 结束的窗 04:00 才执行）：解冻与表外值的 detected_at、冻结与缺字段行的 occurred_at 都取注入时钟', async () => {
  const late = lateWindow();
  expect(Date.parse(late.window_end)).not.toBe(Date.parse(NOW));
  const z = frozen(1, { violation_type: '2' });
  const u = unfrozen(2);
  const odd = frozen(3, { punish_status: '2' });
  const m = missingStatus(4);
  const f = fixture({ punishPages: [[z, u, odd, m]] });
  await handlePunishWindow(job(PUNISH_JOB, late), f.handler);

  expect(f.writes()).toEqual([
    { target: targetOf(z), item: punishItem(z) },
    { target: targetOf(m), item: punishItem(m) },
  ]);
  expect(f.writes().map((w) => w.item.occurred_at.toISOString())).toEqual([NOW, NOW]);
  expect(f.signals()).toEqual([
    signalOf(u, 'UNFREEZE_SIGNAL', '1'),
    signalOf(odd, 'UNMAPPED_STATUS', '2'),
  ]);
  expect(f.signals().map((s) => s.detected_at.toISOString())).toEqual([NOW, NOW]);
});

it.each([
  ['解冻', 'UNFREEZE_SIGNAL', '1', 'UNMAPPED_STATUS', '2'],
  ['表外值', 'UNMAPPED_STATUS', '2', 'UNFREEZE_SIGNAL', '1'],
] as const)(
  '[AC-B1-04zzab#22] 待处理写入失败（%s 行）即停：错误原样外抛，同页其后的冻结行不交写入方、不取下一页；重投后失败前写过的再交一次、没写成的补上，冻结行各交一次',
  async (_name, failReason, failRaw, okReason, okRaw) => {
    const earlier = frozen(1, { punish_status: okRaw });
    const failing = frozen(2, { punish_status: failRaw });
    const after = frozen(3);
    const next = frozen(4);
    const f = fixture({ punishPages: [[earlier, failing, after], [next]] });
    const broken = new Error('synthetic order_sync_pending failure');
    let failed = false;
    f.record.mockImplementation(async (signal) => {
      if (!failed && signal.sub_order_id === failing.order_id) {
        failed = true;
        throw broken;
      }
    });
    const first = [signalOf(earlier, okReason, okRaw), signalOf(failing, failReason, failRaw)];

    await expect(handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler)).rejects.toBe(broken);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.listPunishments).toHaveBeenCalledTimes(1);
    expect(f.signals()).toEqual(first);
    expect(f.advance).not.toHaveBeenCalled();

    await expect(
      handlePunishWindow(job(PUNISH_JOB, WINDOW, 2), f.handler),
    ).resolves.toBeUndefined();
    expect(f.signals()).toEqual([...first, ...first]);
    expect(f.writes()).toEqual([
      { target: targetOf(after), item: punishItem(after) },
      { target: targetOf(next), item: punishItem(next) },
    ]);
    expect(f.listPunishments).toHaveBeenCalledTimes(3);
  },
);

it('[AC-B1-04zzab#23] 两条 warn 与窗口结束日志不泄露单号：订单号转 Number 打印与原串相同的也查；全部字段值（递归、字符串化与数值化后）不含订单号、违规单号与金额，也没有金额字段', async () => {
  const [sameIndex, otherSameIndex] = ROUND_TRIP_INDEXES;
  const u0 = unfrozen(sameIndex, { deduction_fen: MARKED_FEN });
  const u1 = unfrozen(7, { deduction_fen: MARKED_FEN });
  const odd0 = frozen(otherSameIndex, { punish_status: '2', deduction_fen: MARKED_FEN });
  const odd1 = frozen(9, { punish_status: '3' });
  const z = frozen(11);
  const m = missingStatus(12);
  // Fixture check: these two print as themselves once turned into a Number, those two do not.
  for (const row of [u0, odd0]) expect(String(Number(row.order_id))).toBe(row.order_id);
  for (const row of [u1, odd1]) expect(String(Number(row.order_id))).not.toBe(row.order_id);
  const f = fixture({
    punishPages: [
      [u0, z, odd0],
      [u1, m, odd1],
    ],
  });
  await handlePunishWindow(job(PUNISH_JOB, WINDOW), f.handler);

  expect(f.warned(UNFREEZE_EVENT)).toHaveLength(1);
  expect(f.warned(UNMAPPED_EVENT)).toHaveLength(1);
  expect(doneOf(f)).toMatchObject({
    applied: 2,
    [UNFREEZE_COUNT]: 2,
    [UNMAPPED_COUNT]: 2,
    [MISSING_COUNT]: 1,
  });
  const rows = [u0, u1, odd0, odd1, z, m];
  const markers = [...markersOf(rows), MARKED_FEN.toString()];
  for (const line of [
    ...f.warned(UNFREEZE_EVENT),
    ...f.warned(UNMAPPED_EVENT),
    ...linesOf(f.logger.info, DONE_EVENT),
  ]) {
    expect(leaksIn([{ mock: { calls: [[line]] } }], markers)).toEqual({
      values: [],
      amountKeys: [],
    });
  }
  expectNoMarkers(f, rows, [MARKED_FEN.toString()]);
});
