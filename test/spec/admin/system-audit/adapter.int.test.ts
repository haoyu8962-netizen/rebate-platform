import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { createOrderHoldAuditReader } from '../../../../apps/api/src/modules/admin/application/order-hold-audits.ts';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createRebatePort,
  type RebatePort,
} from '../../../../apps/api/src/modules/settlement/index.ts';
import { seedAdmin } from '../export-worker/kit.ts';
import {
  fixture as orderFixture,
  type Fixture as OrderFixture,
} from '../../settlement/rebate/kit.ts';
import {
  appendHold,
  AUTO_HOLD,
  expectHoldSnapshot,
  holdAudit,
  stored,
  SYSTEM_RISK,
  systemAudit,
  UNMAPPED,
  useDatabase,
} from './kit.ts';

// D10-551 ②, D10-552, task §9 items 2 and 3. Everything runs on createDb's single-bound handle.
const h = useDatabase(createTestDatabase);
const AT = '2026-10-08T03:00:00.123Z';
const appIdOf = () => `b1-34p-${randomUUID()}`;

it('[AC-B1-34p#2] 写入一行：system:risk、admin_id 空、order_auto_hold、orders:<id>、ip 空、before/after 是 hold 与原因码', async () => {
  const db = h.db();
  const appId = appIdOf();
  const writer = await systemAudit(new FixedClock(AT));
  const input = holdAudit(appId);
  await db.transaction().execute((trx) => writer.append(trx, input));
  const rows = await stored(db, appId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: appId,
    admin_id: null,
    system_actor: SYSTEM_RISK,
    action: AUTO_HOLD,
    target: `orders:${input.orderId}`,
    ip: null,
  });
  expectHoldSnapshot(rows[0]!.before, false, null);
  expectHoldSnapshot(rows[0]!.after, true, UNMAPPED);
});

it('[AC-B1-34p#2] at 每次读注入的 Clock，入参的 at 不算；before 带上原有原因码', async () => {
  const db = h.db();
  const appId = appIdOf();
  const clock = new FixedClock(AT);
  const writer = await systemAudit(clock);
  await db.transaction().execute((trx) => writer.append(trx, holdAudit(appId)));
  const first = clock.now();
  clock.advanceMs(12_345);
  const held = holdAudit(appId, randomUUID(), 'RISK');
  await db.transaction().execute((trx) => writer.append(trx, held));
  const rows = await stored(db, appId);
  expect(rows.map((row) => row.at)).toEqual([first, clock.now()]);
  expectHoldSnapshot(rows[1]!.before, false, 'RISK');
});

it('[AC-B1-34p#2] 随调用方事务提交：提交前只有本事务看得到，提交后恰好一行', async () => {
  const db = h.db();
  const appId = appIdOf();
  const writer = await systemAudit(new FixedClock(AT));
  await db.transaction().execute(async (trx) => {
    await writer.append(trx, holdAudit(appId));
    expect(await stored(trx, appId)).toHaveLength(1);
    // Another connection: a row visible here was committed on a transaction of its own.
    expect(await stored(db, appId)).toEqual([]);
  });
  expect(await stored(db, appId)).toHaveLength(1);
});

it('[AC-B1-34p#2] 调用方回滚后审计行也没有', async () => {
  const db = h.db();
  const appId = appIdOf();
  const writer = await systemAudit(new FixedClock(AT));
  const rollback = new Error('the caller gives up');
  await expect(
    db.transaction().execute(async (trx) => {
      await writer.append(trx, holdAudit(appId));
      expect(await stored(trx, appId)).toHaveLength(1);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await stored(db, appId)).toEqual([]);
});

/** The real rebate port with only the audit port replaced by the real adapter. */
async function realPort(f: OrderFixture): Promise<RebatePort> {
  return createRebatePort({ ...f.deps, audit: await systemAudit(f.clock) });
}

function unmappedHold(f: OrderFixture, port: RebatePort, trx: Transaction<DB>) {
  return port.onUnmappedStatus(
    trx,
    {
      app_id: f.appId,
      order_id: f.orderId,
      attr_at: f.attrAt,
      rebate_status: f.initial.rebate_status,
    },
    { event: null, raw_status: 'synthetic-unmapped' },
  );
}

it.each(['ESTIMATED', 'WAITING'])(
  '[AC-B1-34p#2] 接到真实 rebate 端口：%s 订单系统 hold 与审计同事务提交',
  async (state) => {
    const db = h.db();
    const f = await orderFixture(db, { rebate_status: state });
    const port = await realPort(f);
    await f.run((trx) => unmappedHold(f, port, trx));
    expect(await f.read()).toMatchObject({ hold: true, hold_reason: UNMAPPED });
    const rows = await stored(db, f.appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      admin_id: null,
      system_actor: SYSTEM_RISK,
      action: AUTO_HOLD,
      target: `orders:${f.orderId}`,
      ip: null,
      at: f.clock.now(),
    });
    expectHoldSnapshot(rows[0]!.before, false, null);
    expectHoldSnapshot(rows[0]!.after, true, UNMAPPED);
  },
);

it('[AC-B1-34p#2] 接到真实 rebate 端口：调用方回滚后 hold、状态历史与审计行都没有', async () => {
  const db = h.db();
  const f = await orderFixture(db, { rebate_status: 'ESTIMATED' });
  const port = await realPort(f);
  const rollback = new Error('the caller gives up');
  await expect(
    f.run(async (trx) => {
      await unmappedHold(f, port, trx);
      expect(await stored(trx, f.appId)).toHaveLength(1);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await f.read()).toEqual(f.initial);
  expect(await f.history()).toEqual([]);
  expect(await stored(db, f.appId)).toEqual([]);
});

it('[AC-B1-34p#3] 订单只有系统 hold 时 latestHold 为 null', async () => {
  const db = h.db();
  const appId = appIdOf();
  const orderId = await appendHold(db, new FixedClock(AT), appId);
  expect(await stored(db, appId)).toHaveLength(1);
  expect(await createOrderHoldAuditReader(db).latestHold(appId, orderId)).toBeNull();
});

it('[AC-B1-34p#3] 系统行比人工 hold 新时 latestHold 仍是人工那一行', async () => {
  const db = h.db();
  const appId = appIdOf();
  const orderId = randomUUID();
  const admin = await seedAdmin(db, appId);
  const clock = new FixedClock(AT);
  await createAuditWriter({ db, clock }).append({
    appId,
    actor: admin.id,
    action: 'order_hold',
    target: `orders:${orderId}`,
    before: { hold: false, hold_reason: null },
    after: { hold: true, hold_reason: 'RISK', reason_code: 'RISK', note: '人工暂停' },
    ip: null,
  });
  const manualAt = clock.now();
  clock.advanceMs(60_000);
  await appendHold(db, clock, appId, orderId);
  expect(await stored(db, appId)).toHaveLength(2);
  expect(await createOrderHoldAuditReader(db).latestHold(appId, orderId)).toEqual({
    admin_id: admin.id,
    note: '人工暂停',
    at: manualAt,
  });
});
