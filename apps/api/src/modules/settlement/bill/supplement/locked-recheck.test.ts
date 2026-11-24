// 单元测试（不连库）：B2-04rd 补充入批的「候选先取订单键锁、锁后经来源读口重读、再定类别」；B2-04re 的平台结算
// 互斥锁（第一次来源读之后、任何保存点与订单键锁之前取排他模式）与去掉锁内「查未执行批次」之后的分块序列。
// Kysely 跑在脚本化的驱动上：只记录语句与参数、按表名回固定行（账单行、任务行、未结义务），不模拟 PG。
// 真实并发与锁等待由规则测试 test/spec/settlement/supplement-locked-recheck 覆盖。
// 金额（自拟）：联盟结算佣金 1000 分，预留 1500 bp → B_settle = floor(1000 × 8500 / 10000) = 850 = 快照 base 850。
import { readdirSync, readFileSync } from 'node:fs';
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
  sql,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { orderLockKeyText } from '../../../orders/index.ts';
import { FixedClock } from '../../../platform/index.ts';
import type {
  BillSourceOrder,
  BillSourceRow,
  BillSourceSelection,
  BillValidation,
} from '../job.ts';
import { createSupplementCommand, type SupplementDependencies } from './command.ts';
import { LOCK_CHUNK, lockAndReread, subOrderIdOf } from './locked-recheck.ts';

const APP = 'unit-app';
const MONTH = '2032-06';
const PLATFORM = 'taobao';
const LAUNCH = new Date('2032-07-26T10:00:00+08:00');
const BEFORE = new Date('2032-07-20T10:00:00+08:00');
const LOCK = /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/;
/** credit-gate.ts 的事务级排他语句（逐字）。 */
const GATE_EXCLUSIVE = 'select pg_advisory_xact_lock(hashtext($1), hashtext($2))';
const ADVISORY = /advisory/i;
const SAVEPOINT = /^savepoint couli_supplement_lock_chunk$/i;
const ROLLBACK_TO = /^rollback to savepoint couli_supplement_lock_chunk$/i;
const RELEASE = /^release savepoint couli_supplement_lock_chunk$/i;
/** B2-04re r2：锁账单行之后、认领任务之前开的保存点（开关复核不过时回滚到它）。 */
const GATE_SP = /^savepoint couli_supplement_gate_recheck$/i;
const GATE_SP_ROLLBACK = /^rollback to savepoint couli_supplement_gate_recheck$/i;
const GATE_SP_RELEASE = /^release savepoint couli_supplement_gate_recheck$/i;
const CLAIM = /^insert into "app"\."settle_jobs"/;
const PENDING = /from "app"\."settle_batch_items"/;
const WRITE = /^\s*(?:insert|update|delete)\b/i;

/** 时间线里一条语句的标签（先匹配的优先）。 */
const LABELS: readonly (readonly [RegExp, string])[] = [
  [GATE_SP, 'gate-savepoint'],
  [GATE_SP_ROLLBACK, 'gate-rollback'],
  [GATE_SP_RELEASE, 'gate-release'],
  [CLAIM, 'claim'],
  [SAVEPOINT, 'savepoint'],
  [ROLLBACK_TO, 'rollback'],
  [RELEASE, 'release'],
  [PENDING, 'pending'],
  [WRITE, 'write'],
];

function traceLabel(compiled: CompiledQuery): string {
  const text = compiled.sql;
  if (text === GATE_EXCLUSIVE) return 'gate';
  if (LOCK.test(text)) return `lock:${String(compiled.parameters[0])}`;
  return LABELS.find(([pattern]) => pattern.test(text))?.[1] ?? 'other';
}

function key(sub: string): string {
  return `${PLATFORM}:${sub}`;
}

function waiting(orderId: string, patch: Partial<BillSourceOrder> = {}): BillSourceOrder {
  return {
    orderId,
    rebateStatus: 'WAITING',
    settlePeriod: MONTH,
    hold: false,
    rightsPending: false,
    commissionVersion: 1,
    unionAuthoritative: false,
    ...patch,
  };
}

function row(
  sub: string,
  order: BillSourceOrder | null,
  settlements: BillSourceRow['settlements'] = [
    { seq: 1, source: 'STATEMENT', createdAt: BEFORE, settledAt: BEFORE, commissionFen: 1000n },
  ],
): BillSourceRow {
  return { orderKey: key(sub), order, settlements };
}

interface Item {
  readonly [column: string]: unknown;
}

interface Setup {
  readonly reads: (readonly BillSourceRow[])[];
  /** 未结补记义务（beneficiary_credits status='open'）。 */
  readonly obligations?: readonly { order_id: string; user_id: string; role: string; id: string }[];
  /** 第一次来源读之后执行（例如推进 Clock）。 */
  readonly afterFirstRead?: (clock: FixedClock) => void;
  /** 第 n 次（从 0 起）「查未执行批次」返回的行；缺省为空。 */
  readonly pendingRows?: (call: number) => readonly Item[];
  /** 注入 SupplementDependencies.lockChunkSize。 */
  readonly lockChunkSize?: number;
  /** 第 n 次（从 0 起）读 credit.enabled.<platform> 的值；超出取最后一个；缺省一律 'on'。 */
  readonly switches?: readonly unknown[];
  /** 认领任务判为重放（同键已 done）。 */
  readonly duplicate?: boolean;
}

