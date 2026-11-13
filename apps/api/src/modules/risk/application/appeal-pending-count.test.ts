// Unit tests of the appeal_pending count (B1-03zo) over a scripted pg client (no database).
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import { countProcessingAppeals } from './appeal-pending-count.ts';

const APP = 'couli';

function harness(n: string) {
  const sqls: { text: string; params: readonly unknown[] }[] = [];
  const client = {
    release() {},
    async query(text: string, params: readonly unknown[] = []) {
      sqls.push({ text, params });
      return { command: 'SELECT', rowCount: 1, rows: [{ n }] };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  return { db, sqls };
}

it('[AC-B1-03zo#1] one read of this app: app_id bound, status a literal, no other condition', async () => {
  const { db, sqls } = harness('7');
  expect(await countProcessingAppeals(db, APP)).toBe(7);
  expect(sqls).toHaveLength(1);
  const { text, params } = sqls[0]!;
  expect(text).toMatch(/^select count\(\*\) as "n" from "app"\."appeals" where /);
  expect(text).toContain(`"status" = 'processing'`);
  expect(params).toEqual([APP]);
  for (const other of ['target_type', 'deadline_at', 'source', 'insert', 'update', 'delete']) {
    expect(text).not.toContain(other);
  }
});

it('[AC-B1-03zo#3] no processing appeal → 0', async () => {
  const { db } = harness('0');
  expect(await countProcessingAppeals(db, APP)).toBe(0);
});
