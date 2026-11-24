// 单元测试（不连库）：B2-04re 执行器明细事务的平台结算互斥锁（BR-FUND-16 加锁流程第 0 步）与取锁之后复核
// 入账开关（BR-FUND-04 ⑦）。Kysely 跑在记录语句与 BEGIN / COMMIT / ROLLBACK 的脚本化驱动上，不模拟 PG；
// 入账端口是假的：只在调用方的事务上发一条订单键锁语句（与 orders 的 lockOrderKey 同形），再回结果。
// 真实并发与锁等待由规则测试 test/spec/settlement/credit-gate 覆盖。
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type Transaction,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { createBatchExecutor, type BatchExecutorDependencies } from './executor.ts';

const APP = 'unit-app';
const BATCH = '01900000-0000-7000-8000-000000000001';
const NOW = new Date('2032-07-26T10:00:00+08:00');
/** credit-gate.ts 的事务级共享语句（逐字）。 */
const GATE_SHARED = 'select pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))';
const ORDER_LOCK = 'select pg_advisory_xact_lock(hashtextextended($1, 0))';

type Entry = { readonly sql: string; readonly params: readonly unknown[] } | string;

interface ItemSpec {
  readonly id: string;
  readonly type: 'order' | 'beneficiary';
  readonly sub: string;
}

