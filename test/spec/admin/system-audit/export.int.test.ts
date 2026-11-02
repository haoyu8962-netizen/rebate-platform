import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { csv, fixture, parseCsv, START, type Fixture } from '../export-worker/kit.ts';
import { appendHold, AUTO_HOLD, SYSTEM_RISK_NAME, useDatabase } from './kit.ts';

// Contract CT-24zj, enum export_resource audit_logs, task §9 item 6. The real export worker reads
// the real audit reader; the rows it walks are written by the real adapter.
const h = useDatabase(createTestDatabase);
const HEADER = [
  'id',
  'actor_id',
  'actor_name',
  'action',
  'target_type',
  'target_id',
  'permission',
  'ip',
  'at',
];

/** The finished CSV of an audit_logs export by the fixture's admin, header first. */
async function exported(f: Fixture, filters: Record<string, string> = {}) {
  const worker = await f.worker();
  const task = await f.task({ resource: 'audit_logs', filters });
  await worker.handle(f.job(task.id));
  expect(await f.read(task.id)).toMatchObject({ status: 'done' });
  return parseCsv(await csv(f, task.id));
}

function rowOf(rows: string[][], action: string) {
  const found = rows.find((row) => row[3] === action);
  expect(found).toBeDefined();
  return found!.slice(1);
}

async function grantViewAll(f: Fixture) {
  await f.db
    .insertInto('admin_permissions')
    .values({
      app_id: f.appId,
      admin_id: f.admin.id,
      permission_key: 'audit.view_all',
      granted_by: f.admin.id,
      granted_at: START,
    })
    .execute();
}

it('[AC-B1-34p#6] 超管导出：列不变，系统行 actor_id 空、actor_name 中文名，后台账号行不变', async () => {
  const f = await fixture(h.db(), { isSuper: true });
  const orderId = await appendHold(f.db, f.clock, f.appId);
  await f.audit(f.admin.id, 'admin.login', `admin_users:${f.admin.id}`);
  const rows = await exported(f);
  expect(rows[0]).toEqual(HEADER);
  expect(rows).toHaveLength(3);
  expect(rowOf(rows, AUTO_HOLD)).toEqual([
    '',
    SYSTEM_RISK_NAME,
    AUTO_HOLD,
    'order',
    orderId,
    '',
    '',
    START,
  ]);
  expect(rowOf(rows, 'admin.login')).toEqual([
    f.admin.id,
    f.admin.display_name,
    'admin.login',
    'admin_user',
    f.admin.id,
    '',
    '',
    START,
  ]);
});

it('[AC-B1-34p#6] 勾选 audit.view_all 的账号导出含系统行，actor_id 过滤不含', async () => {
  const f = await fixture(h.db());
  await grantViewAll(f);
  const orderId = await appendHold(f.db, f.clock, f.appId);
  const rows = await exported(f);
  expect(rows).toHaveLength(2);
  expect(rowOf(rows, AUTO_HOLD)).toContain(orderId);
  expect(await exported(f, { actor_id: f.admin.id })).toEqual([HEADER]);
  expect(await exported(f, { target_id: orderId })).toHaveLength(2);
});

it('[AC-B1-34p#6] 没有 audit.view_all 的导出不含系统行，按对象筛选也不含', async () => {
  const f = await fixture(h.db());
  const orderId = await appendHold(f.db, f.clock, f.appId);
  await f.audit(f.admin.id, 'admin.login', `admin_users:${f.admin.id}`);
  const rows = await exported(f);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(HEADER);
  expect(rows[1]![3]).toBe('admin.login');
  expect(JSON.stringify(rows)).not.toContain(SYSTEM_RISK_NAME);
  expect(await exported(f, { target_id: orderId })).toEqual([HEADER]);
});
