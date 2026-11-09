// B2-04zzr rule tests, BR-FUND-19 ⑧ after a legal restore (claude-independent, SPEC_REF b1410c4f;
// 编排 D10-1126 ②, D10-1134 (3)). ⑧ reports a CREDITED sub-order whose platform_status is INVALID, or
// that has a successful INVALID_AFTER_SETTLE record — except a record that became successful before
// the order's last R12 / R13: the success instant is order_rights.updated_at (a row written as
// SUCCEEDED has updated_at = created_at), the last restore is max(at) of its app.order_status_history
// rows with field rebate, event ADMIN_RESTORE and from_status VOID / CLAWED_BACK. A success at or after
// the last restore is reported. Never by occurred_at, never by RESTORE vouchers, audits or difference
// rows (an account appeal restore writes the same voucher kind but no history row). The SQL is the
// append-only replacement 10_invalid-still-credited-since-restore.sql, registered in superseded.json
// as replacing 08 and still numbered 08 (./since-restore.ts executes it; written by the
// implementation phase). Fixtures: ../../db/ledger/invariants-settlement/kit.ts orders (read only).
// Top-level it() only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  clean,
  differences,
  insert,
  pair,
  voucher,
} from '../../db/ledger/invariants/kit.ts';
import { identifies, order, type Order } from '../../db/ledger/invariants-settlement/kit.ts';
import {
  LEGACY,
  REPLACEMENT,
  registration,
  replacementText,
  reports,
  scenario,
} from './since-restore.ts';

/** Instants after the fixture's credit (2032-06-15T08:00Z). */
const T1 = '2032-06-15T09:00:00.000Z';
const T2 = '2032-06-15T10:00:00.000Z';
const T3 = '2032-06-15T11:00:00.000Z';
const T4 = '2032-06-15T12:00:00.000Z';

/** One INVALID_AFTER_SETTLE record of the order (status SUCCEEDED unless given). */
async function invalidRecord(
  db: Kysely<DB>,
  o: Order,
  at: { readonly created: string; readonly updated?: string; readonly occurred?: string },
  status = 'SUCCEEDED',
): Promise<void> {
  await insert(db, 'order_rights', {
    id: randomUUID(),
    app_id: o.app,
    order_id: o.id,
    source: 'API',
    type: 'INVALID_AFTER_SETTLE',
    status,
    occurred_at: at.occurred ?? at.created,
    platform_rights_no: `P${randomUUID()}`,
    created_at: at.created,
    updated_at: at.updated ?? at.created,
  });
}

/** One rebate history row of the order (settlement's rows, written directly). */
async function rebateStep(
  db: Kysely<DB>,
  o: Order,
  step: { readonly from: string; readonly event: string; readonly to: string; readonly at: string },
): Promise<void> {
  await insert(db, 'order_status_history', {
    app_id: o.app,
    order_id: o.id,
    field: 'rebate',
    from_status: step.from,
    event: step.event,
    to_status: step.to,
    source: step.event === 'ADMIN_RESTORE' ? 'admin' : 'system',
    at: step.at,
  });
}

/** R12 (VOID → WAITING) or R13 (CLAWED_BACK → CREDITED) at `at`. */
function restored(db: Kysely<DB>, o: Order, from: 'VOID' | 'CLAWED_BACK', at: string) {
  return rebateStep(db, o, {
    from,
    event: 'ADMIN_RESTORE',
    to: from === 'VOID' ? 'WAITING' : 'CREDITED',
    at,
  });
}

it('[AC-B2-04zzr#12] ⑧ 替代登记：superseded.json 登记旧 08 由 10_invalid-still-credited-since-restore.sql 替代（原因非空），两文件都在、08_ 仍只旧文件一份；新文件开头注释写明 BR-FUND-19 ⑧，口径注释写最后一次恢复与 updated_at', () => {
  expect(registration()).toMatchObject({ file: LEGACY, replaced_by: REPLACEMENT });
  const text = replacementText();
  expect(text).toMatch(/^\s*--[^\n]*BR-FUND-19/);
  const header = text
    .split('\n')
    .filter((line) => line.trimStart().startsWith('--'))
    .join('\n');
  expect(header).toContain('⑧');
  expect(header).toContain('ADMIN_RESTORE');
  expect(header).toContain('updated_at');
});

