// CT-24zzm · 创建余额流水导出（规划/08 BR-ID-42；04 §11.1；契约 adminCreateExport 加 resource=ledger，
// filters 同 adminListLedgerEntries 去分页；D10-1740 / D10-1742）。经真实 admin 入口：在本任务之前
// 路由 schema 按 resource 拒绝 ledger（20001），所以每条拒绝用例最后都以一次合法创建收尾，分支打开前
// 必红且红在断言上。
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { grant } from '../accounts/kit.ts';
import { ok, type View } from '../exports/kit.ts';
import {
  books,
  denied,
  EXPORT,
  filtersRefused,
  harness,
  ledgerBody,
  LOOKUP,
  openConsole,
  PII_POINTS,
  shapeRefused,
  untouched,
  VIEW,
  type Console,
} from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

/** A user of the console's app (a users row and an open balance account). */
async function target(f: Console) {
  return (await books(h, f.appId).member()).userId;
}

/** The valid create every refusal ends with: red until the ledger branch is open. */
async function createsAfterwards(f: Console, userId: string) {
  const view = await ok<View>(await f.create(ledgerBody({ user_id: userId })));
  expect(view).toMatchObject({ resource: 'ledger', masked: true, status: 'pending' });
}

it('[AC-CT-24zzm#7] export + fund.view 建 ledger 导出：202 pending、恒脱敏，存下原样 filters，generate 在创建事务内入队，审计 export_create', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const userId = await target(f);
  const filters = {
    user_id: userId,
    ledger_type: 'REBATE_CREDIT',
    sub_account: 'available',
    accounting_date_from: '2026-10-01',
    accounting_date_to: '2026-10-09',
  };
  const view = await ok<View>(await f.create(ledgerBody(filters)));
  expect(view).toMatchObject({
    resource: 'ledger',
    masked: true,
    status: 'pending',
    progress: null,
    failure_reason: null,
    file_name: null,
    row_count: null,
    expires_at: null,
    created_by: f.actor.id,
  });
  expect(view.filters_summary.length).toBeGreaterThan(0);
  expect(view.filters_summary).toContain(userId);
  const [row] = await f.tasks();
  expect(row).toMatchObject({
    public_id: view.id,
    resource: 'ledger',
    masked: true,
    filters,
    status: 'pending',
  });
  expect(f.send.mock.calls.filter(([queue]) => queue === 'export')).toEqual([
    [
      'export',
      'generate',
      { appId: f.appId, taskId: row!.id },
      expect.objectContaining({ trx: expect.anything() }),
    ],
  ]);
  const audits = await f.audits();
  expect(audits.map((audit) => audit.action)).toEqual(['export_create']);
  expect(audits[0]).toMatchObject({
    admin_id: f.actor.id,
    after: expect.objectContaining({
      task_id: view.id,
      resource: 'ledger',
      filters,
      masked: true,
    }),
  });
});

it.each([
  [[EXPORT, LOOKUP], false],
  [[EXPORT, VIEW, LOOKUP], false],
  [[], true],
] as const)(
  '[AC-CT-24zzm#8] 来源列表的读权限 fund.view 或 user.lookup 任一即可（持 %j，超管 %s）',
  async (points, isSuper) => {
    const f = await openConsole(h, points, isSuper);
    const userId = await target(f);
    const view = await ok<View>(await f.create(ledgerBody({ user_id: userId })));
    expect(view).toMatchObject({ resource: 'ledger', masked: true, status: 'pending' });
    expect(await f.tasks()).toHaveLength(1);
  },
);

