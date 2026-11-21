import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  DENIED,
  TABLES,
  close,
  fixture,
  open,
  read,
  sqlState,
  type Harness,
  type Table,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => close(h));

// The existing grants plus precisely B3-09f §9 items 2–5. This is an explicit
// oracle, not a list extracted from the migration/schema under test.
const UPDATABLE: Record<Table, string[]> = {
  agent_messages: [
    'text',
    'card_ids',
    'feedback',
    'feedback_at',
    'reported',
    'report_reason',
    'reported_at',
    'report_status',
    'report_handler_id',
    'report_handled_at',
    'report_note',
    'badcase',
    'row_version',
    'updated_at',
  ],
  agent_tool_calls: ['args'],
  agent_cards: ['data', 'fallback_text'],
  agent_result_sets: ['conditions'],
  agent_result_deliveries: ['card'],
  agent_result_chains: ['conditions'],
  agent_runs: [
    'user_text',
    'intent',
    'model',
    'model_snapshot',
    'input_tokens',
    'output_tokens',
    'cost_mfen',
    'ttft_ms',
    'latency_ms',
    'finish_reason',
    'final_event',
    'ended_at',
    'output_filtered',
    'filter_hits',
    'output_truncated',
    'price_version',
    'result_check_provider',
    'judge_model',
    'page_guide_reject_reason',
    'quota_subjects',
    'end_reason',
    'card_delivered',
    'settle_result',
    'settled_at',
    'row_version',
    'updated_at',
    'end_draft',
    'cancel_requested_at',
    'finalize_hold',
    'finalize_hold_at',
    'input_passed',
  ],
};
const PRIVATE: Partial<Record<Table, string[]>> = {
  agent_messages: ['text', 'report_reason'],
  agent_runs: ['user_text'],
  agent_tool_calls: ['args'],
  agent_result_sets: ['conditions'],
  agent_result_chains: ['conditions'],
};

