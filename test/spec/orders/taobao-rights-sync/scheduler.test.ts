// 维权 / 违规的调度轮（规划/02 §7.1 淘宝行；任务书第 9 节第 3、4、6 条）：
// - 维权增量流 (platform, account, 'rights', '-')：每轮从水位起投一窗 'rights.window'，至多 3 小时、止于 now；
//   没有水位从账号 sync_start_at 起；singletonKey = platform:account:kind:scene:window_start（02 §7.1）。
// - 违规：每轮投一窗 'punish.window'，[now − 30 天, now)，不读不推水位。
// - 回扫流 (platform, account, 'rights', 'rescan')：每天走完近 60 天、3 小时一窗，水位独立，不动增量水位。
// - 门控同增量调度：可查账号（D10-36）、离线熔断、站点授权；按适配器有没有 listRefunds / listPunishments
//   判平台，orders 不比较平台名；没有来源的平台不投递。
import { expect, it } from 'vitest';
import {
  scheduleRightsRescan,
  scheduleRightsSync,
} from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import {
  DAY_MS,
  HOUR_MS,
  INCREMENT,
  NOW,
  NOW_MS,
  OTHER_ACCOUNT,
  PUNISH_JOB,
  QUEUE,
  RESCAN,
  RESCAN_DAYS,
  RIGHTS_JOB,
  SYNC_START,
  TAOBAO_ACCOUNT,
  WINDOW_MS,
  cursorKey,
  fixture,
  iso,
  jdAccount,
  pddAccount,
  punishWindow,
  rightsWindow,
  taobaoAccount,
} from './kit.ts';

it('[AC-B1-04zza#7] 每轮给可查的淘宝账号投一窗 rights.window：从水位起 3 小时，singletonKey 带全部维度', async () => {
  const cursor = iso(NOW_MS - 10 * HOUR_MS);
  const f = fixture({ cursors: { [INCREMENT]: cursor } });
  await scheduleRightsSync(f.scheduler);
  const rights = f.sent().filter((call) => call.name === RIGHTS_JOB);
  expect(rights).toEqual([
    {
      queue: QUEUE,
      name: RIGHTS_JOB,
      payload: rightsWindow(cursor),
      opts: expect.objectContaining({
        trx: null,
        singletonKey: `taobao:${TAOBAO_ACCOUNT}:rights:-:${cursor}`,
      }),
    },
  ]);
  // 调度只投递，不推水位。
  expect(f.rows.get(INCREMENT)).toBe(cursor);
});

it('[AC-B1-04zza#8] 水位离 now 不足 3 小时：窗口止于 now；水位已到 now：不投 rights.window，违规照投', async () => {
  const near = iso(NOW_MS - HOUR_MS);
  const f = fixture({ cursors: { [INCREMENT]: near } });
  await scheduleRightsSync(f.scheduler);
  expect(f.rightsOf('-')).toEqual([rightsWindow(near, { window_end: NOW })]);

  const caughtUp = fixture({ cursors: { [INCREMENT]: NOW } });
  await scheduleRightsSync(caughtUp.scheduler);
  expect(caughtUp.payloads(RIGHTS_JOB)).toEqual([]);
  expect(caughtUp.payloads(PUNISH_JOB)).toEqual([punishWindow()]);
});

it('[AC-B1-04zza#9] 没有水位从账号 sync_start_at 起；sync_start_at 也没有就不投维权窗、不抛错', async () => {
  const f = fixture();
  await scheduleRightsSync(f.scheduler);
  expect(f.rightsOf('-')).toEqual([rightsWindow(SYNC_START)]);

  const noStart = fixture({ accounts: [{ ...taobaoAccount, sync_start_at: null }] });
  await expect(scheduleRightsSync(noStart.scheduler)).resolves.toBeUndefined();
  expect(noStart.payloads(RIGHTS_JOB)).toEqual([]);
});

it('[AC-B1-04zza#10] 每轮投一窗 punish.window：[now − 30 天, now)，不读、不写 punish 水位', async () => {
  const f = fixture({ cursors: { [INCREMENT]: iso(NOW_MS - 10 * HOUR_MS) } });
  await scheduleRightsSync(f.scheduler);
  const punish = f.sent().filter((call) => call.name === PUNISH_JOB);
  expect(punish).toEqual([
    {
      queue: QUEUE,
      name: PUNISH_JOB,
      payload: punishWindow(),
      opts: expect.objectContaining({ trx: null }),
    },
  ]);
  expect(f.read.mock.calls.filter(([stream]) => stream.query_kind === 'punish')).toEqual([]);
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.rewind.mock.calls.filter(([stream]) => cursorKey(stream).includes(':punish:'))).toEqual(
    [],
  );
});

it('[AC-B1-04zza#11] 按能力判平台：适配器没有维权、违规方法或没有适配器的平台不投；有方法的平台照投，不看平台名', async () => {
  const f = fixture({
    accounts: [taobaoAccount, jdAccount, pddAccount],
    // 淘宝这里故意没有来源；京东的（合成）适配器有两种方法；拼多多没有适配器。
    capable: { taobao: 'none', jd: 'both', pdd: 'missing' },
  });
  await expect(scheduleRightsSync(f.scheduler)).resolves.toBeUndefined();
  expect(f.sent().map((call) => [call.name, call.payload['platform']])).toEqual(
    expect.arrayContaining([
      [RIGHTS_JOB, 'jd'],
      [PUNISH_JOB, 'jd'],
    ]),
  );
  expect(f.sent().every((call) => call.payload['platform'] === 'jd')).toBe(true);
  expect(f.sent()).toHaveLength(2);
});

