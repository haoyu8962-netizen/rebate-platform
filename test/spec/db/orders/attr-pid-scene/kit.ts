import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export async function requireAttrPidScene(db: Kysely<DB>) {
  const { rows } = await sql<{
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'orders' AND column_name = 'attr_pid_scene'
  `.execute(db);
  expect(rows, 'app.orders.attr_pid_scene 必须存在').toHaveLength(1);
  return rows[0]!;
}
