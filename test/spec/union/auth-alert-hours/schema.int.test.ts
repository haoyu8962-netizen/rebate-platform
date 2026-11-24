import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { account, databaseFixture, harness } from './kit.ts';

const db = databaseFixture(createTestDatabase);
const COLUMNS = [
  'r1_expires_in_s',
  'r2_expires_in_s',
  're_expires_in_s',
  'w1_expires_in_s',
  'w2_expires_in_s',
] as const;

it('[AC-B1-22zd#8] 凭据时长列是可空整数且拒绝负数，账号阶段约束继续拒绝 h6', async () => {
  const h = await harness(db());
  const row = await account(h);
  await expect(
    h.db
      .updateTable('union_accounts')
      .set({ alert_stage: 'h6' })
      .where('app_id', '=', h.appId)
      .where('id', '=', row.id)
      .execute(),
  ).rejects.toMatchObject({ code: '23514', constraint: 'union_accounts_alert_stage_check' });

  const { rows } = await sql<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'app'
      and table_name = 'union_credentials'
      and column_name in (${sql.join(COLUMNS)})
    order by column_name collate "C"
  `.execute(h.db);
  expect(rows).toEqual(
    COLUMNS.map((column_name) => ({ column_name, data_type: 'integer', is_nullable: 'YES' })),
  );

  for (const column of COLUMNS) {
    await expect(
      h.db
        .insertInto('union_credentials')
        .values({
          id: randomUUID(),
          app_id: h.appId,
          union_account_id: row.id,
          access_token_cipher: Buffer.from('synthetic-cipher'),
          is_current: true,
          ...{ [column]: -1 },
        })
        .execute(),
      column,
    ).rejects.toMatchObject({ code: '23514' });
  }
});
