// 不连数据库的单元测试：Kysely 跑在脚本化驱动上，记录每条编译后的语句并按语句内容回放预置行。
// 订单与佣金的公共端口照真实代码编译 SQL；终态过滤在 PostgreSQL 上的效果由规则测试钉住
// （test/spec/notification/claim-result-terminal）。这里钉 B1-18kn（D10-1274）的接线：
// 找回结果通知读受益人时一定带终态过滤，终态订单（驱动不返行）按 0 计，全部终态照发「预估返 ¥0」。
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
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type ReceivedEvent } from '../../platform/index.ts';
import { createClaimResultMessageHandler } from './claim-result-message.ts';

const APP_ID = 'app-unit';
const CLAIM_ID = '0192f000-0000-7000-8000-0000000000a1';
const APPLICANT = 'u-applicant';
const LIVE_ORDER = '0192f000-0000-7000-8000-0000000000b1';
const TERMINAL_ORDER = '0192f000-0000-7000-8000-0000000000b2';

interface Item {
  readonly order_id: string;
  readonly decision: 'approved' | 'rejected';
  readonly reject_reason: string | null;
}

/**
 * claim 行 + 条目；beneficiaries 按订单给出「库里在终态过滤后剩下的」金额行（终态订单给空）。
 * 受益人查询若不带终态过滤直接失败，避免回放出与真实库不一致的结果。
 */
function setup(items: readonly Item[], beneficiaries: Readonly<Record<string, unknown[]>>) {
  const statements: CompiledQuery[] = [];
  function answer(compiled: CompiledQuery): readonly unknown[] {
    const sql = compiled.sql;
    if (sql.includes('from "app"."claims"')) {
      return items.map((item, index) => ({
        claim_id: CLAIM_ID,
        applicant_user_id: APPLICANT,
        status: 'approved',
        item_id: `item-${index}`,
        ...item,
      }));
    }
    if (sql.startsWith('insert into "app"."notify_logs"')) return [{ id: 'log-1' }];
    if (sql.includes('from "app"."commission_split_amounts"')) {
      if (!sql.includes('"o"."rebate_status" not in ($1, $2)')) {
        throw new Error('受益人查询缺少终态过滤');
      }
      const params = compiled.parameters;
      expect(params.slice(0, 2)).toEqual(['VOID', 'CLAWED_BACK']);
      return beneficiaries[params[3] as string] ?? [];
    }
    if (sql.includes('from "app"."notify_templates"')) return [];
    if (sql.startsWith('insert into "app"."inbox_messages"')) return [];
    if (/^(begin|commit|rollback)/i.test(sql)) return [];
    throw new Error(`unexpected statement: ${sql}`);
  }
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      return Promise.resolve({ rows: answer(compiled) } as unknown as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

function event(status: 'approved' | 'rejected'): ReceivedEvent {
  return {
    eventId: '0192f000-0000-7000-8000-000000000001',
    appId: APP_ID,
    name: 'claim.resolved',
    version: 1,
    occurredAt: '2026-11-12T00:00:00.000Z',
    consumer: 'notification-claim-result',
    attempt: 1,
    payload: { app_id: APP_ID, claim_id: CLAIM_ID, user_id: APPLICANT, status },
  };
}

async function deliver(
  status: 'approved' | 'rejected',
  items: readonly Item[],
  beneficiaries: Readonly<Record<string, unknown[]>>,
) {
  const { db, statements } = setup(items, beneficiaries);
  const handler = createClaimResultMessageHandler({
    clock: new FixedClock('2026-11-12T00:00:00.000Z'),
  });
  await db.transaction().execute((trx) => handler(event(status), trx));
  const inbox = statements.filter((s) => s.sql.startsWith('insert into "app"."inbox_messages"'));
  const reads = statements.filter((s) => s.sql.includes('from "app"."commission_split_amounts"'));
  return { inbox, reads };
}

/** inbox_messages 插入语句的 body 参数（按列名在 insert 列表里的位置取）。 */
function bodyOf(statement: CompiledQuery | undefined): unknown {
  const columns = /\(([^)]*)\) values/.exec(statement?.sql ?? '')?.[1]?.split(', ') ?? [];
  return statement?.parameters[columns.indexOf('"body"')];
}

const approved = (order_id: string): Item => ({
  order_id,
  decision: 'approved',
  reject_reason: null,
});

it('[AC-B1-18kn-UNIT#3] 通过分支：每张已通过订单读受益人都带终态过滤，终态订单（无行）按 0 计，只合计本人份额', async () => {
  const { inbox, reads } = await deliver(
    'approved',
    [approved(LIVE_ORDER), approved(TERMINAL_ORDER)],
    {
      [LIVE_ORDER]: [
        { user_id: APPLICANT, role: 'self', amount_fen: 4123n },
        { user_id: 'u-other', role: 'direct', amount_fen: 999n },
      ],
    },
  );
  expect(reads.map((s) => s.parameters[3])).toEqual([LIVE_ORDER, TERMINAL_ORDER]);
  expect(inbox).toHaveLength(1);
  expect(bodyOf(inbox[0])).toBe('订单找回成功，预估返 ¥41.23');
});

it('[AC-B1-18kn-UNIT#4] 通过的订单全在终态：照发「预估返 ¥0」，不吞通知', async () => {
  const { inbox, reads } = await deliver('approved', [approved(TERMINAL_ORDER)], {});
  expect(reads).toHaveLength(1);
  expect(inbox).toHaveLength(1);
  expect(bodyOf(inbox[0])).toBe('订单找回成功，预估返 ¥0');
});

it('[AC-B1-18kn-UNIT#5] 驳回分支不变：不读受益人，正文取首个驳回条目的原因', async () => {
  const { inbox, reads } = await deliver(
    'rejected',
    [{ order_id: LIVE_ORDER, decision: 'rejected', reject_reason: 'NO_EVIDENCE' }],
    {},
  );
  expect(reads).toHaveLength(0);
  expect(inbox).toHaveLength(1);
  expect(bodyOf(inbox[0])).toBe('订单找回未通过：没有找到这笔订单经凑狸下单的记录');
});
