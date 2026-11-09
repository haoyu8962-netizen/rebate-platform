// B2-04zzr rule tests, second round (claude-independent, SPEC_REF b1410c4f; 编排 D10-1126 ②,
// D10-1134 (3); spec-test r1 findings on ./invariant-since-restore.int.test.ts, which stays frozen).
// The replacement ⑧ (10_invalid-still-credited-since-restore.sql, executed by ./since-restore.ts) keeps
// every branch of 08_invalid-still-credited.sql and only adds the restore cut:
// - a record counts only when type = INVALID_AFTER_SETTLE and status = SUCCEEDED (processing, waiting
//   for commission, failed, and RIGHTS / PUNISH / REFUND_AFTER_SETTLE records never count, before or
//   after a restore);
// - the cut (last R12 / R13 = max(at) of ADMIN_RESTORE rebate history rows from VOID / CLAWED_BACK)
//   applies to the successful-record branch only; a CREDITED sub-order whose platform_status is INVALID
//   is reported whatever its restore history;
// - a reported sub-order none of whose beneficiaries has a USER_BALANCE account is one global row
//   (detail.reasons has no_beneficiary_account), shaped as 08 emits it (the detail of
//   ../../ledger/daily-check-execute/kit.ts invalidCreditedGlobalDiff).
// Fixtures: ../../db/ledger/invariants-settlement/kit.ts orders (read only). Top-level it() only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { TIMEOUT, differences, insert, type Result } from '../../db/ledger/invariants/kit.ts';
import {
  identifies,
  order,
  person,
  type Order,
  type Person,
} from '../../db/ledger/invariants-settlement/kit.ts';
import { reports, scenario } from './since-restore.ts';

/** Instants after the fixture's credit (2032-06-15T08:00Z). */
const T1 = '2032-06-15T09:00:00.000Z';
const T2 = '2032-06-15T10:00:00.000Z';
const T3 = '2032-06-15T11:00:00.000Z';

type RightsType = 'RIGHTS' | 'PUNISH' | 'INVALID_AFTER_SETTLE' | 'REFUND_AFTER_SETTLE';
type RightsStatus = 'PROCESSING' | 'WAIT_COMMISSION' | 'SUCCEEDED' | 'FAILED';

/** One order_rights record of the order, written as it stands at `at` (updated_at = created_at). */
async function record(
  db: Kysely<DB>,
  o: Order,
  values: { readonly type: RightsType; readonly status: RightsStatus; readonly at: string },
): Promise<void> {
  await insert(db, 'order_rights', {
    id: randomUUID(),
    app_id: o.app,
    order_id: o.id,
    source: 'API',
    type: values.type,
    status: values.status,
    occurred_at: values.at,
    platform_rights_no: `P${randomUUID()}`,
    created_at: values.at,
    updated_at: values.at,
  });
}

/** R12 (VOID → WAITING) or R13 (CLAWED_BACK → CREDITED) at `at`, as settlement records it. */
async function restored(
  db: Kysely<DB>,
  o: Order,
  from: 'VOID' | 'CLAWED_BACK',
  at: string,
): Promise<void> {
  await insert(db, 'order_status_history', {
    app_id: o.app,
    order_id: o.id,
    field: 'rebate',
    from_status: from,
    event: 'ADMIN_RESTORE',
    to_status: from === 'VOID' ? 'WAITING' : 'CREDITED',
    source: 'admin',
    at,
  });
}

/** A beneficiary user with no ledger account (the account object is never written). */
async function unaccounted(
  db: Kysely<DB>,
  app: string,
  role: Person['role'] = 'self',
  ratio = 5000,
): Promise<Person> {
  const id = randomUUID();
  await insert(db, 'users', {
    id,
    app_id: app,
    nickname: '不变量夹具',
    avatar: '',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    status: 'normal',
    register_method: 'phone',
  });
  return {
    account: {
      id: randomUUID(),
      app_id: app,
      owner_id: id,
      owner_type: 'user',
      subject: 'USER_BALANCE',
    },
    role,
    ratio,
  };
}

