// B1-08zi（D10-814 ④，BR-FUND-05）：refunded_quantity_at_credit 与 rebate_status→CREDITED 在入账 CAS 的同一条
// UPDATE 里定格，取值是这一行当时的 refunded_quantity 列本身（不是另读一次再传参）。只编译、不连库：
// DummyDriver 不返回影响行数，所以这里不看返回值，只看发出的语句。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Transaction,
} from 'kysely';
import { expect, it } from 'vitest';
import { casCreditOrder } from '../../../../apps/api/src/modules/settlement/credit/credit-store.ts';

/** `"refunded_quantity_at_credit" = <the refunded_quantity column>`, optionally table-qualified. */
const AT_CREDIT_COPY =
  /"refunded_quantity_at_credit"\s*=\s*(?:"?[a-z_]+"?\.)*"?refunded_quantity\b"?(?!_)/;

function recorder() {
  const statements: string[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (inner) => new PostgresIntrospector(inner),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [
      {
        transformQuery({ node, queryId }) {
          statements.push(new PostgresQueryCompiler().compileQuery(node, queryId).sql);
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      },
    ],
  });
  return { trx: db as unknown as Transaction<DB>, statements };
}

const AT = new Date('2026-11-24T02:00:00.000Z');

it('[AC-B1-08zi#23] casCreditOrder 只发一条 UPDATE：SET 同时有 rebate_status 与 at_credit = refunded_quantity 列', async () => {
  const { trx, statements } = recorder();
  await casCreditOrder(trx, {
    app_id: 'app-synthetic',
    order_id: '0192f0a0-0000-7000-8000-000000000001',
    attr_at: new Date('2026-10-20T03:00:00.000Z'),
    from: 'WAITING',
    to: 'CREDITED',
    row_version: 4,
    booked_base_fen: 1000n,
    booked_n_fen: 1000n,
    at: AT,
  });
  expect(statements).toHaveLength(1);
  const statement = statements[0] ?? '';
  expect(statement).toMatch(/^update "app"\."orders" set /);
  const [set = '', where = ''] = statement.split(' where ');
  expect(set).toMatch(/"rebate_status" = \$\d+/);
  expect(set).toMatch(AT_CREDIT_COPY);
  // 定格只看这一行的列，不带入参：WHERE 仍是原来的 CAS 条件，at_credit 不是条件。
  expect(where).toMatch(/"rebate_status" = \$\d+/);
  expect(where).toMatch(/"row_version" = \$\d+/);
  expect(where).not.toContain('refunded_quantity');
});
