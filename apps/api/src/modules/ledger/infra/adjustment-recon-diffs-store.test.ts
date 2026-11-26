// B2-17 implementer unit tests (no database): the statements of the link store and of the three
// recon_diffs status writes, compiled by Kysely's PostgreSQL compiler over a DummyDriver (nothing is
// sent anywhere). They pin §13.3 ③ (plain INSERT / UPDATE, the statement shapes the rule tests'
// fault kit matches), the CAS conditions of §9.3 and the lock of 9.4 (FOR UPDATE, ascending id).
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type KyselyPlugin,
  type Transaction,
} from 'kysely';
import { expect, it } from 'vitest';
import { adjustmentReconStore } from './adjustment-recon-diffs-store.ts';

const APP = 'app_unit';
const D1 = '0199a3b4-5c6d-7e8f-9a0b-d1d1d1d1d1d1';
const ADJ = '0199a3b4-5c6d-7e8f-9a0b-adadadadadad';
const REV = '0199a3b4-5c6d-7e8f-9a0b-bebebebebebe';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';
const AT = new Date('2026-11-26T02:00:00.000Z');

/** The same patterns as test/spec/ledger/recon-plan-b/kit-fault.ts (the rule tests' fault kit). */
const LINK_WRITE = /\b(?:insert\s+into|update)\s+(?:"?app"?\s*\.\s*)?"?adjustment_recon_diffs\b/i;
const DIFF_WRITE = /\bupdate\s+(?:only\s+)?(?:"?app"?\s*\.\s*)?"?recon_diffs\b/i;

async function compiled(run: (trx: Transaction<DB>) => Promise<unknown>): Promise<CompiledQuery[]> {
  const queries: CompiledQuery[] = [];
  const compiler = new PostgresQueryCompiler();
  const capture: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      queries.push(compiler.compileQuery(node, queryId));
      return node;
    },
    transformResult: ({ result }) => Promise.resolve(result),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (inner) => new PostgresIntrospector(inner),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [capture],
  });
  await db.transaction().execute(run);
  await db.destroy();
  return queries;
}

function oneStatement(queries: readonly CompiledQuery[]): string {
  expect(queries).toHaveLength(1);
  return queries[0]!.sql;
}

it('[AC-B2-17#20] lockDiffs：本应用、按 id 升序、FOR UPDATE，名单以 text[] 读出；空列表不发语句', async () => {
  const text = oneStatement(
    await compiled((trx) => adjustmentReconStore.lockDiffs(trx, APP, [D1])),
  );
  expect(text).toMatch(/from "app"\."recon_diffs"/);
  expect(text).toMatch(/"app_id" = \$1/);
  expect(text).toMatch(/involved_user_ids::text\[\]/);
  expect(text).toMatch(/order by "id" for update$/);
  expect(await compiled((trx) => adjustmentReconStore.lockDiffs(trx, APP, []))).toEqual([]);
});

it('[AC-B2-17#1] insertLink：普通的 insert into app.adjustment_recon_diffs，六列，reversed_by_adjust_id 为空', async () => {
  const queries = await compiled((trx) =>
    adjustmentReconStore.insertLink(trx, {
      appId: APP,
      adjustId: ADJ,
      reconDiffId: D1,
      userId: USER,
      at: AT,
    }),
  );
  const text = oneStatement(queries);
  expect(LINK_WRITE.test(text)).toBe(true);
  expect(text).toMatch(
    /^insert into "app"\."adjustment_recon_diffs" \("app_id", "adjust_id", "recon_diff_id", "user_id", "reversed_by_adjust_id", "created_at"\)/,
  );
  expect(queries[0]!.parameters).toEqual([APP, ADJ, D1, USER, null, AT]);
});

