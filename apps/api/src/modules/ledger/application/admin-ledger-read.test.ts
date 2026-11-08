import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  AdminLedgerReadFieldsError,
  adminLedgerLinkOf,
  adminLedgerQueryOf,
  getAdminUserFundSummary,
  listAdminLedgerEntries,
  type AdminLedgerReadDeps,
} from './admin-ledger-read.ts';

const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c04';

/** Deps whose database must never be reached (the refusals come before any read). */
function untouched(): AdminLedgerReadDeps {
  const fail = (): never => {
    throw new Error('the database was reached');
  };
  return {
    db: { isTransaction: false, transaction: fail } as unknown as Kysely<DB>,
    clock: { now: () => new Date('2026-10-29T08:00:00.000Z') },
    ports: { userExists: fail, withdrawnFen: fail, holdKindsInEffect: fail },
  };
}

async function refusal(run: () => Promise<unknown>): Promise<readonly string[]> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof AdminLedgerReadFieldsError) return error.fields;
    throw error;
  }
  throw new Error('expected a refusal');
}

it('[AC-B2-02u-UNIT#1] link 按 biz_type 映射：三种订单凭证 → order，withdrawal、admin_adjustment、bad_debt_writeoff 各自映射，其余为 null', () => {
  const id = 'b-1';
  expect(adminLedgerLinkOf({ bizType: 'ORDER_CREDIT', bizId: id })).toEqual({ type: 'order', id });
  expect(adminLedgerLinkOf({ bizType: 'ORDER_CLAWBACK', bizId: id })).toEqual({
    type: 'order',
    id,
  });
  expect(adminLedgerLinkOf({ bizType: 'ORDER_SETTLE_ADJUST', bizId: id })).toEqual({
    type: 'order',
    id,
  });
  expect(adminLedgerLinkOf({ bizType: 'withdrawal', bizId: id })).toEqual({
    type: 'withdrawal',
    id,
  });
  expect(adminLedgerLinkOf({ bizType: 'admin_adjustment', bizId: id })).toEqual({
    type: 'adjustment',
    id,
  });
  expect(adminLedgerLinkOf({ bizType: 'bad_debt_writeoff', bizId: id })).toEqual({
    type: 'writeoff',
    id,
  });
  for (const bizType of ['INVITE_REWARD', 'FIXTURE', 'reward', 'WITHDRAWAL', '']) {
    expect(adminLedgerLinkOf({ bizType, bizId: id }), bizType).toBeNull();
  }
});

it('[AC-B2-02u-UNIT#2] 查询参数：不带 page / page_size 时为 1 / 20，带了照用；未知 ledger_type / sub_account 指名该参数', () => {
  expect(adminLedgerQueryOf('app', { user_id: USER })).toEqual({
    appId: 'app',
    userId: USER,
    page: 1,
    pageSize: 20,
  });
  expect(
    adminLedgerQueryOf('app', {
      user_id: USER,
      ledger_type: 'CLAWBACK',
      sub_type: 'FULL',
      sub_account: 'frozen',
      accounting_date_from: '2026-10-01',
      accounting_date_to: '2026-10-31',
      ref: 'r',
      page: 3,
      page_size: 200,
    }),
  ).toEqual({
    appId: 'app',
    userId: USER,
    ledgerType: 'CLAWBACK',
    subType: 'FULL',
    subAccount: 'frozen',
    accountingDateFrom: '2026-10-01',
    accountingDateTo: '2026-10-31',
    ref: 'r',
    page: 3,
    pageSize: 200,
  });
  expect(() => adminLedgerQueryOf('app', { user_id: USER, ledger_type: 'PAY_RECEIPT' })).toThrow(
    AdminLedgerReadFieldsError,
  );
  expect(() => adminLedgerQueryOf('app', { user_id: USER, sub_account: 'pending' })).toThrow(
    AdminLedgerReadFieldsError,
  );
});

it('[AC-B2-02u-UNIT#3] 拒绝先于读库：user_id 缺失或不是 UUID → [user_id]，page_size > 200 → [page_size]，会计日 from 晚于 to → 两个参数', async () => {
  const deps = untouched();
  const base = { appId: 'app', userId: USER, page: 1, pageSize: 20 };
  expect(await refusal(() => getAdminUserFundSummary(deps, { appId: 'app', userId: 'x' }))).toEqual(
    ['user_id'],
  );
  expect(await refusal(() => listAdminLedgerEntries(deps, { ...base, userId: '' }))).toEqual([
    'user_id',
  ]);
  expect(await refusal(() => listAdminLedgerEntries(deps, { ...base, pageSize: 201 }))).toEqual([
    'page_size',
  ]);
  expect(
    await refusal(() =>
      listAdminLedgerEntries(deps, {
        ...base,
        accountingDateFrom: '2026-10-29',
        accountingDateTo: '2026-10-28',
      }),
    ),
  ).toEqual(['accounting_date_from', 'accounting_date_to']);
});