function setup(s: Setup) {
  const clock = new FixedClock(LAUNCH);
  const events: string[] = [];
  const statements: CompiledQuery[] = [];
  const items: Item[] = [];
  /** 来源读与语句合在一起的时间线：readSource / gate / gate-savepoint / gate-rollback / gate-release / claim / savepoint / lock:<键> / pending / rollback / release / write / other。 */
  const trace: string[] = [];
  let pendingCalls = 0;
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;

  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      statements.push(compiled);
      trace.push(traceLabel(compiled));
      if (text === GATE_EXCLUSIVE) {
        events.push(`gate:${compiled.parameters.map(String).join('|')}`);
        return Promise.resolve(result([]));
      }
      if (PENDING.test(text)) {
        const rows = s.pendingRows?.(pendingCalls) ?? [];
        pendingCalls += 1;
        return Promise.resolve(result([...rows]));
      }
      if (LOCK.test(text)) {
        events.push(`lock:${String(compiled.parameters[0])}`);
        return Promise.resolve(result([]));
      }
      if (/^select .* from "app"\."settle_bills"/.test(text)) {
        return Promise.resolve(
          result([
            {
              bill_id: MONTH,
              generated_at: BEFORE,
              platform_order_counts: { [PLATFORM]: 0 },
            },
          ]),
        );
      }
      if (/^insert into "app"\."settle_jobs"/.test(text)) {
        return Promise.resolve(result(s.duplicate === true ? [] : [{ id: 'job-1' }]));
      }
      if (/^select .* from "app"\."settle_jobs"/.test(text)) {
        return Promise.resolve(result([{ id: 'job-1', status: 'done' }]));
      }
      if (/^update "app"\."settle_jobs"/.test(text)) {
        events.push(`job:${compiled.parameters.slice(1, 3).map(String).join(',')}`);
        return Promise.resolve(result([], 1n));
      }
      if (/from "app"\."beneficiary_credits"/.test(text)) {
        return Promise.resolve(
          result(
            (s.obligations ?? []).map((o) => ({
              beneficiary_credit_id: o.id,
              order_id: o.order_id,
              user_id: o.user_id,
              role: o.role,
            })),
          ),
        );
      }
      const insert = /^insert into "app"\."(settle_batches|settle_batch_items)" \(([^)]*)\)/.exec(
        text,
      );
      if (insert) {
        events.push(`insert:${insert[1]!}`);
        if (insert[1] === 'settle_batch_items') {
          const columns = insert[2]!.split(',').map((c) => c.trim().replace(/"/g, ''));
          const params = compiled.parameters;
          for (let at = 0; at < params.length; at += columns.length) {
            items.push(Object.fromEntries(columns.map((c, i) => [c, params[at + i]])));
          }
        }
        return Promise.resolve(result([], 1n));
      }
      return Promise.resolve(result([]));
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
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  let readCount = 0;
  let switchReads = 0;
  const readSource = vi.fn<SupplementDependencies['readSource']>(async () => {
    events.push('readSource');
    trace.push('readSource');
    const rows = s.reads[Math.min(readCount, s.reads.length - 1)]!;
    readCount += 1;
    if (readCount === 1) s.afterFirstRead?.(clock);
    return rows;
  });
  const saved: BillValidation[] = [];
  const deps: SupplementDependencies = {
    clock,
    config: {
      get: async (_app: string, name: string) => {
        if (name !== `credit.enabled.${PLATFORM}`) return undefined;
        const values = s.switches ?? ['on'];
        const value = values[Math.min(switchReads, values.length - 1)];
        switchReads += 1;
        return value;
      },
    },
    readSource,
    readSnapshot: vi.fn<SupplementDependencies['readSnapshot']>(async () => ({
      baseFen: 850n,
      reserveBp: 1500,
      beneficiaries: [],
      forfeitedEvents: [],
    })),
    readTljDeductFen: vi.fn<SupplementDependencies['readTljDeductFen']>(async () => 0n),
    registerDiff: vi.fn<SupplementDependencies['registerDiff']>(async () => {
      throw new Error('registerDiff not expected in this unit test');
    }),
    saveValidations: vi.fn<SupplementDependencies['saveValidations']>(async (_t, _s, rows) => {
      events.push('saveValidations');
      saved.push(...rows);
    }),
    logger: { warn: () => undefined },
    ...(s.lockChunkSize === undefined ? {} : { lockChunkSize: s.lockChunkSize }),
  };
  const command = createSupplementCommand(deps);
  const input = { appId: APP, billId: MONTH, platform: PLATFORM, requestedAt: LAUNCH };
  return { db, clock, events, statements, trace, items, saved, readSource, command, input };
}

const GATE = `gate:settlement.credit_gate|${APP}:${PLATFORM}`;

function selections(readSource: ReturnType<typeof setup>['readSource']): BillSourceSelection[] {
  return readSource.mock.calls.map((call) => call[1]);
}

it('[AC-B2-04rd-UNIT#1] 两张候选（来源顺序为键降序）：按订单键升序各取一次订单键锁，锁都在第二次来源读之前，写批次在其后；两单照常入批', async () => {
  const first = [row('b-02', waiting('o-b')), row('a-01', waiting('o-a'))];
  const t = setup({ reads: [first, first] });

  const result = await t.command.launch(t.db, t.input);

  const lockA = `lock:${orderLockKeyText(PLATFORM, 'a-01')}`;
  const lockB = `lock:${orderLockKeyText(PLATFORM, 'b-02')}`;
  expect(t.events.slice(0, 5)).toEqual(['readSource', GATE, lockA, lockB, 'readSource']);
  expect(t.events.indexOf('insert:settle_batches')).toBeGreaterThan(4);
  expect(t.readSource).toHaveBeenCalledTimes(2);
  expect(result.batchIds).toHaveLength(1);
  expect(t.items).toEqual([
    expect.objectContaining({
      item_type: 'order',
      order_id: 'o-a',
      settle_seq: 1,
      b_settle_fen: 850n,
    }),
    expect.objectContaining({
      item_type: 'order',
      order_id: 'o-b',
      settle_seq: 1,
      b_settle_fen: 850n,
    }),
  ]);
  // 逐单结果仍按第一次来源行的顺序。
  expect(t.saved.map((v) => [v.orderKey, v.result])).toEqual([
    [key('b-02'), 'candidate'],
    [key('a-01'), 'candidate'],
  ]);
});

it('[AC-B2-04rd-UNIT#2] 已上锁的单按第二次读定类别：候选 → 已入账（出补记项、无首次入账明细）、候选 → 暂缓、候选 → 第二次读里消失（不记结果、不入批）', async () => {
  const first = [
    row('c-credited', waiting('o-c')),
    row('h-held', waiting('o-h')),
    row('v-vanished', waiting('o-v')),
  ];
  const second = [
    row('c-credited', waiting('o-c', { rebateStatus: 'CREDITED' })),
    row('h-held', waiting('o-h', { hold: true })),
  ];
  const t = setup({
    reads: [first, second],
    obligations: [{ order_id: 'o-c', user_id: 'u-direct', role: 'direct', id: 'bc-1' }],
  });

  const result = await t.command.launch(t.db, t.input);

  expect(t.events.filter((e) => e.startsWith('lock:'))).toEqual(
    ['c-credited', 'h-held', 'v-vanished'].map((s) => `lock:${orderLockKeyText(PLATFORM, s)}`),
  );
  expect(t.saved.map((v) => [v.orderKey, v.result])).toEqual([
    [key('c-credited'), 'already_credited'],
    [key('h-held'), 'deferred'],
  ]);
  expect(result.batchIds).toHaveLength(1);
  expect(t.items).toEqual([
    expect.objectContaining({
      item_type: 'beneficiary',
      order_id: 'o-c',
      beneficiary_credit_id: 'bc-1',
      settle_seq: 1,
      b_settle_fen: null,
    }),
  ]);
  // processed = 逐单结果数 2，skipped = 暂缓数 1。
  expect(t.events).toContain('job:2,1');
});

it('[AC-B2-04rd-UNIT#3] 未上锁的单（初判暂缓）在第二次读里变成候选也不入批；只在第二次读里出现的新单本轮忽略', async () => {
  const first = [row('a-cand', waiting('o-a')), row('w-held', waiting('o-w', { hold: true }))];
  const second = [
    row('a-cand', waiting('o-a')),
    row('w-held', waiting('o-w')),
    row('n-new', waiting('o-n')),
  ];
  const t = setup({ reads: [first, second] });

  await t.command.launch(t.db, t.input);

  expect(t.events.filter((e) => e.startsWith('lock:'))).toEqual([
    `lock:${orderLockKeyText(PLATFORM, 'a-cand')}`,
  ]);
  expect(t.saved.map((v) => [v.orderKey, v.result])).toEqual([
    [key('a-cand'), 'candidate'],
    [key('w-held'), 'deferred'],
  ]);
  expect(t.items.map((i) => i.order_id)).toEqual(['o-a']);
});

it('[AC-B2-04rd-UNIT#4] 没有候选时不取任何订单键锁、不开分块保存点；平台排他锁照取恰一次（B2-04re）；取锁之后补做恰一次来源读（B2-04re r2）', async () => {
  const first = [
    row('c-credited', waiting('o-c', { rebateStatus: 'CREDITED' })),
    row('h-held', waiting('o-h', { hold: true })),
  ];
  const t = setup({ reads: [first] });

  const result = await t.command.launch(t.db, t.input);

  expect(t.readSource).toHaveBeenCalledTimes(2);
  expect(t.statements.filter((s) => LOCK.test(s.sql))).toEqual([]);
  expect(t.statements.filter((s) => SAVEPOINT.test(s.sql) || ROLLBACK_TO.test(s.sql))).toEqual([]);
  expect(t.statements.filter((s) => ADVISORY.test(s.sql)).map((s) => s.sql)).toEqual([
    GATE_EXCLUSIVE,
  ]);
  expect(t.trace.filter((e) => e === 'readSource' || e === 'gate')).toEqual([
    'readSource',
    'gate',
    'readSource',
  ]);
  expect(result.batchIds).toEqual([]);
  expect(t.saved.map((v) => v.result)).toEqual(['already_credited', 'deferred']);
});

it('[AC-B2-04rd-UNIT#5] 截点固定在发起那一刻：第一次来源读后 Clock 前进，第二次读的 selection 与第一次逐字段相同；截点后才取得的更大 seq 不进明细与逐单结果', async () => {
  const later = new Date(LAUNCH.getTime() + 30 * 60_000);
  const first = [row('a-01', waiting('o-a'))];
  const second = [
    row('a-01', waiting('o-a'), [
      { seq: 1, source: 'STATEMENT', createdAt: BEFORE, settledAt: BEFORE, commissionFen: 1000n },
      { seq: 2, source: 'API', createdAt: later, settledAt: BEFORE, commissionFen: 1000n },
    ]),
  ];
  const advanced = new Date(LAUNCH.getTime() + 60 * 60_000);
  const t = setup({
    reads: [first, second],
    afterFirstRead: (clock) => clock.set(advanced),
  });

  await t.command.launch(t.db, t.input);

  // Clock 确实在第一次来源读之后前进了（截点仍是发起时刻）。
  expect(t.clock.now()).toEqual(advanced);

  const [one, two] = selections(t.readSource);
  expect(two).toEqual(one);
  expect(one).toEqual({
    appId: APP,
    platform: PLATFORM,
    runAt: LAUNCH,
    billId: MONTH,
    generationStartedAt: LAUNCH,
  });
  expect(t.items).toEqual([expect.objectContaining({ order_id: 'o-a', settle_seq: 1 })]);
  expect(t.saved).toEqual([
    expect.objectContaining({ orderKey: key('a-01'), result: 'candidate', settleSeq: 1 }),
  ]);
});

it('[AC-B2-04rd-UNIT#6] 截点内的新结算记录：候选取第二次读到的整单最大 seq', async () => {
  const within = new Date(LAUNCH.getTime() - 60_000);
  const first = [row('a-01', waiting('o-a'))];
  const second = [
    row('a-01', waiting('o-a'), [
      { seq: 1, source: 'STATEMENT', createdAt: BEFORE, settledAt: BEFORE, commissionFen: 1000n },
      { seq: 2, source: 'API', createdAt: within, settledAt: BEFORE, commissionFen: 1000n },
    ]),
  ];
  const t = setup({ reads: [first, second] });

  await t.command.launch(t.db, t.input);

  expect(t.items).toEqual([
    expect.objectContaining({ order_id: 'o-a', settle_seq: 2, b_settle_fen: 850n }),
  ]);
  expect(t.saved).toEqual([expect.objectContaining({ settleSeq: 2 })]);
});

it('[AC-B2-04rd-UNIT#7] launchInTransaction 与 recheckCurrentBill 走同一段：第一次来源读 → 平台排他锁 → 订单键锁 → 第二次来源读', async () => {
  const first = [row('a-01', waiting('o-a'))];
  const lockA = `lock:${orderLockKeyText(PLATFORM, 'a-01')}`;

  const inside = setup({ reads: [first, first] });
  await inside.db
    .transaction()
    .execute((trx) => inside.command.launchInTransaction(trx, inside.input));
  expect(inside.events.slice(0, 4)).toEqual(['readSource', GATE, lockA, 'readSource']);

  const recheck = setup({ reads: [first, first] });
  await recheck.command.recheckCurrentBill(recheck.db, {
    appId: APP,
    platform: PLATFORM,
    requestedAt: LAUNCH,
  });
  expect(recheck.events.slice(0, 4)).toEqual(['readSource', GATE, lockA, 'readSource']);
});

function stubPorts(second: () => readonly BillSourceRow[]) {
  const log: string[] = [];
  let held = 0;
  let maxHeld = 0;
  return {
    log,
    maxHeld: () => maxHeld,
    ports: {
      savepoint: async () => {
        log.push('savepoint');
      },
      lock: async (k: string) => {
        log.push(`lock:${k}`);
        held += 1;
        maxHeld = Math.max(maxHeld, held);
      },
      reread: async () => {
        log.push('reread');
        return second();
      },
      rollbackToSavepoint: async () => {
        log.push('rollback');
        held = 0;
      },
    },
  };
}

it('[AC-B2-04rd-UNIT#8] lockAndReread：重复键只取一次锁；重读里同键取第一行', async () => {
  const a = row('a-01', waiting('o-a'));
  const again = row('a-01', waiting('o-a', { hold: true }));
  const s = stubPorts(() => [again, row('a-01', null)]);
  const out = await lockAndReread([a, a], () => true, s.ports);
  expect(s.log.filter((e) => e.startsWith('lock:'))).toEqual([`lock:${key('a-01')}`]);
  expect(out).toEqual([again, again]);
});

it('[AC-B2-04rd-UNIT#9] subOrderIdOf：从来源订单键拆回子订单号，平台不符或格式不对时抛错', () => {
  expect(subOrderIdOf(PLATFORM, key('synthetic-1'))).toBe('synthetic-1');
  expect(() => subOrderIdOf(PLATFORM, 'jd:1')).toThrow();
  expect(() => subOrderIdOf(PLATFORM, `${PLATFORM}:`)).toThrow();
  expect(() => subOrderIdOf(PLATFORM, `${PLATFORM}:a:b`)).toThrow();
});

it('[AC-B2-04rd-UNIT#10] 补充命令目录的非测试源码不自己读 orders / order_settlements（锁后重读只经注入的来源读口）', () => {
  const dir = new URL('./', import.meta.url);
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  expect(sources).toContain('command.ts');
  const tables = '(?:app\\.)?(?:orders|order_settlements)';
  const builder = new RegExp(
    `(?:selectFrom|innerJoin|leftJoin|rightJoin|fullJoin)\\(\\s*['"\`]${tables}(?:\\s+as\\s+\\w+)?['"\`]`,
  );
  const raw = new RegExp(
    `\\b(?:from|join)\\s+(?:"?app"?\\s*\\.\\s*)?"?(?:orders|order_settlements)"?(?!\\w)`,
    'i',
  );
  for (const file of sources) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    expect(builder.test(text), file).toBe(false);
    expect(raw.test(text), file).toBe(false);
  }
});