it.each([
  [[]],
  [[EXPORT]],
  [[VIEW]],
  [[LOOKUP]],
  [[VIEW, LOOKUP]],
  [[EXPORT, 'user.list']],
  [[EXPORT, 'audit.view_all']],
  [[EXPORT, ...PII_POINTS]],
  [['tax.export_full', VIEW]],
  [['tax.export_full', LOOKUP]],
] as const)(
  '[AC-CT-24zzm#9] 缺 export 或缺两个读权限点（只持 %j）→ 10403，不建任务、不审计、不入队；补齐后可建',
  async (points) => {
    const f = await openConsole(h, points);
    const userId = await target(f);
    await denied(await f.create(ledgerBody({ user_id: userId })));
    await untouched(f);
    const missing = [EXPORT, VIEW].filter(
      (point) => !(points as readonly string[]).includes(point),
    );
    await grant(h, f.actor, f.actor, missing);
    await createsAfterwards(f, userId);
  },
);

type Filters = (userId: string) => Record<string, string>;

it.each<[string, Filters]>([
  ['缺 user_id', () => ({ ledger_type: 'REBATE_CREDIT' })],
  ['user_id 不是 UUID', () => ({ user_id: 'not-a-uuid' })],
  ['ledger_type 不在枚举', (u) => ({ user_id: u, ledger_type: 'NOT_A_TYPE' })],
  ['sub_account 不在枚举', (u) => ({ user_id: u, sub_account: 'locked' })],
  ['accounting_date_from 不是日期', (u) => ({ user_id: u, accounting_date_from: '2026/10/01' })],
  [
    'accounting_date_to 是时刻不是日期',
    (u) => ({ user_id: u, accounting_date_to: '2026-10-09T00:00:00+08:00' }),
  ],
  ['sub_type 为空', (u) => ({ user_id: u, sub_type: '' })],
  ['ref 为空', (u) => ({ user_id: u, ref: '' })],
  ['ref 超 128', (u) => ({ user_id: u, ref: 'r'.repeat(129) })],
  ['分页参数不是筛选', (u) => ({ user_id: u, page_size: '200' })],
  ['别的来源的筛选', (u) => ({ user_id: u, risk_state: 'frozen' })],
])(
  '[AC-CT-24zzm#10] filters 按列表的查询参数判：%s → 20001，无副作用；合法后可建',
  async (_case, filtersOf) => {
    const f = await openConsole(h, [EXPORT, VIEW]);
    const userId = await target(f);
    await shapeRefused(await f.create(ledgerBody(filtersOf(userId))));
    await untouched(f);
    await createsAfterwards(f, userId);
  },
);

it('[AC-CT-24zzm#11] 会计日起晚于止 → 20001 [accounting_date_from, accounting_date_to]，同列表；起止同日可建', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const userId = await target(f);
  await filtersRefused(
    await f.create(
      ledgerBody({
        user_id: userId,
        accounting_date_from: '2026-10-09',
        accounting_date_to: '2026-10-08',
      }),
    ),
    ['accounting_date_from', 'accounting_date_to'],
  );
  await untouched(f);
  const view = await ok<View>(
    await f.create(
      ledgerBody({
        user_id: userId,
        accounting_date_from: '2026-10-08',
        accounting_date_to: '2026-10-08',
      }),
    ),
  );
  expect(view.resource).toBe('ledger');
});

it.each([
  ['unmasked: true', { unmasked: true }],
  ['unmasked + reason', { unmasked: true, reason: '核对用户流水' }],
  ['只带 reason', { reason: '核对用户流水' }],
] as const)(
  '[AC-CT-24zzm#12] 流水没有 pii 列：ledger 不收 %s（即使持 pii.* 且带 totp 令牌）→ 20001，无副作用；恒脱敏版可建',
  async (_case, extra) => {
    const f = await openConsole(h, [EXPORT, VIEW, ...PII_POINTS]);
    const userId = await target(f);
    const token = await f.token();
    await shapeRefused(await f.create({ ...ledgerBody({ user_id: userId }), ...extra }, token));
    await untouched(f);
    const view = await ok<View>(await f.create(ledgerBody({ user_id: userId }), token));
    expect(view).toMatchObject({ resource: 'ledger', masked: true });
    expect((await f.audits()).map((audit) => audit.action)).toEqual(['export_create']);
  },
);
