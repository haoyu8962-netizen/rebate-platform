// B2-09n CAS rule tests (claude-independent, SPEC_REF 6f50a051): 08 BR-WDR-11, BR-WDR-12, 编排裁定 D10-609 —
// a withdrawal is written onto the batch only while status = APPROVED and batch_id is null; another
// transaction's batch_id is never overwritten. Real createPayoutExecute on a real PostgreSQL (../execute/kit.ts).
//
// Two kinds of deterministic interleaving, no timing:
// - A lock fence with two real transactions (`fenced`): the writer holds the row, EXECUTE is seen waiting on
//   it, the writer commits. EXECUTE then judges the row as the writer left it, and its unlocked first read,
//   which still says null, must not decide anything.
// - A write between the judgement and the CAS. No other transaction can get there: EXECUTE holds the row
//   FOR UPDATE from the judgement to its commit, so a real writer waits. So the batch store is wrapped and the
//   write runs on EXECUTE's own transaction right after its batch row, past ③, before any write to a
//   withdrawal: the only way to reach the predicates themselves. A write without `batch_id IS NULL` overwrites
//   the batch in #28, one without `status = APPROVED` puts a PAYING row on the batch in #29.
//
// Every test also has a stayer that does go onto the batch, so the case is not satisfied by writing nothing.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createPayoutExecute,
  type PayoutExecute,
} from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';
import { createPayoutBatchesStore } from '../../../../apps/api/src/modules/payout/infra/payout-batches-store.ts';
import {
  HOUR,
  MINUTE,
  NOW,
  SYSTEM,
  TIMEOUT,
  batches,
  close,
  executed,
  expectPaying,
  expectUntouched,
  fenced,
  items,
  jobs,
  open,
  setup,
  withdrawal,
  type ExecuteFixture,
  type Harness,
} from '../execute/kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

interface Line {
  batch_id: string;
  withdrawal_id: string;
  result: string;
  reason: string | null;
  moved_to_batch_id: string | null;
}

function line(
  batchId: string,
  withdrawalId: string,
  result: string,
  reason: string | null = null,
  movedTo: string | null = null,
): Line {
  return {
    batch_id: batchId,
    withdrawal_id: withdrawalId,
    result,
    reason,
    moved_to_batch_id: movedTo,
  };
}

/** Exactly these items of the app, in any order. */
async function expectLines(f: ExecuteFixture, want: readonly Line[]): Promise<void> {
  const all = await items(f);
  expect(all).toHaveLength(want.length);
  expect(all).toEqual(expect.arrayContaining([...want]));
}

/** Another writer puts the row on `batchId`: one row must move. */
async function putOnBatch(
  trx: Transaction<DB>,
  f: ExecuteFixture,
  id: string,
  batchId: string,
): Promise<void> {
  const moved = await sql`UPDATE app.withdrawals
    SET batch_id = ${batchId}, row_version = row_version + 1, updated_at = ${NOW}
    WHERE app_id = ${f.appId} AND id = ${id} AND status = 'APPROVED' AND batch_id IS NULL`.execute(
    trx,
  );
  expect(moved.numAffectedRows, `withdrawal ${id} put on a batch`).toBe(1n);
}

/** Another writer executes the row in `batchId` (null: on no batch): one row must move. */
async function moveToPaying(
  trx: Transaction<DB>,
  f: ExecuteFixture,
  id: string,
  batchId: string | null,
): Promise<void> {
  const moved = await sql`UPDATE app.withdrawals
    SET status = 'PAYING', execute_seq = execute_seq + 1, executed_at = ${NOW}, batch_id = ${batchId},
      row_version = row_version + 1, updated_at = ${NOW}
    WHERE app_id = ${f.appId} AND id = ${id} AND status = 'APPROVED'`.execute(trx);
  expect(moved.numAffectedRows, `withdrawal ${id} moved to PAYING`).toBe(1n);
}

