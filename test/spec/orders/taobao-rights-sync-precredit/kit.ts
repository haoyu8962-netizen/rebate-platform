// B1-04zzaa 规则测试夹具（FU-B104ZZA-PRECREDIT-REOPEN，claude-independent）：入账前（ESTIMATED / WAITING）的
// 「API 源维权已 FAILED、联盟后来又报扣款成功」走真实链路、断言查库。
// 链路：淘宝维权窗口处理器（handleRightsWindow；refund_status 由联盟适配器归一成 rights_status，4 = PROCESSING，
// 14 / 15 = CLOSED_NO_CHARGE 记 FAILED，12 / 13 = SUCCEEDED；应扣佣金 = refund_fen）→ orders 的写入方
// （createRightsSyncWriter：找单 → lockOrderKey → 重读 FOR UPDATE → rights.record，source API，now = 注入的 Clock）
// → 真实 settlement rights-command（createRightsCommandPort，注入 admin 的 createSystemAuditWriter 作审计端口，同
// 生产接法）→ 真实 rebate 端口（createRebatePort）→ 真实 commission 估值（createCommissionEstimates，不是替身）。
// 订单与快照沿用 commission/estimate-port 夹具（只读复用）：预估 1000、快照 N 1000、预留 1500、自购 5000 / 直推
// 1000 / 间推 500（N 1000 → B 850 → 425 / 85 / 42）。联盟维权单是合成的归一形状（taobao-rights-sync/kit.ts 的
// refund，只读复用），单号是掩码形状的合成串。期望金额全部手写在用例里。集成测试把库传进来：本文件不 import
// @couli/db/testing。
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createRightsSyncWriter,
  type RightsSyncItem,
  type RightsSyncTarget,
  type RightsSyncWriter,
} from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import type { RightsCommandPort } from '../../../../apps/api/src/modules/orders/index.ts';
import { handleRightsWindow } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import type { RebateDependencies } from '../../../../apps/api/src/modules/settlement/rebate/application/rebate.ts';
import { createRightsCommandPort } from '../../../../apps/api/src/modules/settlement/rights/index.ts';
import type { UnionRefund } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  estimatesOf,
  fixture as estimateFixture,
  orderRow,
  rebateOf,
  type OrderInput,
  type SeededPortOrder,
} from '../../commission/estimate-port/kit.ts';
import { harness as clawbackHarness } from '../../settlement/clawback/kit.ts';
import {
  REASON,
  adminAuditWriter,
  text,
  type RightsAudit,
} from '../../settlement/rights-audit-port/kit.ts';
import {
  HOUR_MS,
  NOW_MS,
  RIGHTS_JOB,
  fixture as syncFixture,
  iso,
  job,
  refund,
  rightsWindow,
} from '../taobao-rights-sync/kit.ts';

export { TIMEOUT, databaseFixture } from '../../settlement/clawback/kit.ts';
export { amountsAt, storedVersions, totalsAt } from '../../commission/estimate-port/kit.ts';
export { REASON, REOPEN_ACTION } from '../../settlement/rights-audit-port/kit.ts';
export type { SeededPortOrder } from '../../commission/estimate-port/kit.ts';

/** 合成的淘宝维权单号（掩码形状）；同一用例里的每次上报都是这一单。 */
export const TB_RIGHTS_NO = '3300000000000007001';
const START = iso(NOW_MS - 10 * HOUR_MS);
const RECEIVED_AT = '2026-10-25T10:00:00+08:00';
const PERIOD = '2026-10';

/** 淘宝 refund_status 原值（本组用例用到的几种）。 */
export type TaobaoRefundCode = '4' | '12' | '13' | '14' | '15';

/** 联盟适配器对这些原值的归一（D10-645 ②，见 UnionRefund.rights_status 的注释）。 */
const NORMALIZED: Readonly<Record<TaobaoRefundCode, NonNullable<UnionRefund['rights_status']>>> = {
  '4': 'PROCESSING',
  '12': 'SUCCEEDED',
  '13': 'SUCCEEDED',
  '14': 'CLOSED_NO_CHARGE',
  '15': 'CLOSED_NO_CHARGE',
};

