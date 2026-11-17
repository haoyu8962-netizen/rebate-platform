import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { AdminLedgerReadFieldsError, readAdminLedgerExportPage } from './admin-ledger-read.ts';

const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c04';

/** Deps whose database must never be reached (the refusals come before any read). */
function untouched() {
  const fail = (): never => {
    throw new Error('the database was reached');
  };
  return {
    db: { isTransaction: false, transaction: fail } as unknown as Kysely<DB>,
    ports: { userExists: fail },
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

const page = (
  filters: Record<string, unknown>,
  extra: { after?: string | null; limit?: number } = {},
) =>
  readAdminLedgerExportPage(untouched(), {
    appId: 'app',
    filters,
    after: extra.after ?? null,
    limit: extra.limit ?? 200,
  });

it('[AC-CT-24zzm-UNIT#1] 导出页按列表的规则拒绝且先于读库：缺 user_id、非 UUID、枚举外取值、会计日起晚于止、未知键或非字符串值', async () => {
  expect(await refusal(() => page({}))).toEqual(['user_id']);
  expect(await refusal(() => page({ user_id: 'not-a-uuid' }))).toEqual(['user_id']);
  expect(await refusal(() => page({ user_id: USER, ledger_type: 'NOT_A_TYPE' }))).toEqual([
    'ledger_type',
  ]);
  expect(await refusal(() => page({ user_id: USER, sub_account: 'locked' }))).toEqual([
    'sub_account',
  ]);
  expect(
    await refusal(() =>
      page({ user_id: USER, accounting_date_from: '2026-10-09', accounting_date_to: '2026-10-08' }),
    ),
  ).toEqual(['accounting_date_from', 'accounting_date_to']);
  expect(await refusal(() => page({ user_id: USER, page_size: '200' }))).toEqual(['page_size']);
  expect(await refusal(() => page({ user_id: USER, ref: 5 }))).toEqual(['ref']);
});

it('[AC-CT-24zzm-UNIT#2] 导出页的页长只收 1..200，游标格式不对即抛错，都不读库', async () => {
  await expect(page({ user_id: USER }, { limit: 0 })).rejects.toThrow(RangeError);
  await expect(page({ user_id: USER }, { limit: 201 })).rejects.toThrow(RangeError);
  await expect(page({ user_id: USER }, { after: '2026-10-09T01:00:00Z|1' })).rejects.toThrow(
    /cursor/,
  );
});