it('[AC-B2-04rd-UNIT#11] lockAndReread 分块：每块「保存点 → 块内升序取锁 → 重读 → 回滚到保存点」（不再查未执行批次），块间键也升序；末块的回滚先于返回；同时持有的锁不超过块大小', async () => {
  const subs = ['e', 'a', 'd', 'b', 'c'];
  const first = subs.map((x) => row(x, waiting(`o-${x}`)));
  const s = stubPorts(() => first);
  const out = await lockAndReread(first, () => true, s.ports, 2);
  s.log.push('returned');
  const block = (xs: string[]) => [
    'savepoint',
    ...xs.map((x) => `lock:${key(x)}`),
    'reread',
    'rollback',
  ];
  expect(s.log).toEqual([...block(['a', 'b']), ...block(['c', 'd']), ...block(['e']), 'returned']);
  expect(s.maxHeld()).toBe(2);
  // 逐单结果仍按第一次来源行的顺序。
  expect(out.map((r) => r.orderKey)).toEqual(subs.map(key));
});

it('[AC-B2-04rd-UNIT#12] lockAndReread：只有本块重读到的行算数；重读里已不在的丢弃', async () => {
  const first = ['a', 'b', 'c'].map((x) => row(x, waiting(`o-${x}`)));
  const credited = row('a', waiting('o-a', { rebateStatus: 'CREDITED' }));
  let reads = 0;
  const s = stubPorts(() => {
    reads += 1;
    // 第一块（a、b）读到 a 已入账、b 消失；第二块（c）读到的 a 是别的样子，不得覆盖第一块的结论。
    return reads === 1
      ? [credited, first[2]!]
      : [row('a', waiting('o-a', { hold: true })), first[2]!];
  });
  const out = await lockAndReread(first, () => true, s.ports, 2);
  expect(s.log.filter((e) => e === 'reread')).toHaveLength(2);
  expect(out).toEqual([credited, first[2]]);
});