for (const table of TABLES) {
  it(`[AC-B3-09f#3][AC-B3-09f#7][BR-AI-22] ${table} grants exactly the intended UPDATE columns and keeps INSERT`, async () => {
    // Real couli_app INSERTs of populated rows must still succeed.
    const row = await fixture(h.app, table);
    const columns = await sql<{ name: string; updatable: boolean; insertable: boolean }>`
      SELECT attname AS name,
        has_column_privilege('couli_app', attrelid, attname, 'UPDATE') AS updatable,
        has_column_privilege('couli_app', attrelid, attname, 'INSERT') AS insertable
      FROM pg_attribute WHERE attrelid = ${`app.${table}`}::regclass
        AND attnum > 0 AND NOT attisdropped ORDER BY attname`.execute(h.app);
    expect(
      columns.rows
        .filter((c) => c.updatable)
        .map((c) => c.name)
        .sort(),
    ).toEqual([...UPDATABLE[table]].sort());
    expect(columns.rows.every((c) => c.insertable)).toBe(true);
    for (const column of columns.rows.filter((c) => !UPDATABLE[table].includes(c.name))) {
      // No-op SQL assignments exercise ACLs without changing a PK or violating a CHECK.
      // Covers tool name/status/seq, card type/card_id, delivery final_price_fen,
      // all app_id/run_id/session_id/time columns and every other unlisted column.
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)}
        SET ${sql.ref(column.name)} = ${sql.ref(column.name)}
        WHERE app_id = ${row['app_id']}`.execute(h.app),
        ),
        `${table}.${column.name}`,
      ).toBe(DENIED);
    }
    expect(await read(h.app, table, row)).toEqual(row);
  });

  it(`[AC-B3-09f#6][BR-AI-22] ${table} keeps its row and denies couli_app DELETE and TRUNCATE`, async () => {
    const row = await fixture(h.app, table);
    const privileges = await sql<{ read: boolean; insert: boolean; forbidden: boolean }>`SELECT
      has_table_privilege('couli_app', ${`app.${table}`}, 'SELECT') AS read,
      has_table_privilege('couli_app', ${`app.${table}`}, 'INSERT') AS insert,
      has_table_privilege('couli_app', ${`app.${table}`}, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS forbidden`.execute(
      h.app,
    );
    expect(privileges.rows).toEqual([{ read: true, insert: true, forbidden: false }]);
    expect(
      await sqlState(
        sql`DELETE FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${row['app_id']}`.execute(h.app),
      ),
    ).toBe(DENIED);
    expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(h.app))).toBe(DENIED);
    expect(await read(h.app, table, row)).toEqual(row);
  });

  it(`[AC-B3-09f#7][BR-AI-22] ${table} readonly visibility and all non-app write restrictions remain unchanged`, async () => {
    const row = await fixture(h.app, table);
    const columns = await sql<{ name: string }>`SELECT attname AS name
      FROM pg_attribute WHERE attrelid = ${`app.${table}`}::regclass
      AND attnum > 0 AND NOT attisdropped ORDER BY attname`.execute(h.app);
    expect(columns.rows.length).toBeGreaterThan(0);
    for (const { name } of columns.rows) {
      const selection = sql`SELECT ${sql.ref(name)} FROM ${sql.table(`app.${table}`)}
        WHERE app_id = ${row['app_id']}`;
      if (PRIVATE[table]?.includes(name)) {
        expect(await sqlState(selection.execute(h.readonly)), `${table}.${name}`).toBe(DENIED);
      } else {
        expect((await selection.execute(h.readonly)).rows, `${table}.${name}`).toHaveLength(1);
      }
    }
    for (const [role, db] of [
      ['couli_readonly', h.readonly],
      ['couli_payout', h.payout],
      ['couli_maint', h.maint],
    ] as const) {
      const privileges = await sql<{ table_write: boolean; column_write: boolean }>`SELECT
        has_table_privilege(${role}, ${`app.${table}`}, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS table_write,
        has_any_column_privilege(${role}, ${`app.${table}`}, 'INSERT,UPDATE,REFERENCES') AS column_write`.execute(
        h.app,
      );
      expect(privileges.rows, `${role}.${table}`).toEqual([
        { table_write: false, column_write: false },
      ]);
      expect(
        await sqlState(sql`INSERT INTO ${sql.table(`app.${table}`)} DEFAULT VALUES`.execute(db)),
      ).toBe(DENIED);
      const name = UPDATABLE[table][0]!;
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)}
        SET ${sql.ref(name)} = ${sql.ref(name)} WHERE app_id = ${row['app_id']}`.execute(db),
        ),
      ).toBe(DENIED);
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)}
        WHERE app_id = ${row['app_id']}`.execute(db),
        ),
      ).toBe(DENIED);
      expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(db))).toBe(DENIED);
      if (role !== 'couli_readonly') {
        const access = await sql<{ table_read: boolean; column_read: boolean }>`SELECT
          has_table_privilege(${role}, ${`app.${table}`}, 'SELECT') AS table_read,
          has_any_column_privilege(${role}, ${`app.${table}`}, 'SELECT') AS column_read`.execute(
          h.app,
        );
        expect(access.rows).toEqual([{ table_read: false, column_read: false }]);
        expect(await sqlState(sql`SELECT * FROM ${sql.table(`app.${table}`)}`.execute(db))).toBe(
          DENIED,
        );
      }
    }
    expect(await read(h.app, table, row)).toEqual(row);
  });
}

it('[AC-B3-09f#7][BR-AI-22] agent_messages remains without a user trigger', async () => {
  await fixture(h.app, 'agent_messages');
  const triggers = await sql`SELECT tgname FROM pg_trigger
    WHERE tgrelid = 'app.agent_messages'::regclass AND NOT tgisinternal`.execute(h.app);
  expect(triggers.rows).toEqual([]);
});
