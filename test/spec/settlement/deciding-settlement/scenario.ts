// B2-04zp 规则测试的公共场景（FU-SETTLE-STATEMENT-IMPORT 的 S0）。worker 装配、流水线和账单都用
// ../settlement-records/kit.ts；API 记录走流水线，STATEMENT 行是夹具（写者是后续任务）。
// 生产的补差命令只在 admin 入口装配，worker 入口没有：supplement() 按 createAdminSettleCommandDeps 的
// 接线，用同样的生产端口（账单来源读口、不落库的校验结果、commission 读口、ledger 登记差错）在这里造一份。
// 手算：reserve 0，B = N，本人 50 %（kit.ts）；账单拿 b_settle 与快照基数比，基数取付款时的预估，结算额不动它。
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import {
  createBillSourceReader,
  saveBillValidations,
} from '../../../../apps/api/src/modules/settlement/bill/index.ts';
import type { BillJobDependencies } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import { createSupplementCommand } from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import { decidingSettlement } from '../../../../apps/api/src/modules/settlement/settlements/index.ts';
import { at } from '../../orders/wiring/db-kit.ts';
import { brief, settled, touched, type App, type Worker } from '../settlement-records/kit.ts';

// URL 导入同 ../rights-estimate/kit.ts：规则测试项目的 tsc 不进 Nest 装饰器图。
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readCommissionSnapshot: BillJobDependencies['readSnapshot'];
  readTljDeductFen: BillJobDependencies['readTljDeductFen'];
};

const ledger = (await import(
  new URL('../../../../apps/api/src/modules/ledger/index.ts', import.meta.url).href
)) as {
  registerReconDiff: BillJobDependencies['registerDiff'];
  readUnionAuthoritativeOrderKeys: Parameters<
    typeof createBillSourceReader
  >[0]['readUnionAuthoritative'];
};

export type Order = ReturnType<Worker['order']>;

/** kit.ts 的 BILL_DAY 对应的账单月。 */
export const BILL_MONTH = '2026-10';
/** 账单日次日 10:00 +08:00：不在账单日当天（补差任务键不顺延），前一日资产快照已过时限。 */
export const LAUNCH = '2026-11-25T02:00:00.000Z';
/** 快照基数 900：与 STATEMENT 金额相符，与 API 金额都不符。 */
export const ESTIMATE_900 = { commission_fen: 900n, est_commission_fen: 900n };

/**
 * STATEMENT 夹在两条 API 之间：seq 1 API 950、seq 2 STATEMENT 900、seq 3 API 1000，金额两两不同。
 * orders.settle_commission_fen（R5 读的列）是 STATEMENT 的 900。
 */
export async function statementBetweenApi(o: Order): Promise<void> {
  await o.sync(settled(950n));
  await o.statement(2, 900n);
  await o.sync(settled(1000n, touched(1)));
  expect(brief(await o.records())).toEqual([
    [1, 'API', 950n],
    [2, 'STATEMENT', 900n],
    [3, 'API', 1000n],
  ]);
  expect(await o.row()).toMatchObject({ settle_commission_fen: 900n });
}

/** 这单的记录在 cutoff 处决定金额的那一条：[seq, source, 金额]，没有为 null。 */
export async function decidedAt(o: Order, cutoff: string) {
  const rows = (await o.records()).map((row) => ({
    seq: row.seq,
    source: row.source as 'API' | 'STATEMENT',
    createdAt: row.created_at,
    commissionFen: row.settle_commission_fen,
  }));
  const decided = decidingSettlement(rows, at(cutoff).getTime());
  return decided === null ? null : [decided.seq, decided.source, decided.commissionFen];
}

export function reconDiffs(db: Kysely<DB>, app: App) {
  return db
    .selectFrom('recon_diffs')
    .select(['type', 'period', 'ref_id', 'expected_fen', 'actual_fen'])
    .where('app_id', '=', app.appId)
    .execute();
}

/** 补差命令，端口同生产（见文件头）。 */
export function supplement(db: Kysely<DB>, w: Worker) {
  const clock = w.clock;
  return createSupplementCommand({
    clock,
    config: {
      get: async (appId, key) =>
        (await createContentReader({ db, clock }).configValue(appId, key))?.value,
    },
    readSource: createBillSourceReader({
      readUnionAuthoritative: ledger.readUnionAuthoritativeOrderKeys,
    }),
    readSnapshot: commission.readCommissionSnapshot,
    readTljDeductFen: commission.readTljDeductFen,
    registerDiff: ledger.registerReconDiff,
    saveValidations: saveBillValidations,
  });
}

/** 把时钟拨到 LAUNCH，对账单月发起一轮补差。 */
export function launch(db: Kysely<DB>, w: Worker, app: App) {
  w.clock.set(LAUNCH);
  return supplement(db, w).launch(db, {
    appId: app.appId,
    billId: BILL_MONTH,
    platform: 'pdd',
    requestedAt: at(LAUNCH),
  });
}
