// B2-04zd（D10-443）：账单任务生产 readSource（BR-FUND-04 ③ ④、BR-FUND-09 R1）。
// 只读；范围、截点与最大 seq 由账单任务校验，读口不预先过滤；「以联盟为准」只取 ledger 差错结论读口。
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  createBillSourceReader,
  type BillJobDependencies,
  type BillSourceDependencies,
  type BillSourceRow,
  type BillSourceSelection,
} from '../../../../apps/api/src/modules/settlement/bill/index.ts';
import {
  AFTER,
  BEFORE,
  EARLY,
  MONTH,
  TIMEOUT,
  databaseFixture,
  newApp,
  readOnly,
  seedDiff,
  seedKey,
  seedOrder,
  seedSettlement,
  selection,
  tableCounts,
} from './kit.ts';

// 经 ledger 公开出口运行时加载，与既有结算规则测试一致（不把 Nest 模块图引入测试 tsc）。
const ledger = (await import(
  new URL('../../../../apps/api/src/modules/ledger/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/ledger/application/recon-diff-conclusion.ts');

const database = databaseFixture(createTestDatabase);

type Reader = BillSourceDependencies['readUnionAuthoritative'];

function noConclusions() {
  return vi.fn<Reader>(async () => new Set<string>());
}

function sortRows(rows: readonly BillSourceRow[]): BillSourceRow[] {
  return [...rows]
    .map((r) => ({ ...r, settlements: [...r.settlements].sort((a, b) => a.seq - b.seq) }))
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
}

/** 生产端口装配形状：结果直接作为 BillJobDependencies['readSource']；在只读事务里调用。 */
async function read(
  deps: BillSourceDependencies,
  sel: BillSourceSelection,
  onTrx: (trx: Transaction<DB>) => void = () => undefined,
): Promise<BillSourceRow[]> {
  const readSource: BillJobDependencies['readSource'] = createBillSourceReader(deps);
  const rows = await readOnly(database.db, async (trx) => {
    onTrx(trx);
    return readSource(trx, sel);
  });
  return sortRows(rows);
}

it(
  '[AC-B2-04zd#1] 逐单返回 orders 事实与该单全部结算行，字段原样（含 commission_version 与 seq）',
  async () => {
    const db = database.db;
    const appId = newApp();
    const o = await seedOrder(db, appId, { commissionVersion: 3 });
    await seedSettlement(db, o, {
      seq: 1,
      source: 'API',
      fen: 1000n,
      createdAt: EARLY,
      settledAt: EARLY,
    });
    await seedSettlement(db, o, {
      seq: 2,
      source: 'STATEMENT',
      fen: 1200n,
      createdAt: BEFORE,
      settledAt: '2032-06-30T12:00:00+08:00',
    });

    const rows = await read({ readUnionAuthoritative: noConclusions() }, selection(appId));

    expect(rows).toEqual([
      {
        orderKey: o.key,
        order: {
          orderId: o.orderId,
          rebateStatus: 'WAITING',
          settlePeriod: MONTH,
          hold: false,
          rightsPending: false,
          commissionVersion: 3,
          unionAuthoritative: false,
        },
        settlements: [
          {
            seq: 1,
            source: 'API',
            createdAt: new Date(EARLY),
            settledAt: new Date(EARLY),
            commissionFen: 1000n,
          },
          {
            seq: 2,
            source: 'STATEMENT',
            createdAt: new Date(BEFORE),
            settledAt: new Date('2032-06-30T12:00:00+08:00'),
            commissionFen: 1200n,
          },
        ],
      },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#2] 只返回所选 app 与平台的订单和结算行，别的 app、别的平台不混入',
  async () => {
    const db = database.db;
    const appId = newApp();
    const other = newApp();
    const mine = await seedOrder(db, appId);
    await seedSettlement(db, mine);
    const jd = await seedOrder(db, appId, {}, 'jd');
    await seedSettlement(db, jd);
    const jdOrphan = await seedKey(db, appId, 'jd');
    await seedSettlement(db, jdOrphan);
    const foreign = await seedOrder(db, other);
    await seedSettlement(db, foreign);
    const foreignOrphan = await seedKey(db, other);
    await seedSettlement(db, foreignOrphan);
    const deps = { readUnionAuthoritative: noConclusions() };

    const taobao = await read(deps, selection(appId, 'taobao'));
    const jdRows = await read(deps, selection(appId, 'jd'));

    expect(taobao.map((r) => r.orderKey)).toEqual([mine.key]);
    expect(jdRows.map((r) => r.orderKey)).toEqual([jd.key, jdOrphan.key].sort());
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#3] 读口不替账单任务过滤：各返利状态、hold、维权中、无结算行、晚于生成开始的结算行都原样返回',
  async () => {
    const db = database.db;
    const appId = newApp();
    const earlier = await seedOrder(db, appId, { settlePeriod: '2032-05' });
    await seedSettlement(db, earlier);
    const unsettled = await seedOrder(db, appId);
    const late = await seedOrder(db, appId);
    await seedSettlement(db, late, { seq: 1, createdAt: BEFORE });
    await seedSettlement(db, late, { seq: 2, createdAt: AFTER, fen: 1300n });
    const onlyLate = await seedOrder(db, appId);
    await seedSettlement(db, onlyLate, { seq: 1, createdAt: AFTER });
    const held = await seedOrder(db, appId, { hold: true });
    await seedSettlement(db, held);
    const rights = await seedOrder(db, appId, { rightsPending: true });
    await seedSettlement(db, rights);
    const estimated = await seedOrder(db, appId, {
      rebateStatus: 'ESTIMATED',
      settlePeriod: null,
    });
    await seedSettlement(db, estimated);
    const voided = await seedOrder(db, appId, { rebateStatus: 'VOID' });
    await seedSettlement(db, voided);
    const clawed = await seedOrder(db, appId, { rebateStatus: 'CLAWED_BACK' });
    await seedSettlement(db, clawed);
    const credited = await seedOrder(db, appId, {
      rebateStatus: 'CREDITED',
      settlePeriod: '2032-05',
    });
    await seedSettlement(db, credited);

    const rows = await read({ readUnionAuthoritative: noConclusions() }, selection(appId));
    const summary = rows.map((r) => [
      r.orderKey,
      r.order?.rebateStatus,
      r.order?.settlePeriod,
      r.order?.hold,
      r.order?.rightsPending,
      r.settlements.map((s) => s.seq),
    ]);

    const expected: [string, string, string | null, boolean, boolean, number[]][] = [
      [earlier.key, 'WAITING', '2032-05', false, false, [1]],
      [unsettled.key, 'WAITING', MONTH, false, false, []],
      [late.key, 'WAITING', MONTH, false, false, [1, 2]],
      [onlyLate.key, 'WAITING', MONTH, false, false, [1]],
      [held.key, 'WAITING', MONTH, true, false, [1]],
      [rights.key, 'WAITING', MONTH, false, true, [1]],
      [estimated.key, 'ESTIMATED', null, false, false, [1]],
      [voided.key, 'VOID', MONTH, false, false, [1]],
      [clawed.key, 'CLAWED_BACK', MONTH, false, false, [1]],
      [credited.key, 'CREDITED', '2032-05', false, false, [1]],
    ];
    expect(summary).toEqual(expected.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#4] 有结算无订单的孤儿行以 order=null 返回，orderKey 取 order_keys 的平台与子订单号',
  async () => {
    const db = database.db;
    const appId = newApp();
    const known = await seedOrder(db, appId);
    await seedSettlement(db, known);
    const orphan = await seedKey(db, appId);
    await seedSettlement(db, orphan, { seq: 1, source: 'STATEMENT', fen: 700n });
    await seedSettlement(db, orphan, { seq: 2, source: 'STATEMENT', fen: 900n, createdAt: AFTER });

    const rows = await read({ readUnionAuthoritative: noConclusions() }, selection(appId));

    expect(orphan.key).toBe(`taobao:${orphan.subOrderId}`);
    expect(rows.find((r) => r.orderKey === orphan.key)).toEqual({
      orderKey: orphan.key,
      order: null,
      settlements: [
        {
          seq: 1,
          source: 'STATEMENT',
          createdAt: new Date(BEFORE),
          settledAt: new Date(BEFORE),
          commissionFen: 700n,
        },
        {
          seq: 2,
          source: 'STATEMENT',
          createdAt: new Date(AFTER),
          settledAt: new Date(BEFORE),
          commissionFen: 900n,
        },
      ],
    });
    expect(rows.map((r) => r.orderKey)).toEqual([known.key, orphan.key].sort());
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#5] UNATTRIBUTED 订单不以该状态返回（不在账单六种结果内）',
  async () => {
    const db = database.db;
    const appId = newApp();
    const waiting = await seedOrder(db, appId);
    await seedSettlement(db, waiting);
    const unattributed = await seedKey(db, appId);
    await db
      .withSchema('app')
      .insertInto('orders')
      .values({
        app_id: appId,
        order_id: unattributed.orderId,
        platform: 'taobao',
        sub_order_id: unattributed.subOrderId,
        raw_item_id: 'synthetic-item',
        platform_status: 'PAID',
        rebate_status: 'UNATTRIBUTED',
        attr_at: new Date(EARLY),
        created_at: new Date(EARLY),
        updated_at: new Date(EARLY),
      })
      .execute();
    await seedSettlement(db, unattributed);

    const rows = await read({ readUnionAuthoritative: noConclusions() }, selection(appId));

    expect(rows.map((r) => r.orderKey)).toContain(waiting.key);
    expect(rows.map((r) => r.order?.rebateStatus)).not.toContain('UNATTRIBUTED');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#6] 来源读口不再调用差错结论读口（B2-18）：unionAuthoritative 恒为 false，closed 差错单也不冒充以联盟为准',
  async () => {
    const db = database.db;
    const appId = newApp();
    const concluded = await seedOrder(db, appId);
    await seedSettlement(db, concluded, { fen: 2000n });
    const closedOnly = await seedOrder(db, appId);
    await seedSettlement(db, closedOnly, { fen: 2000n });
    await seedDiff(db, appId, closedOnly.key, {
      status: 'closed',
      resolution: { reason: '以联盟为准' },
    });
    // B2-18（D10-2415 ③）：读口若被调用会把 concluded 标为以联盟为准；有结论也不读。
    const reader = vi.fn<Reader>(async (_db, sel) => {
      return new Set(sel.orderKeys.filter((k) => k === concluded.key));
    });

    const rows = await read({ readUnionAuthoritative: reader }, selection(appId));

    const flag = (key: string) => rows.find((r) => r.orderKey === key)?.order?.unionAuthoritative;
    expect(flag(concluded.key)).toBe(false);
    expect(flag(closedOnly.key)).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#7] 装配 ledger 结论读口时，仅 closed / adjusted 而无可识别结论的差错单均为 false',
  async () => {
    const db = database.db;
    const appId = newApp();
    const closed = await seedOrder(db, appId);
    await seedSettlement(db, closed, { fen: 2000n });
    await seedDiff(db, appId, closed.key, {
      status: 'closed',
      resolution: { reason: '以联盟为准' },
    });
    const adjusted = await seedOrder(db, appId);
    await seedSettlement(db, adjusted, { fen: 2000n });
    await seedDiff(db, appId, adjusted.key, { status: 'adjusted', resolution: null });

    const rows = await read(
      { readUnionAuthoritative: ledger.readUnionAuthoritativeOrderKeys },
      selection(appId),
    );

    const expected = [closed.key, adjusted.key].sort().map((key) => [key, false]);
    expect(rows.map((r) => [r.orderKey, r.order?.unionAuthoritative])).toEqual(expected);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#8] 只读：在只读事务里完成，调用前后各表行数不变',
  async () => {
    const db = database.db;
    const appId = newApp();
    const o = await seedOrder(db, appId);
    await seedSettlement(db, o);
    const orphan = await seedKey(db, appId);
    await seedSettlement(db, orphan);
    const before = await tableCounts(db, appId);

    const rows = await read({ readUnionAuthoritative: noConclusions() }, selection(appId));

    expect(rows).toHaveLength(2);
    expect(await tableCounts(db, appId)).toEqual(before);
  },
  TIMEOUT,
);