it('[AC-B2-04rd-UNIT#13] 补充命令：候选数超过一块（LOCK_CHUNK + 1，不注入块大小）时分两块，各块语句序列成形、块内与块间键升序、保存点内没有写语句、未释放的锁不超过 LOCK_CHUNK；全部候选照常入批', async () => {
  const n = LOCK_CHUNK + 1;
  const subs = Array.from({ length: n }, (_, i) => `k-${String(n - 1 - i).padStart(4, '0')}`);
  const first = subs.map((x) => row(x, waiting(`o-${x}`)));
  const t = setup({ reads: [first] });

  await t.command.launch(t.db, t.input);

  const sorted = [...subs].sort();
  const lockOf = (x: string) => `lock:${orderLockKeyText(PLATFORM, x)}`;
  const block = (xs: string[]) => [
    'savepoint',
    ...xs.map(lockOf),
    'readSource',
    'rollback',
    'release',
  ];
  const start = t.trace.indexOf('savepoint');
  expect(t.trace.slice(start, start + n + 8)).toEqual([
    ...block(sorted.slice(0, LOCK_CHUNK)),
    ...block(sorted.slice(LOCK_CHUNK)),
  ]);
  expect(t.trace.slice(0, start).filter((e) => e === 'readSource' || e === 'gate')).toEqual([
    'readSource',
    'gate',
  ]);
  // 平台锁与第一个分块保存点之间只有释放开关复核保存点（B2-04re r2）。
  expect(t.trace.slice(start - 2, start)).toEqual(['gate', 'gate-release']);
  expect(t.trace.filter((e) => e === 'savepoint')).toHaveLength(2);

  let held = 0;
  let maxHeld = 0;
  let inside = false;
  for (const e of t.trace) {
    if (e === 'savepoint') inside = true;
    if (e === 'rollback') {
      inside = false;
      held = 0;
    }
    if (e.startsWith('lock:')) {
      held += 1;
      maxHeld = Math.max(maxHeld, held);
    }
    if (inside) expect(e).not.toBe('write');
  }
  expect(maxHeld).toBe(LOCK_CHUNK);
  expect(t.items.filter((i) => i.item_type === 'order')).toHaveLength(n);
});

