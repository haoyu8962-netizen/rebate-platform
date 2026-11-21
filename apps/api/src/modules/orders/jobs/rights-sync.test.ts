// B1-04zzab unit tests of punish.window's punish_status split (implementer's own; the rule tests are
// test/spec/orders/taobao-punish-unfreeze/**). D10-2449: an unfrozen ('1') or unmapped punish row
// reaches no port but the pending one — no writer, no cursor, no order column.
import { expect, it, vi } from 'vitest';
import { FixedClock, type ReceivedJob } from '../../platform/index.ts';
import type { UnionPunish } from '../../union/index.ts';
import type { PunishPendingPort } from '../application/punish-pending.ts';
import type { RightsSyncWriteResult } from '../application/rights-sync.ts';
import { handlePunishWindow, type RightsSyncHandlerDeps } from './rights-sync.ts';

const NOW = '2026-11-06T04:00:00.000Z';
const ACCOUNT = '20000000-0000-4000-8000-0000000000b1';

function job(): ReceivedJob {
  return {
    id: 'unit-punish',
    queue: 'order-sync',
    name: 'punish.window',
    payload: {
      app_id: 'unit',
      platform: 'taobao',
      union_account_id: ACCOUNT,
      query_kind: 'punish',
      scene: '-',
      window_start: '2026-10-07T04:00:00.000Z',
      window_end: NOW,
    },
    attempt: 1,
  };
}

function row(index: number, status: string | null): UnionPunish {
  const orderId = `${3900000000000006000n + BigInt(index)}`;
  return {
    order_id: orderId,
    punishment_id: `${orderId}:202610`,
    deduction_fen: null,
    punish_status: status,
    violation_type: '1',
    settle_month: '202610',
  };
}

/** Every port of the handler as a mock, so that any call to one of them is seen. */
function harness(rows: readonly UnionPunish[], withPending = true) {
  const listPunishments = vi.fn(
    async (): Promise<{ items: readonly UnionPunish[]; nextCursor: string | null }> => ({
      items: rows,
      nextCursor: null,
    }),
  );
  const listRefunds = vi.fn(async () => ({ items: [], nextCursor: null }));
  const write = vi.fn(async (): Promise<RightsSyncWriteResult> => ({ kind: 'applied' }));
  const advance = vi.fn(async () => true);
  const record = vi.fn<PunishPendingPort['record']>(async () => undefined);
  const access = {
    listEnabledAccounts: vi.fn(async () => []),
    siteAuthAvailable: vi.fn(async () => true),
    offlineCircuitOpen: vi.fn(async () => false),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: RightsSyncHandlerDeps = {
    clock: new FixedClock(NOW),
    access,
    cursors: { advance },
    registry: { get: vi.fn(() => ({ listPunishments, listRefunds })) },
    writer: { write },
    logger,
    ...(withPending ? { pending: { record } } : {}),
  };
  return { deps, listPunishments, listRefunds, write, advance, record, access, logger };
}

it.each([
  ['解冻', '1', 'UNFREEZE_SIGNAL'],
  ['表外值', '2', 'UNMAPPED_STATUS'],
] as const)(
  '[AC-B1-04zzab#D10-2449] %s行：除待处理写入端口外不调用任何写入端口（写入方、水位、维权源都不碰）',
  async (_name, raw, reason) => {
    const h = harness([row(1, raw), row(2, raw)]);
    await handlePunishWindow(job(), h.deps);

    expect(h.record.mock.calls.map(([s]) => [s.reason, s.raw_status])).toEqual([
      [reason, raw],
      [reason, raw],
    ]);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.listRefunds).not.toHaveBeenCalled();
    expect(h.access.listEnabledAccounts).not.toHaveBeenCalled();
    expect(h.access.offlineCircuitOpen).not.toHaveBeenCalled();
    expect(h.listPunishments).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04zzab#D10-2449] 未注入待处理端口：解冻与表外值行一样不交写入方，只留告警与计数', async () => {
  const h = harness([row(1, '1'), row(2, '9')], false);
  await handlePunishWindow(job(), h.deps);
  expect(h.write).not.toHaveBeenCalled();
  expect(h.advance).not.toHaveBeenCalled();
  expect(h.record).not.toHaveBeenCalled();
  const warned = h.logger.warn.mock.calls.map((call) => [call[1], call[0].recorded]);
  expect(warned).toEqual([
    ['order_punish_sync_window_unfreeze_signal', false],
    ['order_punish_sync_window_unmapped_punish_status', false],
  ]);
});

it('[AC-B1-04zzab#unit] 冻结与缺字段照旧交写入方；窗口结束日志三个新计数为 0 时也在', async () => {
  const h = harness([row(1, '0'), row(2, null)]);
  await handlePunishWindow(job(), h.deps);
  expect(h.write).toHaveBeenCalledTimes(2);
  expect(h.record).not.toHaveBeenCalled();
  const done = h.logger.info.mock.calls.find((call) => call[1] === 'order_punish_sync_window_done');
  expect(done?.[0]).toMatchObject({
    applied: 2,
    unfreeze_signal: 0,
    unmapped_punish_status: 0,
    missing_punish_status: 1,
  });
  expect(h.logger.warn).not.toHaveBeenCalled();
});

