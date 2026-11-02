import { afterEach, expect, it } from 'vitest';
import { readTaobaoSearchSlot } from '../../../../apps/api/src/modules/union/pids/taobao-search-slot.ts';
import { APP, OTHER_APP, equality, pidRow, type PidRow } from '../taobao-dataoke-switches/kit.ts';
import { slotDatabase } from './slot-database.ts';

// 官方搜索的推广位（D10-582、BR-PROD-07）：取该 App 的 query 场景 active 推广位，检索固定用它。
// 一条只读 SELECT，不缓存；别的 App、平台、场景、状态都不顶替；多账号按 union_account_id 取第一条。

const PID = 'mm_1000000001_3000000001_987654321012';
const OTHER_PID = 'mm_1000000002_3000000002_111222333';
const FIRST_ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const SECOND_ACCOUNT = '00000000-0000-4000-8000-0000000000b2';

const databases: ReturnType<typeof slotDatabase>[] = [];

function database(...rows: Parameters<typeof slotDatabase>) {
  const created = slotDatabase(...rows);
  databases.push(created);
  return created;
}

/** An active query PID row of the calling app, unless overridden. */
function queryRow(overrides: Partial<PidRow> = {}): PidRow {
  return pidRow({ pid: PID, pid_scene: 'query', ...overrides });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((created) => created.db.destroy()));
});

it('[AC-B1-04zx#50] 读到调用方 App 的淘宝 query active 推广位：一条 SELECT，绑定 app_id / taobao / query / active', async () => {
  const { db, statements } = database([queryRow()]);
  expect(await readTaobaoSearchSlot(db, APP)).toBe(PID);
  expect(statements).toHaveLength(1);
  const statement = statements[0]!;
  expect(equality(statement, 'app_id')).toBe(APP);
  expect(equality(statement, 'platform')).toBe('taobao');
  expect(equality(statement, 'pid_scene')).toBe('query');
  expect(equality(statement, 'status')).toBe('active');
});

it.each([
  ['别的 App', { app_id: OTHER_APP }],
  ['别的平台', { platform: 'pdd', site_id: null }],
  ['自购场景', { pid_scene: 'self_buy' }],
  ['分享场景', { pid_scene: 'share' }],
  ['pending', { status: 'pending' }],
  ['retired', { status: 'retired' }],
] as [string, Partial<PidRow>][])(
  '[AC-B1-04zx#51] 只有%s的推广位 → null，不用它顶替',
  async (_label, overrides) => {
    const { db } = database([queryRow(overrides)]);
    expect(await readTaobaoSearchSlot(db, APP)).toBeNull();
  },
);

it('[AC-B1-04zx#52] 不缓存：每次调用重查，退役立即生效', async () => {
  const fake = database([queryRow()]);
  expect(await readTaobaoSearchSlot(fake.db, APP)).toBe(PID);
  fake.replace([queryRow({ status: 'retired' })]);
  expect(await readTaobaoSearchSlot(fake.db, APP)).toBeNull();
  expect(fake.statements).toHaveLength(2);
});

it.each([
  ['靠后的账号先入库', [SECOND_ACCOUNT, FIRST_ACCOUNT]],
  ['靠前的账号先入库', [FIRST_ACCOUNT, SECOND_ACCOUNT]],
] as [string, string[]][])(
  '[AC-B1-04zx#53] 多个账号各有一条 query active 推广位（%s）→ 按 union_account_id 升序取第一条，结果稳定',
  async (_label, accounts) => {
    const pidOf = (account: string) => (account === FIRST_ACCOUNT ? PID : OTHER_PID);
    const { db, statements } = database(
      accounts.map((account) => queryRow({ pid: pidOf(account), union_account_id: account })),
    );
    expect(await readTaobaoSearchSlot(db, APP)).toBe(PID);
    expect(await readTaobaoSearchSlot(db, APP)).toBe(PID);
    expect(statements).toHaveLength(2);
  },
);