it('[AC-B2-04rd-UNIT#14] 去掉锁内查未执行批次（B2-04re）：「查未执行批次」只在拆批前查一次（全部块之后）；那次查到的单不入批，逐单结果照常记录', async () => {
  const first = [row('a-01', waiting('o-a')), row('b-02', waiting('o-b'))];
  const t = setup({
    reads: [first, first],
    pendingRows: (call) =>
      call === 0
        ? [{ order_id: 'o-a', result: null, status: 'CONFIRMED', paused_by_switch_at: null }]
        : [],
  });

  await t.command.launch(t.db, t.input);

  expect(t.trace.filter((e) => e === 'pending')).toHaveLength(1);
  expect(t.trace.indexOf('pending')).toBeGreaterThan(t.trace.lastIndexOf('release'));
  expect(t.items.map((i) => i.order_id)).toEqual(['o-b']);
  expect(t.saved.map((v) => [v.orderKey, v.result])).toEqual([
    [key('a-01'), 'candidate'],
    [key('b-02'), 'candidate'],
  ]);
});

/** 最后一条匹配 pattern 的语句的下标（没有时 -1）。 */
function lastStatement(statements: readonly CompiledQuery[], pattern: RegExp): number {
  for (let at = statements.length - 1; at >= 0; at -= 1) {
    if (pattern.test(statements[at]!.sql)) return at;
  }
  return -1;
}