it.each([
  ['只有 listRefunds', 'refunds', [RIGHTS_JOB]],
  ['只有 listPunishments', 'punishments', [PUNISH_JOB]],
] as const)('[AC-B1-04zza#12] %s 的平台只投对应的那一种窗', async (_name, capability, names) => {
  const f = fixture({ capable: { taobao: capability } });
  await scheduleRightsSync(f.scheduler);
  expect(f.sent().map((call) => call.name)).toEqual(names);
});

it.each([
  [
    '不是可查账号',
    (f: ReturnType<typeof fixture>) => f.queryableAccount.mockResolvedValue(OTHER_ACCOUNT),
  ],
  [
    '平台没有可查账号',
    (f: ReturnType<typeof fixture>) => f.queryableAccount.mockResolvedValue(null),
  ],
  ['离线熔断打开', (f: ReturnType<typeof fixture>) => f.offlineCircuitOpen.mockResolvedValue(true)],
  ['站点授权失效', (f: ReturnType<typeof fixture>) => f.siteAuthAvailable.mockResolvedValue(false)],
])('[AC-B1-04zza#13] %s：该账号维权、违规都不投，不抛错，不动水位', async (_name, gate) => {
  const f = fixture({ cursors: { [INCREMENT]: iso(NOW_MS - 10 * HOUR_MS) } });
  gate(f);
  await expect(scheduleRightsSync(f.scheduler)).resolves.toBeUndefined();
  await expect(scheduleRightsRescan(f.scheduler)).resolves.toBeUndefined();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.rewind).not.toHaveBeenCalled();
});

it('[AC-B1-04zza#14] 回扫是独立的流：scene rescan、3 小时一窗、从近 60 天的开头起，不投违规、不读不动增量水位', async () => {
  const increment = iso(NOW_MS - HOUR_MS);
  const f = fixture({ cursors: { [INCREMENT]: increment } });
  await scheduleRightsRescan(f.scheduler);
  expect(f.payloads(PUNISH_JOB)).toEqual([]);
  expect(f.rightsOf('-')).toEqual([]);
  const [win, ...rest] = f.rightsOf('rescan');
  expect(rest).toEqual([]);
  expect(win).toMatchObject({
    app_id: taobaoAccount.app_id,
    platform: 'taobao',
    union_account_id: TAOBAO_ACCOUNT,
    query_kind: 'rights',
    scene: 'rescan',
  });
  const start = Date.parse(String(win?.['window_start']));
  const end = Date.parse(String(win?.['window_end']));
  expect(end - start).toBe(WINDOW_MS);
  expect(start).toBeGreaterThanOrEqual(NOW_MS - RESCAN_DAYS * DAY_MS);
  expect(start).toBeLessThan(NOW_MS - (RESCAN_DAYS - 1) * DAY_MS);
  expect(f.rows.get(INCREMENT)).toBe(increment);
  expect(f.rewind.mock.calls.filter(([stream]) => stream.scene !== 'rescan')).toEqual([]);
  expect(f.send.mock.calls[0]?.[3]).toMatchObject({
    trx: null,
    singletonKey: `taobao:${TAOBAO_ACCOUNT}:rights:rescan:${String(win?.['window_start'])}`,
  });
});

it('[AC-B1-04zza#15] 回扫接着自己的水位往后：上一窗推进后，下一跳从上一窗的终点起', async () => {
  const f = fixture({ cursors: { [INCREMENT]: iso(NOW_MS - HOUR_MS) } });
  await scheduleRightsRescan(f.scheduler);
  const first = f.rightsOf('rescan')[0];
  expect(first).toBeDefined();
  // 处理器做完这一窗后推进回扫水位（同 infra/sync-cursors.ts 的 CAS）。
  expect(await f.advance(first as Parameters<typeof f.advance>[0])).toBe(true);
  await scheduleRightsRescan(f.scheduler);
  const second = f.rightsOf('rescan')[1];
  expect(second?.['window_start']).toBe(first?.['window_end']);
  expect(f.rows.get(RESCAN)).toBe(first?.['window_end']);
});

it('[AC-B1-04zza#16] 回扫走到 now 附近后从近 60 天的开头再来一遍，窗口从不越过 now', async () => {
  const f = fixture({
    cursors: { [INCREMENT]: iso(NOW_MS - HOUR_MS), [RESCAN]: iso(NOW_MS - HOUR_MS) },
  });
  await scheduleRightsRescan(f.scheduler);
  await scheduleRightsRescan(f.scheduler);
  const windows = f.rightsOf('rescan');
  expect(windows.length).toBeGreaterThanOrEqual(1);
  for (const win of windows) {
    expect(Date.parse(String(win['window_end']))).toBeLessThanOrEqual(NOW_MS);
  }
  const last = windows.at(-1);
  const start = Date.parse(String(last?.['window_start']));
  expect(start).toBeGreaterThanOrEqual(NOW_MS - RESCAN_DAYS * DAY_MS);
  expect(start).toBeLessThan(NOW_MS - (RESCAN_DAYS - 1) * DAY_MS);
});
