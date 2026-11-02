import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { seedAdmin } from '../export-worker/kit.ts';
import { insertState, useDatabase } from './kit.ts';

// D10-552, task §9 item 1: the actor columns after the migration. Refusals are compared by
// SQLSTATE; before the migration every write answers another state, an assertion failure.
const h = useDatabase(createTestDatabase);
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const appIdOf = () => `b1-34p-${randomUUID()}`;

it('[AC-B1-34p#1] admin_id 可空，system_actor 是可空文本列', async () => {
  const { rows } = await sql<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>`select column_name, data_type, is_nullable from information_schema.columns
    where table_schema = 'app' and table_name = 'audit_logs'
      and column_name in ('admin_id', 'system_actor')
    order by column_name`.execute(h.db());
  expect(rows).toEqual([
    { column_name: 'admin_id', data_type: 'uuid', is_nullable: 'YES' },
    { column_name: 'system_actor', data_type: 'text', is_nullable: 'YES' },
  ]);
});

it('[AC-B1-34p#1] 系统行（只有 system_actor）与后台账号行（只有 admin_id）都能写入', async () => {
  const appId = appIdOf();
  const admin = await seedAdmin(h.db(), appId);
  expect(await insertState(h.db(), appId, null, 'system:risk')).toBe('accepted');
  expect(await insertState(h.db(), appId, admin.id, null)).toBe('accepted');
});

it('[AC-B1-34p#1] admin_id 与 system_actor 都空被 CHECK 拒绝', async () => {
  expect(await insertState(h.db(), appIdOf(), null, null)).toBe(CHECK_VIOLATION);
});

it('[AC-B1-34p#1] admin_id 与 system_actor 都有被 CHECK 拒绝', async () => {
  const appId = appIdOf();
  const admin = await seedAdmin(h.db(), appId);
  expect(await insertState(h.db(), appId, admin.id, 'system:risk')).toBe(CHECK_VIOLATION);
});

it.each([
  '',
  'risk',
  'system',
  'system:',
  'System:risk',
  'SYSTEM:RISK',
  'system:Risk',
  'system:risk1',
  'system:risk-engine',
  'system:risk:hold',
  'system: risk',
  ' system:risk',
  'system:risk ',
  'system:risk\n',
  'xsystem:risk',
  'system:风控',
])('[AC-B1-34p#1] system_actor=%j 不符合 ^system:[a-z_]+$ 被拒绝', async (systemActor) => {
  expect(await insertState(h.db(), appIdOf(), null, systemActor)).toBe(CHECK_VIOLATION);
});

it.each(['system:risk', 'system:a', 'system:new_engine', 'system:_'])(
  '[AC-B1-34p#1] system_actor=%j 符合格式，能写入',
  async (systemActor) => {
    expect(await insertState(h.db(), appIdOf(), null, systemActor)).toBe('accepted');
  },
);

it('[AC-B1-34p#1] 后台账号行的外键照旧生效：未知账号、他 app 的账号都被拒绝', async () => {
  const appId = appIdOf();
  const foreign = await seedAdmin(h.db(), appIdOf());
  for (const adminId of [randomUUID(), foreign.id]) {
    expect(await insertState(h.db(), appId, adminId, null)).toBe(FOREIGN_KEY_VIOLATION);
  }
});