/** The warn lines of the window, as [event, fields]. */
function warns(h: ReturnType<typeof harness>) {
  return h.logger.warn.mock.calls.map((call) => [call[1], call[0]] as const);
}

it('[AC-B1-04zzab#unit] 评审 r1 第 3 条：第二页取页抛错，已落库的解冻与表外值各一条 warn（window_complete false、not_recorded 0），无窗口结束日志，原错误外抛', async () => {
  const broken = new Error('synthetic page failure');
  const h = harness([]);
  h.listPunishments
    .mockResolvedValueOnce({ items: [row(1, '1'), row(2, '1'), row(3, '7')], nextCursor: 'p2' })
    .mockRejectedValueOnce(broken);
  await expect(handlePunishWindow(job(), h.deps)).rejects.toBe(broken);
  expect(h.record).toHaveBeenCalledTimes(3);
  expect(warns(h)).toEqual([
    [
      'order_punish_sync_window_unfreeze_signal',
      expect.objectContaining({
        unfreeze_signal: 2,
        recorded: true,
        window_complete: false,
        not_recorded: 0,
      }),
    ],
    [
      'order_punish_sync_window_unmapped_punish_status',
      expect.objectContaining({
        unmapped_punish_status: 1,
        recorded: true,
        window_complete: false,
        not_recorded: 0,
      }),
    ],
  ]);
  expect(h.logger.info.mock.calls.some((call) => call[1] === 'order_punish_sync_window_done')).toBe(
    false,
  );
  expect(h.write).not.toHaveBeenCalled();
});

it('[AC-B1-04zzab#unit] 评审 r1 第 3 条：待处理写入抛错，失败那条不计入已落库数、在该类 warn 上记 not_recorded 1；该类一条都没落成时也发该类 warn（评审 r2 S1）', async () => {
  const broken = new Error('synthetic order_sync_pending failure');
  const h = harness([row(1, '1'), row(2, '1'), row(3, '0')]);
  h.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(broken);
  await expect(handlePunishWindow(job(), h.deps)).rejects.toBe(broken);
  expect(h.write).not.toHaveBeenCalled();
  expect(warns(h)).toEqual([
    [
      'order_punish_sync_window_unfreeze_signal',
      expect.objectContaining({ unfreeze_signal: 1, window_complete: false, not_recorded: 1 }),
    ],
  ]);

  const first = harness([row(1, '5')]);
  first.record.mockRejectedValueOnce(broken);
  await expect(handlePunishWindow(job(), first.deps)).rejects.toBe(broken);
  expect(warns(first)).toEqual([
    [
      'order_punish_sync_window_unmapped_punish_status',
      expect.objectContaining({
        unmapped_punish_status: 0,
        window_complete: false,
        not_recorded: 1,
      }),
    ],
  ]);
});

it.each([
  ['解冻', '1', 'order_punish_sync_window_unfreeze_signal', 'unfreeze_signal'],
  ['表外值', '2', 'order_punish_sync_window_unmapped_punish_status', 'unmapped_punish_status'],
] as const)(
  '[AC-B1-04zzab#unit] 评审 r2 S1：窗口第一条%s行的待处理写入就抛错，该类恰一条 warn（计数 0、not_recorded 1、window_complete false），另一类不发；原错误外抛，别的端口不碰',
  async (_name, raw, event, field) => {
    const broken = new Error('synthetic order_sync_pending failure');
    const h = harness([row(1, raw), row(2, '0')]);
    h.record.mockRejectedValueOnce(broken);
    await expect(handlePunishWindow(job(), h.deps)).rejects.toBe(broken);
    expect(warns(h)).toEqual([
      [
        event,
        expect.objectContaining({
          [field]: 0,
          recorded: true,
          window_complete: false,
          not_recorded: 1,
        }),
      ],
    ]);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.listRefunds).not.toHaveBeenCalled();
    expect(h.access.listEnabledAccounts).not.toHaveBeenCalled();
    expect(h.access.offlineCircuitOpen).not.toHaveBeenCalled();
    expect(h.listPunishments).toHaveBeenCalledTimes(1);
    expect(
      h.logger.info.mock.calls.some((call) => call[1] === 'order_punish_sync_window_done'),
    ).toBe(false);
  },
);

it('[AC-B1-04zzab#unit] 评审 r1 第 3 条：写入方抛错（冻结行），之前已落库的解冻照样 warn，原错误外抛；成功路径的 warn 不带 window_complete', async () => {
  const broken = new Error('synthetic writer failure');
  const h = harness([row(1, '1'), row(2, '0')]);
  h.write.mockRejectedValueOnce(broken);
  await expect(handlePunishWindow(job(), h.deps)).rejects.toBe(broken);
  expect(warns(h)).toEqual([
    [
      'order_punish_sync_window_unfreeze_signal',
      expect.objectContaining({ unfreeze_signal: 1, window_complete: false, not_recorded: 0 }),
    ],
  ]);

  const ok = harness([row(1, '1')]);
  await handlePunishWindow(job(), ok.deps);
  expect(warns(ok)).toHaveLength(1);
  expect(warns(ok)[0]?.[1]).not.toHaveProperty('window_complete');
  expect(warns(ok)[0]?.[1]).not.toHaveProperty('not_recorded');
});
