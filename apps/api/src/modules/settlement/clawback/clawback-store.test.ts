// B2-04zzb 源码旁单元测试（不连库：脚本化驱动记录编译后的语句、回预设的受影响行数）：扣回关闭义务时把凭证写进同一条
// UPDATE（BR-FUND-04 ⑫「都关联实际履约的凭证（该事务的平台凭证……；平台差额为 0、没写平台凭证的，记该事务的结算记录
// seq 或 rights_event_id）」）；CAS 条件不变、未命中返回 false；作废（R8）不带凭证。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { closeObligation, type ObligationClose } from './clawback-store.ts';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Every statement is recorded; each returns no rows and reports `affected` rows. */
function scripted(affected: bigint) {
  const statements: Statement[] = [];
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: {
          sql: string;
          parameters: readonly unknown[];
        }): Promise<QueryResult<R>> {
          statements.push({ sql: compiled.sql, parameters: compiled.parameters });
          return Promise.resolve({ rows: [], numAffectedRows: affected });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

/** `"column" = $n` pairs of one clause (joined by `separator`) → column → parameter. */
function pairs(clause: string, separator: string, parameters: readonly unknown[]) {
  return Object.fromEntries(
    clause.split(separator).map((part) => {
      const match = /^"([^"]+)" = \$(\d+)$/u.exec(part.trim());
      if (match === null) throw new Error(`unexpected clause part: ${part}`);
      return [match[1], parameters[Number(match[2]) - 1]];
    }),
  );
}

/** The one UPDATE of app.beneficiary_credits: its SET and WHERE as column → parameter. */
function update(statement: Statement) {
  const match = /^update "app"\."beneficiary_credits" set (.*) where (.*)$/u.exec(statement.sql);
  if (match === null) throw new Error(`not an obligation update: ${statement.sql}`);
  return {
    set: pairs(match[1] ?? '', ', ', statement.parameters),
    where: pairs(match[2] ?? '', ' and ', statement.parameters),
  };
}

const CLOSED_AT = new Date('2026-11-08T02:00:00.000Z');
const VOUCHER = '019a0000-0000-7000-8000-0000000000aa';
const CREDIT = '019a0000-0000-7000-8000-0000000000bb';

function close(patch: Partial<ObligationClose> = {}): ObligationClose {
  return {
    app_id: 'unit-app',
    beneficiary_credit_id: CREDIT,
    row_version: 3,
    status: 'forfeited',
    closed_by: 'R9',
    closed_ref: 'R42',
    voucher_id: VOUCHER,
    closed_at: CLOSED_AT,
    ...patch,
  };
}

async function run(value: ObligationClose, affected = 1n) {
  const { db, statements } = scripted(affected);
  const matched = await db.transaction().execute((trx) => closeObligation(trx, value));
  return { matched, statements };
}

it('[AC-B2-04zzb#U1] R9 / R10 没收：voucher_id 与状态、closed_*、row_version 同一条 UPDATE 写入，CAS 仍是 (app, id, open, row_version)', async () => {
  for (const [closedBy, closedRef] of [
    ['R9', 'R42'],
    ['R10', 'S3'],
  ] as const) {
    const { matched, statements } = await run(
      close({ closed_by: closedBy, closed_ref: closedRef }),
    );
    expect(matched).toBe(true);
    expect(statements).toHaveLength(1);
    const { set, where } = update(statements[0]!);
    expect(set).toEqual({
      status: 'forfeited',
      closed_by: closedBy,
      closed_ref: closedRef,
      closed_at: CLOSED_AT,
      voucher_id: VOUCHER,
      row_version: 4,
    });
    expect(where).toEqual({
      app_id: 'unit-app',
      beneficiary_credit_id: CREDIT,
      status: 'open',
      row_version: 3,
    });
  }
});

it('[AC-B2-04zzb#U2] 平台差额为 0（没写平台凭证）：voucher_id 显式写 null，closed_ref 仍是该事务的事件号', async () => {
  const { matched, statements } = await run(close({ voucher_id: null, closed_ref: 'R7' }));
  expect(matched).toBe(true);
  const { set } = update(statements[0]!);
  expect(set).toMatchObject({ status: 'forfeited', closed_ref: 'R7', voucher_id: null });
});

it('[AC-B2-04zzb#U3] R8 作废：voucher_id 为 null；带凭证的作废在发语句前拒绝（beneficiary_credits_voucher_check）', async () => {
  const voided = await run(close({ status: 'voided', closed_by: 'R8', voucher_id: null }));
  expect(voided.matched).toBe(true);
  expect(update(voided.statements[0]!).set).toMatchObject({
    status: 'voided',
    closed_by: 'R8',
    voucher_id: null,
  });

  const { db, statements } = scripted(1n);
  await expect(
    db
      .transaction()
      .execute((trx) => closeObligation(trx, close({ status: 'voided', closed_by: 'R8' }))),
  ).rejects.toThrow('a voided obligation carries no voucher');
  expect(statements).toEqual([]);
});

it('[AC-B2-04zzb#U4] CAS 未命中（重投时义务已关闭、或行版本已变）返回 false，调用方据此报错回滚', async () => {
  const { matched, statements } = await run(close(), 0n);
  expect(matched).toBe(false);
  expect(statements).toHaveLength(1);
});