/** 第一次来源读起的时间线里，与锁和读有关的那几项（去掉 other / write / pending / claim 与复核保存点 gate-*）。 */
function lockTimeline(trace: readonly string[]): string[] {
  return trace.filter(
    (e) =>
      e !== 'other' && e !== 'write' && e !== 'pending' && e !== 'claim' && !e.startsWith('gate-'),
  );
}

it('[AC-B2-04re-UNIT#1] 三张候选、注入块大小 2（两块）：第一次来源读 → 平台排他锁 → 「保存点 → 块内升序取锁 → 重读 → 回滚到保存点 → 释放保存点」× 2；末块回滚在第一条写批次 / 明细之前；平台锁恰一条', async () => {
  const first = [
    row('c-3', waiting('o-c')),
    row('a-1', waiting('o-a')),
    row('b-2', waiting('o-b')),
  ];
  const t = setup({ reads: [first], lockChunkSize: 2 });

  const result = await t.command.launch(t.db, t.input);

  const lockOf = (x: string) => `lock:${orderLockKeyText(PLATFORM, x)}`;
  const block = (xs: string[]) => [
    'savepoint',
    ...xs.map(lockOf),
    'readSource',
    'rollback',
    'release',
  ];
  expect(lockTimeline(t.trace)).toEqual([
    'readSource',
    'gate',
    ...block(['a-1', 'b-2']),
    ...block(['c-3']),
  ]);
  // 末块的回滚 / 释放之后才有批次与明细的写入（同在语句序列里比位置）。
  const lastRelease = lastStatement(t.statements, RELEASE);
  expect(lastRelease).toBeGreaterThan(0);
  const insertBatch = t.statements.findIndex((q) =>
    /^insert into "app"\."settle_batches"/.test(q.sql),
  );
  expect(insertBatch).toBeGreaterThan(lastRelease);
  expect(t.statements.filter((q) => q.sql === GATE_EXCLUSIVE)).toHaveLength(1);
  expect(t.statements.filter((q) => ADVISORY.test(q.sql) && !LOCK.test(q.sql))).toHaveLength(1);
  expect(result.batchIds).toHaveLength(1);
  expect(t.items.map((i) => i.order_id)).toEqual(['o-a', 'o-b', 'o-c']);
});

it('[AC-B2-04re-UNIT#2] 一张候选（单块，注入块大小 2）：第一次来源读 → 平台排他锁 → 保存点 → 取锁 → 重读 → 回滚 → 释放；回滚在写批次之前', async () => {
  const first = [row('a-1', waiting('o-a'))];
  const t = setup({ reads: [first], lockChunkSize: 2 });

  await t.command.launch(t.db, t.input);

  expect(lockTimeline(t.trace)).toEqual([
    'readSource',
    'gate',
    'savepoint',
    `lock:${orderLockKeyText(PLATFORM, 'a-1')}`,
    'readSource',
    'rollback',
    'release',
  ]);
  const insertBatch = t.statements.findIndex((q) =>
    /^insert into "app"\."settle_batches"/.test(q.sql),
  );
  expect(lastStatement(t.statements, RELEASE)).toBeGreaterThan(0);
  expect(insertBatch).toBeGreaterThan(lastStatement(t.statements, RELEASE));
  expect(t.items.map((i) => i.order_id)).toEqual(['o-a']);
});

it('[AC-B2-04re-UNIT#3] 平台排他锁的语句与参数：逐字是 credit-gate.ts 的事务级排他语句，参数 (settlement.credit_gate, app:platform)；补充里不出现会话级取锁、解锁或试锁', async () => {
  const first = [row('a-1', waiting('o-a')), row('b-2', waiting('o-b'))];
  const t = setup({ reads: [first] });

  await t.command.launch(t.db, t.input);

  const gates = t.statements.filter((q) => q.sql === GATE_EXCLUSIVE);
  expect(gates.map((q) => q.parameters)).toEqual([
    ['settlement.credit_gate', `${APP}:${PLATFORM}`],
  ]);
  for (const q of t.statements) {
    expect(q.sql).not.toMatch(/pg_advisory_lock|pg_advisory_unlock|pg_try_advisory|_shared/);
  }
});

it('[AC-B2-04re-UNIT#4] 注入的块大小不是正整数时照现有校验抛错，不写批次', async () => {
  for (const size of [0, -1, 1.5]) {
    const first = [row('a-1', waiting('o-a'))];
    const t = setup({ reads: [first], lockChunkSize: size });
    await expect(t.command.launch(t.db, t.input)).rejects.toThrow(RangeError);
    expect(t.statements.some((q) => /^insert into "app"\."settle_batches"/.test(q.sql))).toBe(
      false,
    );
  }
});

// ---- B2-04re r2 -------------------------------------------------------------------------------

/** trace 里第一次出现 label 的下标（没有时 -1）。 */
function at(trace: readonly string[], label: string): number {
  return trace.indexOf(label);
}

