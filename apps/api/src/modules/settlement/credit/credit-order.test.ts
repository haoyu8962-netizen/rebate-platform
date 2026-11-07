// Unit tests of the B2-04zzc invite trigger call in R5, without a database. Kysely runs on a
// scripted driver that answers the credit's own statements (order locator, advisory lock, order
// row, settlement seq, open deductions, CAS, history row) and records their order next to the
// port calls. The real PostgreSQL behaviour is covered by test/spec/settlement/credit-invite-trigger.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type Transaction,
} from 'kysely';
import { expect, it } from 'vitest';
import { bookedBaseOrderFacts, type BookedBaseReader } from '../../../app.module.ts';
import { FixedClock } from '../../platform/index.ts';
import {
  createCreditOrder,
  type CreditInviteTrigger,
  type CreditInviteTriggerInput,
  type CreditOrderDependencies,
} from './credit-order.ts';

const APP = 'unit-app';
const ORDER = randomUUID();
const ATTR_AT = new Date('2032-06-20T02:00:00Z');

interface Scenario {
  readonly rebateStatus?: string;
  readonly reserveBp?: number;
  readonly settleFen?: bigint;
}

function setup(scenario: Scenario = {}) {
  const log: string[] = [];
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;
  const order = {
    app_id: APP,
    order_id: ORDER,
    platform: 'taobao',
    sub_order_id: 'unit-sub-1',
    attr_at: ATTR_AT,
    rebate_status: scenario.rebateStatus ?? 'WAITING',
    hold: false,
    rights_pending: false,
    settle_commission_fen: scenario.settleFen ?? 1000n,
    commission_version: 1,
    row_version: 0,
  };
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      if (text.includes('pg_advisory_xact_lock')) {
        log.push('sql:lock');
        return Promise.resolve(result([{}]));
      }
      if (/^update "app"\."orders"/u.test(text)) {
        log.push('sql:cas');
        return Promise.resolve(result([], 1n));
      }
      if (/^insert into/u.test(text)) {
        log.push('sql:insert');
        return Promise.resolve(result([], 1n));
      }
      if (text.includes('"order_settlements"')) {
        log.push('sql:seq');
        return Promise.resolve(result([{ seq: 1 }]));
      }
      if (text.includes('"order_rights"')) {
        log.push('sql:deductions');
        return Promise.resolve(result([]));
      }
      if (text.includes('from "app"."orders"')) {
        log.push('sql:order');
        return Promise.resolve(result([order]));
      }
      if (/^(begin|commit|rollback)/iu.test(text)) return Promise.resolve(result([]));
      return Promise.reject(new Error(`unexpected statement: ${text}`));
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const triggerCalls: { inTransaction: boolean; input: CreditInviteTriggerInput }[] = [];
  const inviteTrigger: CreditInviteTrigger = {
    async onCredited(trx, input) {
      log.push('port:invite');
      triggerCalls.push({ inTransaction: trx.isTransaction, input });
    },
  };
  const deps = (withTrigger: boolean): CreditOrderDependencies => ({
    ...(withTrigger ? { inviteTrigger } : {}),
    clock: new FixedClock('2032-07-24T10:00:00+08:00'),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ledger: {
      openUserAccount: async () => {
        throw new Error('no beneficiary in these tests');
      },
      lockBalances: async () => [],
      post: async () => {
        log.push('port:post');
        return undefined as never;
      },
    },
    gate: { lockUsers: async () => new Set<string>(), readStates: async () => new Map() },
    readAttribution: async () => ({
      reserveBp: scenario.reserveBp ?? 0,
      beneficiaries: [],
      forfeitedEvents: [],
    }),
    readSnapshot: async () => {
      throw new Error('readSnapshot is never called when readAttribution is given');
    },
    readTljDeductFen: async () => 0n,
    appendBeneficiaryEvent: async () => {},
    events: {
      publish: async (_trx, event) => {
        log.push(`publish:${event.name}`);
        return undefined as never;
      },
    },
  });
  async function credit(withTrigger: boolean) {
    const creditOrder = createCreditOrder(deps(withTrigger));
    return db.transaction().execute((trx: Transaction<DB>) =>
      creditOrder.credit(trx, {
        appId: APP,
        orderId: ORDER,
        expectedSettleSeq: 1,
        openedRef: 'unit-item',
      }),
    );
  }
  return { log, triggerCalls, credit };
}

it('[AC-B2-04zzc#5] R5 在 CAS 与历史行之后、发布 order.credited 之前调用触发端口一次（同一事务，入参带入账基数 booked_base_fen）', async () => {
  const s = setup();
  const answer = await s.credit(true);
  expect(answer).toMatchObject({ outcome: 'credited', bCreditFen: 1000n });
  expect(s.triggerCalls).toStrictEqual([
    { inTransaction: true, input: { app_id: APP, order_id: ORDER, booked_base_fen: 1000n } },
  ]);
  const cas = s.log.indexOf('sql:cas');
  const history = s.log.lastIndexOf('sql:insert');
  const invite = s.log.indexOf('port:invite');
  const published = s.log.indexOf('publish:order.credited');
  expect(cas).toBeGreaterThan(-1);
  expect(history).toBeGreaterThan(cas);
  expect(invite).toBeGreaterThan(history);
  expect(published).toBeGreaterThan(invite);
});