it(
  '[AC-B2-04zzr#13] ⑧ 合法恢复之后不报：P7 后经 R12（VOID）或 R13（CLAWED_BACK）恢复为 CREDITED、之后没有新的成功失效记录；occurred_at 晚于恢复而 updated_at 早于恢复的也不报；多次恢复取最后一次；对照无记录的正常单；检查数按 CREDITED 子订单',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const r12 = await order(db);
      await invalidRecord(db, r12, { created: T1 });
      await restored(db, r12, 'VOID', T2);

      const r13 = await order(db);
      await invalidRecord(db, r13, { created: T1 });
      await restored(db, r13, 'CLAWED_BACK', T2);

      const occurredLate = await order(db);
      await invalidRecord(db, occurredLate, { created: T1, occurred: T3 });
      await restored(db, occurredLate, 'VOID', T2);

      const twice = await order(db);
      await invalidRecord(db, twice, { created: T1 });
      await restored(db, twice, 'VOID', T2);
      await invalidRecord(db, twice, { created: T3 });
      await restored(db, twice, 'CLAWED_BACK', T4);

      await order(db);
      clean(await check(5n));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#14] ⑧ 恢复之后又有成功的失效记录、订单仍 CREDITED → 报：晚于最后一次恢复、与恢复同一时刻（不早于即报）、恢复前创建而恢复后才变成功（按 updated_at）、occurred_at 早于恢复而记录在恢复后写入；对照：恢复前成功的那单不报',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const after = await order(db);
      await invalidRecord(db, after, { created: T1 });
      await restored(db, after, 'VOID', T2);
      await invalidRecord(db, after, { created: T3 });

      const same = await order(db);
      await invalidRecord(db, same, { created: T1 });
      await restored(db, same, 'CLAWED_BACK', T2);
      await invalidRecord(db, same, { created: T2 });

      const turned = await order(db);
      await restored(db, turned, 'VOID', T2);
      await invalidRecord(db, turned, { created: T1, updated: T3 });

      const occurredEarly = await order(db);
      await restored(db, occurredEarly, 'VOID', T2);
      await invalidRecord(db, occurredEarly, { created: T3, occurred: T1 });

      const control = await order(db);
      await invalidRecord(db, control, { created: T1 });
      await restored(db, control, 'VOID', T2);

      const rows = await check(5n);
      differences(rows, 'account');
      for (const o of [after, same, turned, occurredEarly]) {
        expect(reports(rows, o), o.key).toBe(true);
        identifies(
          rows.filter((row) => reports([row], o)),
          o,
        );
      }
      expect(reports(rows, control)).toBe(false);
      expect(new Set(rows.map((row) => row.account_id))).toEqual(
        new Set(
          [after, same, turned, occurredEarly].flatMap((o) => o.people.map((p) => p.account.id)),
        ),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#15] ⑧ 照旧报：从未恢复而有成功的 INVALID_AFTER_SETTLE；platform_status=INVALID 的 CREDITED；只有入账历史（SETTLE_BATCH_CREDIT）不算恢复；只有账户申诉恢复的 RESTORE 凭证、没有 ADMIN_RESTORE 历史行也不算恢复；已 CLAWED_BACK 的不是候选',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const never = await order(db);
      await invalidRecord(db, never, { created: T1 });

      const invalid = await order(db, { values: { platform_status: 'INVALID' } });

      const credit = await order(db);
      await invalidRecord(db, credit, { created: T1 });
      await rebateStep(db, credit, {
        from: 'WAITING',
        event: 'SETTLE_BATCH_CREDIT',
        to: 'CREDITED',
        at: T2,
      });

      const appeal = await order(db);
      await invalidRecord(db, appeal, { created: T1 });
      const member = appeal.people[0]!;
      const restoreVoucher = await voucher(db, {
        app_id: appeal.app,
        uniq_key: `${appeal.key}:${member.account.owner_id}:${member.role}:RESTORE:${randomUUID()}`,
        order_key: appeal.key,
        biz_id: appeal.id,
        beneficiary_user_id: member.account.owner_id,
        role: member.role,
        voucher_kind: 'ADMIN_ADJUST',
      });
      await pair(db, member.account, appeal.revenue, restoreVoucher, -85n, {
        ledger_type: 'ADMIN_ADJUST',
        sub_type: 'RESTORE',
      });

      const gone = await order(db, { values: { rebate_status: 'CLAWED_BACK' } });
      await invalidRecord(db, gone, { created: T1 });

      const rows = await check(4n);
      differences(rows, 'account');
      for (const o of [never, invalid, credit, appeal]) {
        expect(reports(rows, o), o.key).toBe(true);
      }
      expect(reports(rows, gone)).toBe(false);
    });
  },
  TIMEOUT,
);