it('[AC-B2-17#1] markAdjusted：update app.recon_diffs 只写 status、handler_id、closed_at、updated_at，条件 status in (open, processing)', async () => {
  const queries = await compiled((trx) =>
    adjustmentReconStore.markAdjusted(trx, { appId: APP, id: D1, handlerId: USER, at: AT }),
  );
  const text = oneStatement(queries);
  expect(DIFF_WRITE.test(text)).toBe(true);
  expect(text).toMatch(
    /^update "app"\."recon_diffs" set "status" = \$1, "handler_id" = \$2, "closed_at" = \$3, "updated_at" = \$4 where/,
  );
  expect(text).toMatch(/"status" in \(\$\d+, \$\d+\)$/);
  expect(queries[0]!.parameters).toEqual(['adjusted', USER, AT, AT, APP, D1, 'open', 'processing']);
});

it('[AC-B2-17#5] markProcessing：只写 status、updated_at，只对 open 的行', async () => {
  const queries = await compiled((trx) =>
    adjustmentReconStore.markProcessing(trx, { appId: APP, id: D1, at: AT }),
  );
  const text = oneStatement(queries);
  expect(DIFF_WRITE.test(text)).toBe(true);
  expect(text).toMatch(/^update "app"\."recon_diffs" set "status" = \$1, "updated_at" = \$2 where/);
  expect(queries[0]!.parameters).toEqual(['processing', AT, APP, D1, 'open']);
});

it('[AC-B2-17#12] markLinksReversed：update app.adjustment_recon_diffs 只写 reversed_by_adjust_id，只对原单未红冲的行', async () => {
  const queries = await compiled((trx) =>
    adjustmentReconStore.markLinksReversed(trx, { appId: APP, adjustId: ADJ, reversalId: REV }),
  );
  const text = oneStatement(queries);
  expect(LINK_WRITE.test(text)).toBe(true);
  expect(text).toMatch(/^update "app"\."adjustment_recon_diffs" set "reversed_by_adjust_id" = \$1/);
  expect(text).toMatch(/"reversed_by_adjust_id" is null returning "recon_diff_id"$/);
  expect(queries[0]!.parameters).toEqual([REV, APP, ADJ]);
});

it('[AC-B2-17#16] sendBack：只对 adjusted 写 status=processing、closed_at 置空、updated_at；同 (app, type, ref_id) 另有未解决的非 order ledger_mismatch 时不写（⑯）', async () => {
  const queries = await compiled((trx) =>
    adjustmentReconStore.sendBack(trx, { appId: APP, id: D1, at: AT }),
  );
  const text = oneStatement(queries);
  expect(DIFF_WRITE.test(text)).toBe(true);
  expect(text).toMatch(
    /^update "app"\."recon_diffs" as "d" set "status" = \$1, "closed_at" = \$2, "updated_at" = \$3 where/,
  );
  expect(text).toMatch(/not exists \(select 1 as "one" from "app"\."recon_diffs" as "o"/);
  for (const ref of ['app_id', 'type', 'ref_id']) {
    expect(text).toContain(`"o"."${ref}" = "d"."${ref}"`);
  }
  expect(text).toContain('"o"."id" <> "d"."id"');
  expect(queries[0]!.parameters).toEqual([
    'processing',
    null,
    AT,
    APP,
    D1,
    'adjusted',
    'ledger_mismatch',
    'order',
    'open',
    'processing',
    'order',
  ]);
});

it('[AC-B2-17#7] activeLinks / linkedDiffIds：只读未红冲的关联行，不加锁', async () => {
  const active = oneStatement(
    await compiled((trx) => adjustmentReconStore.activeLinks(trx, APP, [D1])),
  );
  expect(active).toMatch(/from "app"\."adjustment_recon_diffs"/);
  expect(active).toMatch(/"reversed_by_adjust_id" is null$/);
  const linked = oneStatement(
    await compiled((trx) => adjustmentReconStore.linkedDiffIds(trx, APP, ADJ)),
  );
  expect(linked).toMatch(/"reversed_by_adjust_id" is null order by "recon_diff_id"$/);
  expect(linked).not.toMatch(/for update/);
});