function detailOf(row: Result): Record<string, unknown> {
  expect(row.detail).toBeTypeOf('object');
  expect(row.detail).not.toBeNull();
  return row.detail as Record<string, unknown>;
}

function rowsOf(rows: readonly Result[], o: Order): Result[] {
  return rows.filter((row) => reports([row], o));
}

function userIds(o: Order): string[] {
  return o.people.map((p) => p.account.owner_id).sort();
}

it(
  '[AC-B2-04zzr#16] ⑧ 只认成功的 INVALID_AFTER_SETTLE：CREDITED 单只有 INVALID_AFTER_SETTLE 的 PROCESSING / WAIT_COMMISSION / FAILED 记录不报，只有成功的 RIGHTS / PUNISH / REFUND_AFTER_SETTLE 记录（如部分维权 R9 后仍 CREDITED）不报，恢复之后才写入的这些记录也不报；对照：从未恢复而有成功的 INVALID_AFTER_SETTLE 照报',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const quiet: Order[] = [];
      for (const status of ['PROCESSING', 'WAIT_COMMISSION', 'FAILED'] as const) {
        const o = await order(db);
        await record(db, o, { type: 'INVALID_AFTER_SETTLE', status, at: T1 });
        quiet.push(o);
      }
      for (const type of ['RIGHTS', 'PUNISH', 'REFUND_AFTER_SETTLE'] as const) {
        const o = await order(db);
        await record(db, o, { type, status: 'SUCCEEDED', at: T1 });
        quiet.push(o);
      }
      const pendingAfterRestore = await order(db);
      await restored(db, pendingAfterRestore, 'CLAWED_BACK', T1);
      await record(db, pendingAfterRestore, {
        type: 'INVALID_AFTER_SETTLE',
        status: 'PROCESSING',
        at: T3,
      });
      quiet.push(pendingAfterRestore);

      const rightsAfterRestore = await order(db);
      await restored(db, rightsAfterRestore, 'VOID', T1);
      await record(db, rightsAfterRestore, { type: 'RIGHTS', status: 'SUCCEEDED', at: T3 });
      quiet.push(rightsAfterRestore);

      const control = await order(db);
      await record(db, control, { type: 'INVALID_AFTER_SETTLE', status: 'SUCCEEDED', at: T2 });

      const rows = await check(9n);
      differences(rows, 'account');
      expect(reports(rows, control)).toBe(true);
      identifies(rowsOf(rows, control), control);
      for (const o of quiet) {
        expect(reports(rows, o), o.key).toBe(false);
      }
      expect(new Set(rows.map((row) => row.account_id))).toEqual(
        new Set(control.people.map((p) => p.account.id)),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#17] ⑧ 恢复截断只作用在成功记录这一支：已扣回 → R13 恢复为 CREDITED → 之后平台结算前失效（platform_status = INVALID）且扣回丢失、仍 CREDITED → 照报（有 ADMIN_RESTORE 历史行、恢复前的成功记录也照报）；R12 恢复后同样；恢复晚于一切的 INVALID 单照报；对照：platform_status 未变的同样历史不报',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const r13 = await order(db, { values: { platform_status: 'INVALID' } });
      await record(db, r13, { type: 'INVALID_AFTER_SETTLE', status: 'SUCCEEDED', at: T1 });
      await restored(db, r13, 'CLAWED_BACK', T2);

      const r12 = await order(db, { values: { platform_status: 'INVALID' } });
      await restored(db, r12, 'VOID', T2);

      const lateRestore = await order(db, { values: { platform_status: 'INVALID' } });
      await record(db, lateRestore, { type: 'INVALID_AFTER_SETTLE', status: 'SUCCEEDED', at: T1 });
      await restored(db, lateRestore, 'VOID', T2);
      await restored(db, lateRestore, 'CLAWED_BACK', T3);

      const control = await order(db);
      await record(db, control, { type: 'INVALID_AFTER_SETTLE', status: 'SUCCEEDED', at: T1 });
      await restored(db, control, 'CLAWED_BACK', T2);

      const rows = await check(4n);
      differences(rows, 'account');
      for (const o of [r13, r12, lateRestore]) {
        expect(reports(rows, o), o.key).toBe(true);
        const own = rowsOf(rows, o);
        identifies(own, o);
        expect(new Set(own.map((row) => row.account_id))).toEqual(
          new Set(o.people.map((p) => p.account.id)),
        );
        for (const row of own) {
          const detail = detailOf(row);
          expect(detail['platform_status']).toBe('INVALID');
          expect(detail['reasons']).toEqual(expect.arrayContaining(['platform_invalid']));
        }
      }
      expect(reports(rows, control)).toBe(false);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#18] ⑧ 保留 global 分支：报出的子订单所有受益人都没有 USER_BALANCE 账户 → 一行 scope global（account_id 为空、app_id 为该单），detail 照旧 08（reasons 含 no_beneficiary_account，受益人与未定位用户都列出）；platform_status = INVALID 与从未恢复的成功记录各一例；恢复前成功的无账户单不报；部分受益人有账户只出 account 行，未定位的列在 unlocated_user_ids',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const app = 'invariant-app-a';
      const ghosts = async () => [
        await unaccounted(db, app),
        await unaccounted(db, app, 'direct', 1000),
      ];

      const invalid = await order(db, {
        app,
        people: await ghosts(),
        values: { platform_status: 'INVALID' },
      });

      const succeeded = await order(db, { app, people: await ghosts() });
      await record(db, succeeded, { type: 'INVALID_AFTER_SETTLE', status: 'SUCCEEDED', at: T1 });

      const restoredGhost = await order(db, { app, people: await ghosts() });
      await record(db, restoredGhost, {
        type: 'INVALID_AFTER_SETTLE',
        status: 'SUCCEEDED',
        at: T1,
      });
      await restored(db, restoredGhost, 'CLAWED_BACK', T2);

      const located = await person(db, app);
      const missing = await unaccounted(db, app, 'direct', 1000);
      const partial = await order(db, {
        app,
        people: [located, missing],
        values: { platform_status: 'INVALID' },
      });

      const rows = await check(4n);

      const invalidRows = rowsOf(rows, invalid);
      expect(invalidRows).toHaveLength(1);
      expect(invalidRows[0]).toMatchObject({ scope: 'global', app_id: app, account_id: null });
      expect(detailOf(invalidRows[0]!)).toEqual({
        order_id: invalid.id,
        order_key: invalid.key,
        platform_status: 'INVALID',
        rebate_status: 'CREDITED',
        reasons: ['platform_invalid', 'no_beneficiary_account'],
        succeeded_invalid_after_settle_rights: '0',
        beneficiary_user_ids: userIds(invalid),
        unlocated_user_ids: userIds(invalid),
      });

      const succeededRows = rowsOf(rows, succeeded);
      expect(succeededRows).toHaveLength(1);
      expect(succeededRows[0]).toMatchObject({ scope: 'global', app_id: app, account_id: null });
      const succeededDetail = detailOf(succeededRows[0]!);
      expect(succeededDetail).toMatchObject({
        order_id: succeeded.id,
        order_key: succeeded.key,
        platform_status: 'SETTLED',
        rebate_status: 'CREDITED',
        beneficiary_user_ids: userIds(succeeded),
        unlocated_user_ids: userIds(succeeded),
      });
      expect(succeededDetail['reasons']).toEqual(
        expect.arrayContaining(['invalid_after_settle_succeeded', 'no_beneficiary_account']),
      );

      expect(reports(rows, restoredGhost)).toBe(false);

      const partialRows = rowsOf(rows, partial);
      expect(partialRows).toHaveLength(1);
      expect(partialRows[0]).toMatchObject({
        scope: 'account',
        app_id: app,
        account_id: located.account.id,
      });
      const partialDetail = detailOf(partialRows[0]!);
      expect(partialDetail['reasons']).not.toContain('no_beneficiary_account');
      expect(partialDetail['unlocated_user_ids']).toEqual([missing.account.owner_id]);
      expect(partialDetail['user_id']).toBe(located.account.owner_id);

      expect(rows.filter((row) => row.scope === 'global')).toHaveLength(2);
    });
  },
  TIMEOUT,
);