it('[AC-B2-04zzc#14] 入账基数 booked_base_fen = 0（预留 10000）的单照常入账、不调用触发端口（D10-810）', async () => {
  const s = setup({ reserveBp: 10000 });
  const answer = await s.credit(true);
  expect(answer).toMatchObject({ outcome: 'credited', bCreditFen: 0n });
  expect(s.triggerCalls).toStrictEqual([]);
  expect(s.log).toContain('publish:order.credited');
});

it('[AC-B2-04zzc#13] 订单已不是 WAITING（如 R13 恢复后的 CREDITED）按 not_waiting 跳过，不调用触发端口、不发布事件', async () => {
  const s = setup({ rebateStatus: 'CREDITED' });
  const answer = await s.credit(true);
  expect(answer).toStrictEqual({ outcome: 'skipped', reason: 'not_waiting' });
  expect(s.triggerCalls).toStrictEqual([]);
  expect(s.log).not.toContain('sql:cas');
  expect(s.log).not.toContain('publish:order.credited');
});

it('[AC-B2-04zzc#2] 不接触发端口时 R5 照常入账并发布 order.credited（端口可选）', async () => {
  const s = setup();
  const answer = await s.credit(false);
  expect(answer).toMatchObject({ outcome: 'credited', bCreditFen: 1000n });
  expect(s.triggerCalls).toStrictEqual([]);
  expect(s.log).not.toContain('port:invite');
  expect(s.log).toContain('publish:order.credited');
});

// D10-810 (money r1 S1): the order fact layer app.module puts under growth's trigger, its daily
// expiry (late trigger) and its payout scan: a CREDITED order's base_fen is its booked base.
type OrderFacts = Parameters<typeof bookedBaseOrderFacts>[0];
type OrderFact = NonNullable<Awaited<ReturnType<OrderFacts['read']>>>;

function orderFact(orderId: string, rebateStatus: string, baseFen: bigint | null): OrderFact {
  return {
    app_id: APP,
    order_id: orderId,
    user_id: 'invitee',
    buy_type: 'self',
    base_fen: baseFen,
    pay_amount_fen: 4990n,
    attr_at: ATTR_AT,
    credited_at: rebateStatus === 'CREDITED' ? ATTR_AT : null,
    rebate_status: rebateStatus,
    refunded_quantity: 0,
    refunded_quantity_at_credit: 0,
    rights_pending: false,
    has_rights: false,
  };
}

function factsOver(rows: readonly OrderFact[], booked: Record<string, bigint | null>) {
  const asked: { appId: string; orderIds: readonly string[] }[] = [];
  const readBooked: BookedBaseReader = (_trx, appId, orderIds) => {
    asked.push({ appId, orderIds });
    return Promise.resolve(
      new Map(orderIds.filter((id) => id in booked).map((id) => [id, booked[id] ?? null])),
    );
  };
  const inner: OrderFacts = {
    read: (_trx, input) =>
      Promise.resolve(rows.find((row) => row.order_id === input.order_id) ?? null),
    listSelfOrdersInWindow: () => Promise.resolve(rows),
  };
  return { facts: bookedBaseOrderFacts(inner, readBooked), asked };
}

const TRX = {} as Transaction<DB>;
const WINDOW = { app_id: APP, user_id: 'invitee', from: ATTR_AT, to: ATTR_AT };

it('[AC-B2-04zzc#u1] 过期扫描读期内自购单：CREDITED 单的 base_fen 换成入账基数（预估 320、入账 0 → 0），未入账单保持预估、不查入账基数', async () => {
  const { facts, asked } = factsOver(
    [orderFact('credited', 'CREDITED', 320n), orderFact('waiting', 'WAITING', 320n)],
    { credited: 0n },
  );
  const list = await facts.listSelfOrdersInWindow(TRX, WINDOW);
  expect(list.map((row) => [row.order_id, row.base_fen])).toStrictEqual([
    ['credited', 0n],
    ['waiting', 320n],
  ]);
  expect(asked).toStrictEqual([{ appId: APP, orderIds: ['credited'] }]);
});

it('[AC-B2-04zzc#u2] 对照：CREDITED 单入账 1000、预估 0 → base_fen 取 1000（迟到触发仍按入账基数成立）', async () => {
  const { facts } = factsOver([orderFact('credited', 'CREDITED', 0n)], { credited: 1000n });
  const list = await facts.listSelfOrdersInWindow(TRX, WINDOW);
  expect(list.map((row) => row.base_fen)).toStrictEqual([1000n]);
  expect(await facts.read(TRX, { app_id: APP, order_id: 'credited' })).toMatchObject({
    base_fen: 1000n,
  });
});

it('[AC-B2-04zzc#u3] CREDITED 单查不到入账基数（或为 null）→ base_fen 为 null，不当作 B > 0；单不存在 → null；没有 CREDITED 单 → 不查入账基数', async () => {
  const { facts, asked } = factsOver(
    [orderFact('unbooked', 'CREDITED', 320n), orderFact('nulled', 'CREDITED', 320n)],
    { nulled: null },
  );
  const list = await facts.listSelfOrdersInWindow(TRX, WINDOW);
  expect(list.map((row) => row.base_fen)).toStrictEqual([null, null]);
  expect(await facts.read(TRX, { app_id: APP, order_id: 'missing' })).toBeNull();
  expect(asked).toStrictEqual([{ appId: APP, orderIds: ['unbooked', 'nulled'] }]);

  const waiting = factsOver([orderFact('waiting', 'WAITING', 320n)], {});
  expect(await waiting.facts.read(TRX, { app_id: APP, order_id: 'waiting' })).toMatchObject({
    base_fen: 320n,
  });
  expect(waiting.asked).toStrictEqual([]);
});
