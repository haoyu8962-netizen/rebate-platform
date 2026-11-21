import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { usePgEach } from '../stream-mount/kit.ts';

const pg = usePgEach(createTestDatabase);

it('[AC-B3-08t#12] input_passed 是默认 false 的非空 boolean，业务角色可更新', async () => {
  const columns = await sql<{
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'agent_runs' AND column_name = 'input_passed'
  `.execute(pg.db);
  expect(columns.rows, '先确认迁移新增了这一列').toHaveLength(1);
  expect(columns.rows[0]).toMatchObject({
    data_type: 'boolean',
    is_nullable: 'NO',
    column_default: 'false',
  });
  const check = await sql<{ can_update: boolean }>`
    SELECT has_column_privilege('couli_app', 'app.agent_runs', 'input_passed', 'UPDATE') AS can_update
  `.execute(pg.db);
  expect(check.rows).toEqual([{ can_update: true }]);
});