export async function harness(db: Kysely<DB>) {
  const h = await clawbackHarness(db);
  const appId = h.appId;
  const clock = h.clock;
  const f = await estimateFixture(db, appId);

  // commission 的真实估值；spy 只记录 settlement 怎么调它，参数原样转给真实端口。
  const real = estimatesOf(clock);
  const refresh = vi.fn<RebateDependencies['estimates']['refresh']>((...args) =>
    real.refresh(...args),
  );
  const rebate = rebateOf(
    clock,
    { bases: (trx, input) => real.bases(trx, input), refresh },
    { publish: h.publish },
  );

  const rightsLogs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        rightsLogs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  // 记下 rights.record 与审计端口各自拿到的事务，用来核对「同一事务」。
  const recordTrxs: Transaction<DB>[] = [];
  const auditTrxs: Transaction<DB>[] = [];
  const admin = await adminAuditWriter(clock);
  const audit: RightsAudit = {
    appendAction(trx, input) {
      auditTrxs.push(trx);
      return admin.appendAction(trx, input);
    },
  };
  const settlementRights = createRightsCommandPort({
    clock,
    logger,
    events: { publish: h.publish },
    clawback: h.boot(),
    rebate,
    audit,
  });
  const rights: RightsCommandPort = {
    record(trx, input) {
      recordTrxs.push(trx);
      return settlementRights.record(trx, input);
    },
  };
  const syncWriter = createRightsSyncWriter({ db, clock, rights });
  const results: string[] = [];
  const writer: RightsSyncWriter = {
    async write(target, item, extras) {
      const result = await syncWriter.write(target, item, extras);
      results.push(result.kind);
      return result;
    },
  };

  // ---- seeding ---------------------------------------------------------------------------------
  /** ESTIMATED，平台 PAID，没有结算记录（有效联盟佣金 = 预估 1000）。 */
  function estimated(spec: OrderInput = {}): Promise<SeededPortOrder> {
    return f.order({ estFen: 1000n, ...spec });
  }

  /** WAITING，平台 RECEIVED（已收货），没有结算记录（有效联盟佣金 = 预估 1000）。 */
  function waiting(spec: OrderInput = {}): Promise<SeededPortOrder> {
    return f.order({
      estFen: 1000n,
      rebateStatus: 'WAITING',
      platformStatus: 'RECEIVED',
      ...spec,
      patch: { received_at: new Date(RECEIVED_AT), settle_period: PERIOD, ...spec.patch },
    });
  }

  // ---- the entries under test ------------------------------------------------------------------
  /**
   * 投一窗淘宝维权，窗里只有这一条（订单号 = 种入订单的子单号、单号 TB_RIGHTS_NO、应扣佣金 `fen`）；答的是写入方
   * 这一条的结果。
   */
  async function deliver(
    o: SeededPortOrder,
    code: TaobaoRefundCode,
    fen: bigint,
  ): Promise<string | undefined> {
    const before = results.length;
    const s = syncFixture({
      refundPages: [
        [
          refund(1, {
            order_id: o.subOrderId,
            refund_id: TB_RIGHTS_NO,
            refund_fen: fen,
            base_refund_fen: fen,
            refund_status: code,
            rights_status: NORMALIZED[code],
          }),
        ],
      ],
    });
    await handleRightsWindow(job(RIGHTS_JOB, { ...rightsWindow(START), app_id: appId }), {
      ...s.handler,
      writer,
    });
    expect(results).toHaveLength(before + 1);
    return results[before];
  }

  /**
   * 直接经 orders 的写入方记一条（同一维权单号、source API）：窗口处理器总带 refund_fen，「报成功但不带应扣佣金」
   * 只能从写入方这一层进来。
   */
  async function write(
    o: SeededPortOrder,
    item: Pick<RightsSyncItem, 'status' | 'deduction_commission_fen'>,
  ): Promise<string> {
    const target: RightsSyncTarget = {
      app_id: appId,
      platform: 'taobao',
      sub_order_id: o.subOrderId,
    };
    const result = await writer.write(target, {
      type: 'RIGHTS',
      status: item.status,
      amount_fen: null,
      deduction_commission_fen: item.deduction_commission_fen,
      occurred_at: refund(1).refund_created_at ?? clock.now(),
      platform_rights_no: TB_RIGHTS_NO,
    });
    return result.kind;
  }

  // ---- reads -----------------------------------------------------------------------------------
  function read(o: SeededPortOrder) {
    return orderRow(db, o);
  }

  function rightsRows(o: SeededPortOrder) {
    return db
      .selectFrom('order_rights')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** 本单唯一的一条维权记录（不是恰好一条就让用例失败）。 */
  async function onlyRights(o: SeededPortOrder) {
    const rows = await rightsRows(o);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error('precredit kit: no order_rights row');
    return row;
  }

  function rebateHistory(o: SeededPortOrder) {
    return db
      .selectFrom('order_status_history')
      .select(['event', 'from_status', 'to_status'])
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('field', '=', 'rebate')
      .orderBy('id')
      .execute();
  }

  function audits() {
    return db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute();
  }

  /** 本 App 提到 union_reported_success_after_closed 的审计行。 */
  async function reasonAudits() {
    return (await audits()).filter((row) => text(row).includes(REASON));
  }

  /** 告警：warn 及以上、带 alert 字段、提到这条原因的日志（同 [AC-B1-04zza#45] 的口径）。 */
  function reasonAlerts(): Record<string, unknown>[] {
    return [...h.logs, ...rightsLogs].filter(
      (line) =>
        Number(line['level']) >= 40 &&
        typeof line['alert'] === 'string' &&
        text(line).includes(REASON),
    );
  }

  /** 本 App 的凭证与分录（入账前任何一步都不得写）。 */
  async function money() {
    return {
      vouchers: await db
        .selectFrom('ledger_vouchers')
        .selectAll()
        .where('app_id', '=', appId)
        .execute(),
      entries: await db
        .selectFrom('ledger_entries')
        .selectAll()
        .where('app_id', '=', appId)
        .execute(),
    };
  }

  /** settlement 发出的事件名（h.publish 第 `from` 次调用之后）。 */
  function publishedSince(from: number): string[] {
    return h.publish.mock.calls.slice(from).map(([, event]) => event.name);
  }

  /** settlement 调 commission refresh 时带的第三参，按调用顺序。 */
  function refreshValues() {
    return refresh.mock.calls.map((call) => call[2]);
  }

  /** 一次上报可能写的一切（本 App），用于前后对比。 */
  async function everything() {
    return {
      orders: await db
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('order_id')
        .execute(),
      rights: await db
        .selectFrom('order_rights')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
      vouchers: await db
        .selectFrom('ledger_vouchers')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('uniq_key')
        .execute(),
      entries: await db
        .selectFrom('ledger_entries')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
      balances: await db
        .selectFrom('account_balances')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('account_id')
        .execute(),
      history: await db
        .selectFrom('order_status_history')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
      events: await db
        .selectFrom('event_log')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
      pending: await db
        .selectFrom('order_sync_pending')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
      audits: await audits(),
      amounts: await db
        .selectFrom('commission_split_amounts')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('order_id')
        .orderBy('commission_version')
        .orderBy('role')
        .execute(),
      totals: await db
        .selectFrom('commission_split_totals')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('order_id')
        .orderBy('commission_version')
        .execute(),
    };
  }

  return {
    appId,
    clock,
    publish: h.publish,
    refresh,
    recordTrxs,
    auditTrxs,
    estimated,
    waiting,
    deliver,
    write,
    read,
    rightsRows,
    onlyRights,
    rebateHistory,
    audits,
    reasonAudits,
    reasonAlerts,
    money,
    publishedSince,
    refreshValues,
    everything,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