function setup(options: {
  readonly platform: string;
  readonly items: readonly ItemSpec[];
  /** 看到第一条平台共享锁语句之后，config 对这个键回 off（模拟等锁期间开关被关、缓存已过期）。 */
  readonly offAfterGate?: string;
  /** 注入时钟（缺省为不动的 NOW）。 */
  readonly clock?: FixedClock;
  /** 自定义 config 读口（第三个参数：是否已见过平台共享锁）；给了就取代 offAfterGate 的缺省读口。 */
  readonly config?: (app: string, key: string, gateSeen: boolean) => Promise<unknown>;
}) {
  const log: Entry[] = [];
  let gateSeen = false;
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql.trim();
      log.push({ sql: text, params: compiled.parameters });
      if (text === GATE_SHARED) {
        gateSeen = true;
        return Promise.resolve(result([]));
      }
      if (/pg_try_advisory_lock/.test(text)) return Promise.resolve(result([{ locked: true }]));
      if (/advisory/.test(text)) return Promise.resolve(result([]));
      if (/^select .* from "app"\."settle_batches"/.test(text)) {
        return Promise.resolve(
          result([
            {
              batch_id: BATCH,
              app_id: APP,
              bill_id: '2032-06',
              platform: options.platform,
              kind: 'supplement',
              status: 'EXECUTING',
              settle_mode: 'IMMEDIATE',
              scheduled_at: null,
              paused_by_switch_at: null,
              settle_run_id: null,
              row_version: 1,
            },
          ]),
        );
      }
      if (/^update "app"\."settle_batches"/.test(text)) return Promise.resolve(result([], 1n));
      if (/^select .* from "app"\."settle_batch_items" as "i"/.test(text)) {
        return Promise.resolve(
          result(
            options.items.map((i) => ({
              id: i.id,
              item_type: i.type,
              order_id: `o-${i.sub}`,
              user_id: i.type === 'beneficiary' ? 'u-1' : null,
              role: i.type === 'beneficiary' ? 'direct' : null,
              beneficiary_credit_id: i.type === 'beneficiary' ? `bc-${i.sub}` : null,
              settle_seq: 1,
              platform: options.platform,
              sub_order_id: i.sub,
            })),
          ),
        );
      }
      if (/^select count\(\*\) as "n" from "app"\."settle_batch_items"/.test(text)) {
        return Promise.resolve(result([{ n: '0' }]));
      }
      if (/^update "app"\."settle_batch_items"/.test(text)) return Promise.resolve(result([], 1n));
      return Promise.reject(new Error(`unscripted statement: ${text}`));
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => {
      log.push('BEGIN');
    },
    commitTransaction: async () => {
      log.push('COMMIT');
    },
    rollbackTransaction: async () => {
      log.push('ROLLBACK');
    },
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const orderLock = async (trx: Transaction<DB>, orderId: string) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${orderId}, 0))`.execute(trx);
  };
  const credits: string[] = [];
  /** 每次 config 读的键，按先后。 */
  const reads: string[] = [];
  const deps: BatchExecutorDependencies = {
    db,
    clock: options.clock ?? new FixedClock(NOW),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    config: {
      get: async (app, key) => {
        reads.push(key);
        if (options.config !== undefined) return options.config(app, key, gateSeen);
        return gateSeen && key === options.offAfterGate ? 'off' : 'on';
      },
    },
    snapshotStatus: async () => ({ state: 'complete', snapshotId: 's-1', waitingComparable: true }),
    creditOrder: {
      credit: async (trx, input) => {
        await orderLock(trx, input.orderId);
        credits.push(input.orderId);
        return { outcome: 'credited' } as Awaited<
          ReturnType<BatchExecutorDependencies['creditOrder']['credit']>
        >;
      },
    },
    creditBeneficiary: {
      execute: async (trx, input) => {
        await orderLock(trx, input.orderId);
        credits.push(`${input.orderId}:${input.beneficiaryCreditId}`);
        return { result: 'credited', amountFen: 85n };
      },
    },
    events: { publish: async () => ({ eventId: 'e-1', duplicate: false }) },
  };
  const executor = createBatchExecutor(deps);
  /** 每段 BEGIN … COMMIT / ROLLBACK 里的语句文本。 */
  const transactions = () => {
    const out: { statements: string[]; end: string }[] = [];
    let current: string[] | null = null;
    for (const e of log) {
      if (e === 'BEGIN') current = [];
      else if ((e === 'COMMIT' || e === 'ROLLBACK') && current !== null) {
        out.push({ statements: current, end: e });
        current = null;
      } else if (typeof e !== 'string' && current !== null) current.push(e.sql);
    }
    return out;
  };
  return { executor, log, transactions, credits, reads };
}

/** 明细事务 = 含平台共享锁、或写 settle_batch_items 的事务。 */
function itemTransactions(t: ReturnType<typeof setup>) {
  return t
    .transactions()
    .filter(
      (x) =>
        x.statements.includes(GATE_SHARED) ||
        x.statements.some((s) => /^update "app"\."settle_batch_items"/.test(s)),
    );
}

it('[AC-B2-04re-UNIT#7] 每条明细事务的第一条语句是平台共享锁，先于任何订单键锁：同一次投递的第一条、第二条首次入账明细与受益人补记明细都取（京东）', async () => {
  const t = setup({
    platform: 'jd',
    items: [
      { id: 'i-1', type: 'order', sub: 'a' },
      { id: 'i-2', type: 'order', sub: 'b' },
      { id: 'i-3', type: 'beneficiary', sub: 'c' },
    ],
  });

  const out = await t.executor.run({ appId: APP, batchId: BATCH });

  expect(out.outcome).toBe('done');
  expect(t.credits).toEqual(['o-a', 'o-b', 'o-c:bc-c']);
  const items = itemTransactions(t);
  expect(items).toHaveLength(3);
  for (const x of items) {
    expect(x.end).toBe('COMMIT');
    expect(x.statements[0]).toBe(GATE_SHARED);
    expect(x.statements.filter((s) => s === GATE_SHARED)).toHaveLength(1);
    const orderLock = x.statements.indexOf(ORDER_LOCK);
    expect(orderLock).toBeGreaterThan(0);
  }
  const gates = t.log.filter(
    (e): e is { sql: string; params: readonly unknown[] } =>
      typeof e !== 'string' && e.sql === GATE_SHARED,
  );
  expect(gates.map((g) => g.params)).toEqual(
    Array.from({ length: 3 }, () => ['settlement.credit_gate', `${APP}:jd`]),
  );
});

for (const key of ['credit.enabled.taobao', 'settle.auto.enabled']) {
  it(`[AC-B2-04re-UNIT#8] 取到平台共享锁之后复核开关：${key} 已关 → 这条明细事务不入账、不写任何东西并回滚，批次照 SB7 进 PARTIAL`, async () => {
    const t = setup({
      platform: 'taobao',
      items: [{ id: 'i-1', type: 'order', sub: 'a' }],
      offAfterGate: key,
    });

    const out = await t.executor.run({ appId: APP, batchId: BATCH });

    expect(out.outcome).toBe('partial');
    expect(t.credits).toEqual([]);
    const items = itemTransactions(t);
    expect(items).toEqual([{ statements: [GATE_SHARED], end: 'ROLLBACK' }]);
    // SB7：之后一个事务把批次 EXECUTING → PARTIAL。
    const all = t.transactions();
    const after = all.slice(all.findIndex((x) => x.statements.includes(GATE_SHARED)) + 1);
    expect(after).toHaveLength(1);
    expect(after[0]!.end).toBe('COMMIT');
    expect(after[0]!.statements).toEqual([
      expect.stringMatching(/^update "app"\."settle_batches" set "status" = \$1/),
    ]);
  });
}