/** EXECUTE whose batch store runs `during` on its transaction right after the batch row. */
function interrupted(
  f: ExecuteFixture,
  during: (trx: Transaction<DB>) => Promise<void>,
): PayoutExecute {
  const real = createPayoutBatchesStore();
  return createPayoutExecute({
    ...f.options,
    batches: {
      async insertBatch(trx, batch) {
        await real.insertBatch(trx, batch);
        await during(trx);
      },
      insertItems: (trx, rows) => real.insertItems(trx, rows),
    },
  });
}

it('[AC-B2-09n#26] 两个事务（锁栅栏）：两个管理员同时把同一张从没挂过批次的单组批次、都 channel_disabled：后者等到前者提交，看到的是前者刚写的 batch_id → 改挂后者的批次，前者的批次记 moved_out，不是当作 null 覆盖；row_version 加 2', async () => {
  const f = await setup(h);
  const service = f.execute();
  await f.set('payout.channel_enabled.bank_card', false);
  const id = await f.seedWithdrawal({ channel: 'bank_card' });
  const seeded = await withdrawal(f, id);

  const run = await fenced(
    h,
    { db: h.db, body: f.body(service, [id]) },
    { db: h.observer, body: f.body(service, [id], { executorId: randomUUID() }) },
  );

  const first = executed(run.first);
  const second = executed(run.second);
  expect(first.left).toEqual([{ id, reason: 'channel_disabled' }]);
  expect(second.left).toEqual([{ id, reason: 'channel_disabled' }]);
  expect(second.batchId).not.toBe(first.batchId);
  expect(await withdrawal(f, id)).toMatchObject({
    status: 'APPROVED',
    execute_seq: 0,
    batch_id: second.batchId,
    row_version: seeded.row_version + 2,
    updated_at: NOW,
  });
  await expectLines(f, [
    line(first.batchId, id, 'blocked', 'channel_disabled'),
    line(first.batchId, id, 'moved_out', null, second.batchId),
    line(second.batchId, id, 'blocked', 'channel_disabled'),
  ]);
  expect(await jobs(f)).toEqual([]);
});

it('[AC-B2-09n#27] 两个事务（锁栅栏）：执行等行锁时别的事务写了 batch_id：② 留下的（channel_disabled）按已挂别批改挂、原批次记 moved_out（规则 5）；同批没人动过的单挂上本批', async () => {
  const f = await setup(h);
  const service = f.execute();
  await f.set('payout.channel_enabled.bank_card', false);
  const elsewhere = await f.seedBatch('auto');
  const taken = await f.seedWithdrawal({ channel: 'bank_card' });
  const stayer = await f.seedWithdrawal({ channel: 'bank_card' });
  const seeded = await withdrawal(f, taken);

  const run = await fenced(
    h,
    {
      db: h.db,
      body: (trx: Transaction<DB>) => putOnBatch(trx, f, taken, elsewhere),
    },
    { db: h.observer, body: f.body(service, [taken, stayer]) },
  );

  const answer = executed(run.second);
  expect(await withdrawal(f, taken)).toMatchObject({
    batch_id: answer.batchId,
    row_version: seeded.row_version + 2,
  });
  await expectLines(f, [
    line(elsewhere, taken, 'moved_out', null, answer.batchId),
    line(answer.batchId, taken, 'blocked', 'channel_disabled'),
    line(answer.batchId, stayer, 'blocked', 'channel_disabled'),
  ]);
  expect((await withdrawal(f, stayer)).batch_id).toBe(answer.batchId);
});

it('[AC-B2-09n#28] 判定和写之间 batch_id 被写了（CAS 的 batch_id IS NULL）：不覆盖，batch_id 是别人写的、row_version 只有别人那一次，没有 moved_out；同批另一单挂上本批', async () => {
  const f = await setup(h);
  await f.set('payout.channel_enabled.bank_card', false);
  const elsewhere = await f.seedBatch('auto');
  const taken = await f.seedWithdrawal({ channel: 'bank_card' });
  const stayer = await f.seedWithdrawal({ channel: 'bank_card' });
  const seeded = await withdrawal(f, taken);
  let during = 0;
  const service = interrupted(f, async (trx) => {
    during += 1;
    await putOnBatch(trx, f, taken, elsewhere);
  });

  const answer = executed(await f.run(service, [taken, stayer]));

  expect(during).toBe(1);
  expect(await withdrawal(f, taken)).toMatchObject({
    status: 'APPROVED',
    batch_id: elsewhere,
    row_version: seeded.row_version + 1,
  });
  expect((await items(f)).filter((row) => row.result === 'moved_out')).toEqual([]);
  expect(await jobs(f)).toEqual([]);
  expect((await withdrawal(f, stayer)).batch_id).toBe(answer.batchId);
});