it('[AC-B2-04re-UNIT#12] 取到平台排他锁后开关读到 off（launch）：抛 credit_disabled；回滚到复核保存点（撤销认领任务）先于抛错，其后没有任何语句——没有分块保存点、订单键锁、逐单结果与批次 / 明细写入', async () => {
  const first = [row('a-1', waiting('o-a')), row('b-2', waiting('o-b'))];
  const t = setup({ reads: [first, first], switches: ['on', 'off'] });

  await expect(t.command.launch(t.db, t.input)).rejects.toMatchObject({
    name: 'SupplementRejected',
    reason: 'credit_disabled',
  });

  // 账单行锁之后开复核保存点 → 认领任务 → 第一次来源读 → 平台锁 → 回滚到复核保存点 → 释放；到此为止。
  const sp = at(t.trace, 'gate-savepoint');
  const claim = at(t.trace, 'claim');
  const gate = at(t.trace, 'gate');
  const rollback = at(t.trace, 'gate-rollback');
  expect(sp).toBeGreaterThan(0);
  expect(sp < claim && claim < gate && gate < rollback).toBe(true);
  expect(t.trace.slice(rollback)).toEqual(['gate-rollback', 'gate-release']);
  expect(t.readSource).toHaveBeenCalledTimes(1);
  expect(t.statements.filter((q) => LOCK.test(q.sql))).toEqual([]);
  expect(t.statements.filter((q) => SAVEPOINT.test(q.sql))).toEqual([]);
  expect(t.events.filter((e) => e.startsWith('insert:') || e.startsWith('job:'))).toEqual([]);
  expect(t.saved).toEqual([]);
});

it('[AC-B2-04re-UNIT#13] 开关复核 off 经 launchInTransaction（调用方接住拒绝、继续写并提交外层事务）与 recheckCurrentBill：认领任务的写入都在复核保存点之内、已被回滚到保存点撤销，调用方之后的写入不在保存点内；三个入口序列相同', async () => {
  const first = [row('a-1', waiting('o-a'))];
  const expected = [
    'gate-savepoint',
    'claim',
    'readSource',
    'gate',
    'gate-rollback',
    'gate-release',
  ];
  const slice = (trace: readonly string[]) =>
    trace.filter((e) => expected.includes(e) || e === 'savepoint' || e.startsWith('lock:'));

  const inside = setup({ reads: [first, first], switches: ['on', 'off'] });
  await inside.db.transaction().execute(async (trx) => {
    await expect(inside.command.launchInTransaction(trx, inside.input)).rejects.toMatchObject({
      reason: 'credit_disabled',
    });
    // 调用方（admin-settle-commands）接住 SupplementRejectedError 后继续在外层事务里写并提交。
    await sql`insert into caller_audit (note) values ('caller')`.execute(trx);
  });
  expect(slice(inside.trace)).toEqual(expected);
  const claim = at(inside.trace, 'claim');
  const rollback = at(inside.trace, 'gate-rollback');
  const callerWrite = inside.trace.lastIndexOf('write');
  // 认领任务在复核保存点与回滚之间（随回滚撤销）；调用方的写入在保存点释放之后。
  expect(at(inside.trace, 'gate-savepoint') < claim && claim < rollback).toBe(true);
  expect(callerWrite).toBeGreaterThan(at(inside.trace, 'gate-release'));
  expect(inside.trace.slice(rollback + 2)).toEqual(['write']);
  expect(inside.events.filter((e) => e.startsWith('insert:') || e.startsWith('job:'))).toEqual([]);

  const recheck = setup({ reads: [first, first], switches: ['on', 'off'] });
  await expect(
    recheck.command.recheckCurrentBill(recheck.db, {
      appId: APP,
      platform: PLATFORM,
      requestedAt: LAUNCH,
    }),
  ).rejects.toMatchObject({ reason: 'credit_disabled' });
  expect(slice(recheck.trace)).toEqual(expected);
});

it('[AC-B2-04re-UNIT#14] 开关一开始就 off：行为同主干——抛 credit_disabled，不锁账单行、不开保存点、不认领、不读来源、不取平台锁（没有任何语句）', async () => {
  const t = setup({ reads: [[row('a-1', waiting('o-a'))]], switches: ['off'] });

  await expect(t.command.launch(t.db, t.input)).rejects.toMatchObject({
    reason: 'credit_disabled',
  });

  expect(t.statements).toEqual([]);
  expect(t.readSource).not.toHaveBeenCalled();
});

it('[AC-B2-04re-UNIT#15] 开关复核仍 on：释放复核保存点后照常分块与写入；认领判为重放：释放复核保存点后直接返回 duplicate，不读来源、不取平台锁', async () => {
  const first = [row('a-1', waiting('o-a'))];
  const on = setup({ reads: [first, first] });
  const result = await on.command.launch(on.db, on.input);
  expect(result.outcome).toBe('generated');
  const release = at(on.trace, 'gate-release');
  expect(at(on.trace, 'gate') < release && release < at(on.trace, 'savepoint')).toBe(true);
  expect(on.trace.filter((e) => e === 'gate-rollback')).toEqual([]);
  expect(on.items.map((i) => i.order_id)).toEqual(['o-a']);

  const dup = setup({ reads: [first], duplicate: true });
  const replay = await dup.command.launch(dup.db, dup.input);
  expect(replay).toEqual({ outcome: 'duplicate', billId: MONTH, platform: PLATFORM, batchIds: [] });
  expect(dup.readSource).not.toHaveBeenCalled();
  expect(dup.statements.filter((q) => ADVISORY.test(q.sql))).toEqual([]);
  const sp = at(dup.trace, 'gate-savepoint');
  const claim = at(dup.trace, 'claim');
  expect(sp < claim && claim < at(dup.trace, 'gate-release')).toBe(true);
  expect(dup.trace.filter((e) => e === 'gate-rollback')).toEqual([]);
});