const AUTO = 'settle.auto.enabled';
const CREDIT_TB = 'credit.enabled.taobao';
/** content 的 SWITCH_CACHE_TTL_MS（5 秒）；超过它 1 毫秒即为超时。 */
const OVER_TTL_MS = 12_000;

/** 把批次改成 PARTIAL 的写入（SB7）。 */
function partialWrites(t: ReturnType<typeof setup>) {
  return t.log.filter(
    (e): e is { sql: string; params: readonly unknown[] } =>
      typeof e !== 'string' &&
      /^update "app"\."settle_batches" set "status" = \$1/.test(e.sql) &&
      e.params.includes('PARTIAL'),
  );
}

it('[AC-B2-04re-UNIT#22] 取到共享锁后的复核：总开关读到 on，平台开关读取期间时钟前进 12 秒且总开关被关 → 重读读到 off：不入账，明细事务只有锁语句并回滚，批次走 SB7 到 PARTIAL', async () => {
  const clock = new FixedClock(NOW);
  let autoOff = false;
  let slowDone = false;
  const t = setup({
    platform: 'taobao',
    items: [{ id: 'i-1', type: 'order', sub: 'a' }],
    clock,
    config: async (_app, key, gateSeen) => {
      if (key === AUTO) return autoOff ? 'off' : 'on';
      // 锁后复核的第一组：平台开关读得慢，期间总开关被改成 off 并提交。
      if (gateSeen && !slowDone) {
        slowDone = true;
        clock.advanceMs(OVER_TTL_MS);
        autoOff = true;
      }
      return 'on';
    },
  });

  const out = await t.executor.run({ appId: APP, batchId: BATCH });

  expect(out.outcome).toBe('partial');
  expect(t.credits).toEqual([]);
  expect(itemTransactions(t)).toEqual([{ statements: [GATE_SHARED], end: 'ROLLBACK' }]);
  expect(partialWrites(t)).toHaveLength(1);
  // 明细事务之前一组（2 次）+ 锁后慢的一组（2 次）+ 重读一组（总开关读到 off 即返回，只 1 次）。
  expect(t.reads).toEqual([AUTO, CREDIT_TB, AUTO, CREDIT_TB, AUTO]);
});

it('[AC-B2-04re-UNIT#23] 平台开关读得慢、两个开关一直是 on：重读一次在时限内读完后照常入账；读取次数为一组慢的加一组快的', async () => {
  const clock = new FixedClock(NOW);
  let slowDone = false;
  const t = setup({
    platform: 'taobao',
    items: [{ id: 'i-1', type: 'order', sub: 'a' }],
    clock,
    config: async (_app, key, gateSeen) => {
      if (key === CREDIT_TB && gateSeen && !slowDone) {
        slowDone = true;
        clock.advanceMs(OVER_TTL_MS);
      }
      return 'on';
    },
  });

  const out = await t.executor.run({ appId: APP, batchId: BATCH });

  expect(out.outcome).toBe('done');
  expect(t.credits).toEqual(['o-a']);
  const items = itemTransactions(t);
  expect(items).toHaveLength(1);
  expect(items[0]!.end).toBe('COMMIT');
  expect(items[0]!.statements[0]).toBe(GATE_SHARED);
  // 明细事务之前一组 + 锁后慢的一组 + 锁后快的一组。
  expect(t.reads).toEqual([AUTO, CREDIT_TB, AUTO, CREDIT_TB, AUTO, CREDIT_TB]);
  expect(partialWrites(t)).toHaveLength(0);
});