it('[AC-B2-09n#29] 判定和写之间状态变了（CAS 的 status = APPROVED）：PAYING 的单不挂，batch_id 仍是 null、row_version 只有别人那一次；同批另一单挂上本批', async () => {
  const f = await setup(h);
  await f.set('payout.channel_enabled.bank_card', false);
  const taken = await f.seedWithdrawal({ channel: 'bank_card' });
  const stayer = await f.seedWithdrawal({ channel: 'bank_card' });
  const seeded = await withdrawal(f, taken);
  let during = 0;
  const service = interrupted(f, async (trx) => {
    during += 1;
    await moveToPaying(trx, f, taken, null);
  });

  const answer = executed(await f.run(service, [taken, stayer]));

  expect(during).toBe(1);
  expect(await withdrawal(f, taken)).toMatchObject({
    status: 'PAYING',
    batch_id: null,
    row_version: seeded.row_version + 1,
  });
  expect((await withdrawal(f, stayer)).batch_id).toBe(answer.batchId);
});

it('[AC-B2-09n#30] 两个事务（锁栅栏）：执行等行锁时别的事务把这一单打到别的批次上（PAYING）：not_approved，batch_id 仍是那个批次，row_version 只有别人那一次，那个批次没有 moved_out；同批另一单挂上本批', async () => {
  const f = await setup(h);
  const service = f.execute();
  await f.set('payout.channel_enabled.bank_card', false);
  const elsewhere = await f.seedBatch('auto');
  const taken = await f.seedWithdrawal({ channel: 'bank_card' });
  const stayer = await f.seedWithdrawal({ channel: 'bank_card' });
  const seeded = await withdrawal(f, taken);

  const run = await fenced(
    h,
    {
      db: h.db,
      body: (trx: Transaction<DB>) => moveToPaying(trx, f, taken, elsewhere),
    },
    { db: h.observer, body: f.body(service, [taken, stayer]) },
  );

  const answer = executed(run.second);
  expect(answer.left).toEqual(
    expect.arrayContaining([
      { id: taken, reason: 'not_approved' },
      { id: stayer, reason: 'channel_disabled' },
    ]),
  );
  expect(await withdrawal(f, taken)).toMatchObject({
    status: 'PAYING',
    batch_id: elsewhere,
    row_version: seeded.row_version + 1,
  });
  await expectLines(f, [
    line(answer.batchId, taken, 'skipped', 'not_approved'),
    line(answer.batchId, stayer, 'blocked', 'channel_disabled'),
  ]);
  expect((await withdrawal(f, stayer)).batch_id).toBe(answer.batchId);
});