it('[AC-B2-04re-UNIT#16] lockAndReread 有候选（两块）：未上锁的行取最后一次块内重读里的非候选行；重读里变成候选的、重读里缺失的沿用第一次读；重读里新出现的不理会；来源读次数 = 块数', async () => {
  const cand = (r: BillSourceRow) => r.order !== null && r.order.hold === false;
  const a = row('a', waiting('o-a'));
  const c = row('c', waiting('o-c'));
  const credited = row('o', waiting('o-o', { hold: true }));
  const unheld = row('u', waiting('o-u', { hold: true }));
  const gone = row('g', waiting('o-g', { hold: true }));
  const first = [a, credited, unheld, gone, c];
  const oLater = row('o', waiting('o-o', { hold: true, rebateStatus: 'CREDITED' }));
  const oLast = row(
    'o',
    waiting('o-o', { hold: true, rebateStatus: 'CREDITED', rightsPending: true }),
  );
  let reads = 0;
  const s = stubPorts(() => {
    reads += 1;
    // 第一块（a）的重读：o 还是别的样子；最后一块（c）的重读才算未上锁行的状态。
    return reads === 1
      ? [a, oLater, unheld, gone, c]
      : [a, oLast, row('u', waiting('o-u')), c, row('n', waiting('o-n'))];
  });

  const out = await lockAndReread(first, cand, s.ports, 1);

  expect(s.log.filter((e) => e === 'reread')).toHaveLength(2);
  expect(s.log.filter((e) => e.startsWith('lock:'))).toEqual([
    `lock:${key('a')}`,
    `lock:${key('c')}`,
  ]);
  // o 取最后一次重读的行；u 重读里变成候选 → 沿用第一次；g 重读里缺失 → 沿用第一次；n 不理会。
  expect(out).toEqual([a, oLast, unheld, gone, c]);
});

it('[AC-B2-04re-UNIT#17] lockAndReread 没有候选：不开保存点、不取锁，恰一次重读，按同一规则替换', async () => {
  const cand = (r: BillSourceRow) => r.order !== null && r.order.hold === false;
  const o = row('o', waiting('o-o', { hold: true }));
  const u = row('u', waiting('o-u', { hold: true }));
  const g = row('g', waiting('o-g', { hold: true }));
  const oAfter = row('o', waiting('o-o', { hold: true, rebateStatus: 'CREDITED' }));
  const s = stubPorts(() => [oAfter, row('u', waiting('o-u')), row('n', waiting('o-n'))]);

  const out = await lockAndReread([o, u, g], cand, s.ports);

  expect(s.log).toEqual(['reread']);
  expect(out).toEqual([oAfter, u, g]);
});

it('[AC-B2-04re-UNIT#18] 补充（有候选）：第一次读时暂缓的 O 在等平台锁期间被旧批次入账、为冻结受益人开了补记义务——本轮按锁后重读出逐单结果「已入账」与补记项，不出首次入账明细；来源读 1 + 块数', async () => {
  const first = [row('a-1', waiting('o-a')), row('o-9', waiting('o-o', { hold: true }))];
  const second = [
    row('a-1', waiting('o-a')),
    row('o-9', waiting('o-o', { rebateStatus: 'CREDITED' })),
  ];
  const t = setup({
    reads: [first, second],
    obligations: [{ order_id: 'o-o', user_id: 'u-frozen', role: 'direct', id: 'bc-9' }],
  });

  await t.command.launch(t.db, t.input);

  expect(t.readSource).toHaveBeenCalledTimes(2);
  expect(t.events.filter((e) => e.startsWith('lock:'))).toEqual([
    `lock:${orderLockKeyText(PLATFORM, 'a-1')}`,
  ]);
  expect(t.saved.map((v) => [v.orderKey, v.result])).toEqual([
    [key('a-1'), 'candidate'],
    [key('o-9'), 'already_credited'],
  ]);
  expect(t.items).toEqual([
    expect.objectContaining({ item_type: 'order', order_id: 'o-a' }),
    expect.objectContaining({
      item_type: 'beneficiary',
      order_id: 'o-o',
      beneficiary_credit_id: 'bc-9',
    }),
  ]);
});

it('[AC-B2-04re-UNIT#19] 补充（没有候选）：平台锁之后恰一次来源读，没有分块保存点与订单键锁；O 按锁后重读出补记项；重读里暂缓解除的 W 仍记暂缓、不入批', async () => {
  const first = [
    row('o-9', waiting('o-o', { hold: true })),
    row('w-1', waiting('o-w', { hold: true })),
  ];
  const second = [
    row('o-9', waiting('o-o', { rebateStatus: 'CREDITED' })),
    row('w-1', waiting('o-w')),
  ];
  const t = setup({
    reads: [first, second],
    obligations: [{ order_id: 'o-o', user_id: 'u-frozen', role: 'direct', id: 'bc-9' }],
  });

  const result = await t.command.launch(t.db, t.input);

  expect(lockTimeline(t.trace)).toEqual(['readSource', 'gate', 'readSource']);
  expect(t.statements.filter((q) => LOCK.test(q.sql))).toEqual([]);
  expect(t.statements.filter((q) => SAVEPOINT.test(q.sql) || ROLLBACK_TO.test(q.sql))).toEqual([]);
  expect(t.saved.map((v) => [v.orderKey, v.result])).toEqual([
    [key('o-9'), 'already_credited'],
    [key('w-1'), 'deferred'],
  ]);
  expect(result.batchIds).toHaveLength(1);
  expect(t.items).toEqual([
    expect.objectContaining({
      item_type: 'beneficiary',
      order_id: 'o-o',
      beneficiary_credit_id: 'bc-9',
    }),
  ]);
});
