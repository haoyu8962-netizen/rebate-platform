// D10-36: one credential set per platform; only the account those credentials belong to syncs.
import { expect, it, vi } from 'vitest';
import { FixedClock, type JobQueue } from '../../platform/index.ts';
import { scheduleOrderSync } from './sync-scheduler.ts';
import type { SyncAccount, SyncAccessPort, SyncLogger, SyncSchedulerDeps } from './sync-ports.ts';

const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const START = '2026-10-17T00:00:00.000Z';

function acct(id: string): SyncAccount {
  return { app_id: 'unit', platform: 'pdd', union_account_id: id, sync_start_at: START };
}

function setup(queryable?: SyncAccessPort['queryableAccount']) {
  const send = vi.fn<JobQueue['send']>().mockResolvedValue('job');
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const access: SyncAccessPort = {
    listEnabledAccounts: vi.fn().mockResolvedValue([acct(A), acct(B)]),
    siteAuthAvailable: vi.fn().mockResolvedValue(true),
    offlineCircuitOpen: vi.fn().mockResolvedValue(false),
    ...(queryable === undefined ? {} : { queryableAccount: queryable }),
  };
  const deps: SyncSchedulerDeps = {
    clock: new FixedClock('2026-10-17T02:00:00.000Z'),
    queue: { send },
    cursors: { read: vi.fn().mockResolvedValue(null), advance: vi.fn() },
    access,
    logger: logger as unknown as SyncLogger,
  };
  const sentAccounts = () =>
    send.mock.calls.map(
      ([, , payload]) => (payload as { union_account_id: string }).union_account_id,
    );
  return { deps, send, logger, sentAccounts };
}

it('[AC-B1-08g#u5] 端口给出可查询账号时只为该账号投递，其余同平台账号各 warn 一次', async () => {
  const queryable = vi.fn<NonNullable<SyncAccessPort['queryableAccount']>>().mockResolvedValue(A);
  const s = setup(queryable);
  await scheduleOrderSync(s.deps);
  expect(s.sentAccounts()).toEqual([A]);
  expect(queryable).toHaveBeenCalledExactlyOnceWith('pdd');
  expect(s.logger.warn).toHaveBeenCalledExactlyOnceWith(
    { platform: 'pdd', union_account_id: B, reason: 'not_queryable_account' },
    'order_sync_account_skipped',
  );
});

it('[AC-B1-08g#u6] 可查询账号为 null 时该平台一个窗口都不投', async () => {
  const s = setup(vi.fn().mockResolvedValue(null));
  await scheduleOrderSync(s.deps);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.logger.warn).toHaveBeenCalledTimes(2);
  expect(s.logger.warn.mock.calls.map(([f]) => (f as { reason: string }).reason)).toEqual([
    'no_queryable_account',
    'no_queryable_account',
  ]);
});

it('[AC-B1-08g#u7] 可查询账号不在启用列表中时不投任何账号', async () => {
  const s = setup(vi.fn().mockResolvedValue('10000000-0000-4000-8000-00000000000c'));
  await scheduleOrderSync(s.deps);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.logger.warn).toHaveBeenCalledTimes(2);
});

it('[AC-B1-08g#u8] 端口未提供 queryableAccount 时行为不变：每个启用账号各投一个窗口', async () => {
  const s = setup();
  await scheduleOrderSync(s.deps);
  expect(s.sentAccounts()).toEqual([A, B]);
  expect(s.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zt#u6] 起点要收紧而水位存储没有 rewind：打 warn，本轮不发窗', async () => {
  const { deps, send, logger } = setup();
  const stale = { ...acct(A), platform: 'jd' as const, sync_start_at: '2026-01-01T00:00:00.000Z' };
  vi.mocked(deps.access.listEnabledAccounts).mockResolvedValue([stale]);
  await scheduleOrderSync(deps);
  expect(send).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
    { platform: 'jd', account: A },
    'order_sync_start_clamp_unavailable',
  );
});