it('[AC-B2-09n#31] 两个事务（锁栅栏）：多通道水位留下时别的事务刚写了 batch_id：已挂别批不改挂，batch_id 仍是别人写的，没有 moved_out；同批从没挂过的挂上本批，支付宝照常 PAYING', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(1_000_000_000n, new Date(NOW.getTime() - 10 * MINUTE), 'alipay');
  await f.watermark(1_000_000_000n, new Date(NOW.getTime() - 2 * HOUR - 1), 'bank_card');
  const elsewhere = await f.seedBatch('auto');
  const alipay = await f.seedWithdrawal({ channel: 'alipay' });
  const taken = await f.seedWithdrawal({ channel: 'bank_card' });
  const stayer = await f.seedWithdrawal({ channel: 'bank_card' });
  const seeded = await withdrawal(f, taken);

  const run = await fenced(
    h,
    {
      db: h.db,
      body: (trx: Transaction<DB>) => putOnBatch(trx, f, taken, elsewhere),
    },
    { db: h.observer, body: f.body(service, [alipay, taken, stayer]) },
  );

  const answer = executed(run.second);
  expect(answer.paying).toEqual([alipay]);
  await expectPaying(f, alipay, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  expect(await withdrawal(f, taken)).toMatchObject({
    status: 'APPROVED',
    batch_id: elsewhere,
    row_version: seeded.row_version + 1,
  });
  await expectLines(f, [
    line(answer.batchId, alipay, 'paying'),
    line(answer.batchId, taken, 'blocked', 'watermark_stale'),
    line(answer.batchId, stayer, 'blocked', 'watermark_stale'),
  ]);
  expect((await withdrawal(f, stayer)).batch_id).toBe(answer.batchId);
});

it('[AC-B2-09n#32] 自动批次 member_blocked（真实 createPayoutExecute，执行人 system:auto_payout）：batch_id 是那个 kind=auto 批次，executor_id 仍空，row_version + 1；解冻后组人工批次执行，auto 批次记 moved_out，任务恰一个', async () => {
  const f = await setup(h);
  const service = f.execute();
  const owner = await f.newUser();
  f.risk.set(owner, { state: 'frozen', frozen_until: null });
  const id = await f.seedWithdrawal({ userId: owner, reviewMode: 'auto' });
  const seeded = await withdrawal(f, id);

  const auto = executed(await f.run(service, [id], { executorId: SYSTEM }));

  expect(auto.left).toEqual([{ id, reason: 'member_blocked' }]);
  expect(await batches(f)).toEqual([{ id: auto.batchId, kind: 'auto', created_by: null }]);
  await expectUntouched(f, id, 'APPROVED');
  expect(await withdrawal(f, id)).toMatchObject({
    batch_id: auto.batchId,
    row_version: seeded.row_version + 1,
  });

  f.risk.delete(owner);
  const manual = executed(await f.run(service, [id]));

  expect(manual.paying).toEqual([id]);
  await expectPaying(f, id, { batchId: manual.batchId, seq: 1, executor: f.adminId });
  await expectLines(f, [
    line(auto.batchId, id, 'blocked', 'member_blocked'),
    line(auto.batchId, id, 'moved_out', null, manual.batchId),
    line(manual.batchId, id, 'paying'),
  ]);
  expect(await jobs(f)).toHaveLength(1);
});

it('[AC-B2-09n#33] 自动批次 has_transfer_attempt（真实 createPayoutExecute，执行人 system:auto_payout）：batch_id 是那个 kind=auto 批次，row_version + 1，没有任务；再组人工批次仍受阻：改挂人工批次，auto 批次记 moved_out，execute_seq 不变', async () => {
  const f = await setup(h);
  const service = f.execute();
  const id = await f.seedWithdrawal({ reviewMode: 'auto' });
  await f.seedAttempt(id, 'transfer', 'fail');
  const seeded = await withdrawal(f, id);

  const auto = executed(await f.run(service, [id], { executorId: SYSTEM }));

  expect(auto.left).toEqual([{ id, reason: 'has_transfer_attempt' }]);
  expect(await withdrawal(f, id)).toMatchObject({
    batch_id: auto.batchId,
    row_version: seeded.row_version + 1,
  });

  const manual = executed(await f.run(service, [id]));

  expect(manual.left).toEqual([{ id, reason: 'has_transfer_attempt' }]);
  await expectUntouched(f, id, 'APPROVED');
  expect(await withdrawal(f, id)).toMatchObject({
    batch_id: manual.batchId,
    row_version: seeded.row_version + 2,
  });
  await expectLines(f, [
    line(auto.batchId, id, 'blocked', 'has_transfer_attempt'),
    line(auto.batchId, id, 'moved_out', null, manual.batchId),
    line(manual.batchId, id, 'blocked', 'has_transfer_attempt'),
  ]);
  expect(await jobs(f)).toEqual([]);
});