it('[AC-B2-04re-UNIT#24] 每一组都超时（持续慢）：抛出专门的错误，不入账，没有任何把批次改成 PARTIAL 的写入，明细事务回滚', async () => {
  const clock = new FixedClock(NOW);
  const t = setup({
    platform: 'taobao',
    items: [{ id: 'i-1', type: 'order', sub: 'a' }],
    clock,
    config: async (_app, key, gateSeen) => {
      if (key === CREDIT_TB && gateSeen) clock.advanceMs(OVER_TTL_MS);
      return 'on';
    },
  });

  await expect(t.executor.run({ appId: APP, batchId: BATCH })).rejects.toMatchObject({
    name: 'SwitchReadStale',
  });

  expect(t.credits).toEqual([]);
  expect(itemTransactions(t)).toEqual([{ statements: [GATE_SHARED], end: 'ROLLBACK' }]);
  expect(partialWrites(t)).toHaveLength(0);
  expect(
    t.log.some((e) => typeof e !== 'string' && /^update "app"\."settle_batch_items"/.test(e.sql)),
  ).toBe(false);
  // 明细事务之前一组 + 锁后有上限的几组，都是成对读。
  const afterFirst = t.reads.slice(2);
  expect(afterFirst.length).toBeGreaterThanOrEqual(4);
  expect(afterFirst.length % 2).toBe(0);
});

it('[AC-B2-04re-UNIT#25] 明细事务之前就持续慢：抛出专门的错误，不开明细事务、不入账、不写 PARTIAL', async () => {
  const clock = new FixedClock(NOW);
  const t = setup({
    platform: 'taobao',
    items: [{ id: 'i-1', type: 'order', sub: 'a' }],
    clock,
    config: async (_app, key) => {
      if (key === CREDIT_TB) clock.advanceMs(OVER_TTL_MS);
      return 'on';
    },
  });

  await expect(t.executor.run({ appId: APP, batchId: BATCH })).rejects.toMatchObject({
    name: 'SwitchReadStale',
  });

  expect(t.credits).toEqual([]);
  expect(itemTransactions(t)).toEqual([]);
  expect(partialWrites(t)).toHaveLength(0);
});

it('[AC-B2-04re-UNIT#26] 正常情形（时钟不动）：每次判断恰读两个开关各一次——明细事务之前一组、取锁之后一组', async () => {
  const t = setup({
    platform: 'taobao',
    items: [
      { id: 'i-1', type: 'order', sub: 'a' },
      { id: 'i-2', type: 'order', sub: 'b' },
    ],
  });

  const out = await t.executor.run({ appId: APP, batchId: BATCH });

  expect(out.outcome).toBe('done');
  expect(t.credits).toEqual(['o-a', 'o-b']);
  expect(t.reads).toEqual([AUTO, CREDIT_TB, AUTO, CREDIT_TB, AUTO, CREDIT_TB, AUTO, CREDIT_TB]);
});

it('[AC-B2-04re-UNIT#27] 取到共享锁后的复核：第一组两个开关都 on 但超时、触发重读；重读时总开关读到 off → 不再读平台开关（读口此时会抛错）、不抛异常、不入账，明细事务只有锁语句并回滚，批次走 SB7 到 PARTIAL', async () => {
  const clock = new FixedClock(NOW);
  let lockedRounds = 0;
  const t = setup({
    platform: 'taobao',
    items: [{ id: 'i-1', type: 'order', sub: 'a' }],
    clock,
    config: async (_app, key, gateSeen) => {
      if (!gateSeen) return 'on';
      if (key === AUTO) {
        lockedRounds += 1;
        return lockedRounds === 1 ? 'on' : 'off';
      }
      // 锁后第一组：平台开关读到 on，但读得慢（超过时限）。
      if (lockedRounds === 1) {
        clock.advanceMs(OVER_TTL_MS);
        return 'on';
      }
      // 重读那一组：平台开关的读口失败（连接短暂中断）。
      throw new Error('config read failed');
    },
  });

  const out = await t.executor.run({ appId: APP, batchId: BATCH });

  expect(out.outcome).toBe('partial');
  expect(t.credits).toEqual([]);
  expect(itemTransactions(t)).toEqual([{ statements: [GATE_SHARED], end: 'ROLLBACK' }]);
  expect(partialWrites(t)).toHaveLength(1);
  // 明细事务之前一组 + 锁后慢的一组 + 重读一组（以总开关那一次结束）。
  expect(t.reads).toEqual([AUTO, CREDIT_TB, AUTO, CREDIT_TB, AUTO]);
});
