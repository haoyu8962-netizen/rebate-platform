// money r1 S0（编排 D10-699）：settlement 的 rights-command 只放开一种迁移——已存的 order_rights 是 source=API、
// status=FAILED，联盟后续同步报成功（SUCCEEDED）→ 按 SUCCEEDED 处理（开扣回，answered 照现行），写审计（原因
// union_reported_success_after_closed）并告警一条。其余照旧 duplicate、什么都不写：ADMIN / 导入源的 FAILED；
// SUCCEEDED 之后的任何回退；FAILED → PROCESSING / WAIT_COMMISSION；FAILED → FAILED 重放。
// #45 走真实链路：本单的维权处理器（rights_status 是联盟适配器归一后的值，14 / 15 = CLOSED_NO_CHARGE 记 FAILED，
// 13 = SUCCEEDED）→ 本单写入方（找单 → 锁 → 重读 → rights.record，source API）→ 真实 settlement rights-command
// （B2-04l 夹具：真实入账、真实扣回编排，不是假实现）。入账后的默认订单同 settlement/rights/record-credited：
// N 1000、预留 1500 → B 850，自购 425 / 直推 85 / 间推 42、平台 448；应扣佣金 400 → N_new 600 → B 510：
// 扣回 170 / 34 / 17、平台 179，booked 510 / 600（同 [AC-B2-04l#1]，按 BR-FUND-08 ②）。
// #46 逐条钉仍 duplicate 的情形；每条在同一订单上另起一条 API 源 FAILED → SUCCEEDED 作对照（只有它放开）。
// rights.record 的入参来源只有 API / IMPORT，ADMIN 源的已关闭记录直接种进 order_rights（夹具）。
// 用例全部是顶层 it（规划/11 §4.3）。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  createRightsSyncWriter,
  type RightsSyncWriter,
} from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import { handleRightsWindow } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import type { UnionRefund } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  OCCURRED_AT,
  TIMEOUT,
  clawbackKey,
  databaseFixture,
  harness,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
  type Harness,
  type RecordSpec,
  type SeededOrder,
} from '../../settlement/rights/kit.ts';
import { HOUR_MS, NOW_MS, RIGHTS_JOB, fixture, iso, job, refund, rightsWindow } from './kit.ts';

const p = databaseFixture(createTestDatabase);

const REASON = 'union_reported_success_after_closed';
/** 合成的淘宝维权单号（掩码形状）。 */
const TB_RIGHTS_NO = '3300000000000006001';
const START = iso(NOW_MS - 10 * HOUR_MS);
/** #46：被钉住仍 duplicate 的那条记录、与作对照放开的那条记录的单号。 */
const GUARD_NO = 'guard-n1';
const OPEN_NO = 'open-n1';

/** The four CLAWBACK keys of one rights event on the default order. */
function keysOf(o: SeededOrder, id: string): string[] {
  return [
    clawbackKey(o, 'self', id),
    clawbackKey(o, 'direct', id),
    clawbackKey(o, 'indirect', id),
    platformClawbackKey(o, id),
  ].sort();
}

/** 整行打印（bigint 按文本），用于找原因串。 */
function text(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    typeof member === 'bigint' ? member.toString() : member,
  );
}

/** 告警：settlement 的 warn 及以上日志、带 alert 字段（同 [AC-B2-04l#5] 的口径）、提到这条原因。 */
function reasonAlerts(h: Harness): Record<string, unknown>[] {
  return [...h.logs, ...h.rightsLogs].filter(
    (line) =>
      Number(line['level']) >= 40 &&
      typeof line['alert'] === 'string' &&
      text(line).includes(REASON),
  );
}

/** 本 App 提到这条原因的审计行。 */
async function reasonAudits(h: Harness) {
  return (await h.audits()).filter((row) => text(row).includes(REASON));
}

/**
 * 本单的维权处理器与写入方，写入方接真实 settlement 的 rights.record。每次投一窗、该窗只有这一条维权
 * （订单号 = 种入订单的子单号，应扣佣金 4.00 元）；答的是写入方这一条的结果。
 */
function rightsSync(h: Harness) {
  const real = createRightsSyncWriter({ db: p.db, clock: h.clock, rights: h.recordPort() });
  const results: string[] = [];
  const writer: RightsSyncWriter = {
    async write(target, item) {
      const result = await real.write(target, item);
      results.push(result.kind);
      return result;
    },
  };
  async function deliver(o: SeededOrder, patch: Partial<UnionRefund>): Promise<string | undefined> {
    const before = results.length;
    const f = fixture({
      refundPages: [
        [
          refund(1, {
            order_id: o.subOrderId,
            refund_id: TB_RIGHTS_NO,
            refund_fen: 400n,
            base_refund_fen: 400n,
            ...patch,
          }),
        ],
      ],
    });
    await handleRightsWindow(job(RIGHTS_JOB, { ...rightsWindow(START), app_id: h.appId }), {
      ...f.handler,
      writer,
    });
    expect(results).toHaveLength(before + 1);
    return results[before];
  }
  return { deliver };
}

it.each(['14', '15'] as const)(
  '[AC-B1-04zza#45] 真实 settlement 下 API 源维权先处理中、再 %s（结束且不扣我方 → FAILED：rights_pending 解除、不扣回），同一维权单号后来 13（扣款成功）→ 同一条记录按 SUCCEEDED 处理、按 BR-FUND-08 部分扣回一次（170 / 34 / 17、平台 179，键带 R{id}），写一条原因 union_reported_success_after_closed 的审计、告警一条；再重放 13 → duplicate，不重复扣、什么都不变',
  async (code) => {
    const h = await harness(p.db);
    const o = await h.credited();
    // B2-04zx（D10-723）：settlement 不再兜底直写审计表，本用例自己注入审计端口——admin 的
    // createSystemAuditWriter（同生产接法），写入方接的是注入了它的 settlement rights.record。在用例内动态
    // 导入，冻结文件在用例之外不改（D10-701 modify_existing）。
    const audited = await import('../../settlement/rights-audit-port/kit.ts');
    const port = audited.auditedRights(h).withAudit(await audited.adminAuditWriter(h.clock));
    const sync = rightsSync({ ...h, recordPort: () => port });

    expect(await sync.deliver(o, { refund_status: '4', rights_status: 'PROCESSING' })).toBe(
      'applied',
    );
    const processing = await h.onlyRights(o);
    expect(processing).toMatchObject({
      source: 'API',
      type: 'RIGHTS',
      status: 'PROCESSING',
      platform_rights_no: TB_RIGHTS_NO,
    });
    expect((await h.rebateColumns(o)).rights_pending).toBe(true);

    expect(await sync.deliver(o, { refund_status: code, rights_status: 'CLOSED_NO_CHARGE' })).toBe(
      'applied',
    );
    const failed = await h.onlyRights(o);
    expect(failed).toMatchObject({ id: processing.id, source: 'API', status: 'FAILED' });
    expect(await h.rebateColumns(o)).toEqual({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      reason: null,
      diff_reason_code: null,
      rights_pending: false,
      hold: false,
    });
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await reasonAudits(h)).toEqual([]);
    expect(reasonAlerts(h)).toEqual([]);

    expect(await sync.deliver(o, { refund_status: '13', rights_status: 'SUCCEEDED' })).toBe(
      'applied',
    );
    const succeeded = await h.onlyRights(o);
    expect(succeeded).toMatchObject({
      id: processing.id,
      source: 'API',
      type: 'RIGHTS',
      status: 'SUCCEEDED',
      deduction_commission_fen: 400n,
      row_version: failed.row_version + 1,
    });
    const id = `R${succeeded.id}`;
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 170n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 34n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 17n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 179n),
    );
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
    expect(await h.rebateColumns(o)).toEqual({
      rebate_status: 'CREDITED',
      booked_base_fen: 510n,
      booked_n_fen: 600n,
      reason: null,
      diff_reason_code: 'PART_REFUND',
      rights_pending: false,
      hold: false,
    });
    expect(await h.rebateHistoryAfterCredit(o)).toContainEqual(
      expect.objectContaining({
        from_status: 'CREDITED',
        to_status: 'CREDITED',
        event: 'RIGHTS_PARTIAL',
      }),
    );
    expect(await h.balance(o.user('self'))).toBe(255n);
    expect(await h.balance(o.user('direct'))).toBe(51n);
    expect(await h.balance(o.user('indirect'))).toBe(25n);
    const audits = await reasonAudits(h);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ app_id: h.appId, admin_id: null });
    expect(audits[0]).toMatchObject({
      action: 'order_rights_success_after_closed',
      target: `order_rights:${succeeded.id}`,
    });
    expect(reasonAlerts(h)).toHaveLength(1);
    const settled = await h.everything();

    expect(await sync.deliver(o, { refund_status: '13', rights_status: 'SUCCEEDED' })).toBe(
      'duplicate',
    );
    expect(await h.everything()).toEqual(settled);
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, id));
    expect(reasonAlerts(h)).toHaveLength(1);
  },
  TIMEOUT,
);

/** 种一条 ADMIN 源、已关闭（FAILED）的维权记录（rights.record 的入参没有 ADMIN）。 */
async function seedAdminFailed(h: Harness, o: SeededOrder): Promise<void> {
  await p.db
    .insertInto('order_rights')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      order_id: o.orderId,
      source: 'ADMIN',
      type: 'RIGHTS',
      status: 'FAILED',
      amount_fen: null,
      deduction_commission_fen: 400n,
      occurred_at: new Date(OCCURRED_AT),
      platform_rights_no: GUARD_NO,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();
}

/** 经 rights.record 种一条记录（单号 GUARD_NO、应扣佣金 400），必须 applied。 */
function recorded(spec: RecordSpec): (h: Harness, o: SeededOrder) => Promise<void> {
  return async (h, o) => {
    expect(await h.record(o, { rightsNo: GUARD_NO, deductionFen: 400n, ...spec })).toEqual({
      kind: 'applied',
    });
  };
}

interface GuardCase {
  readonly label: string;
  readonly seed: (h: Harness, o: SeededOrder) => Promise<void>;
  /** 同一维权单号再来的那一次。 */
  readonly incoming: RecordSpec;
}

const API_SUCCEEDED: RecordSpec = {
  source: 'API',
  status: 'SUCCEEDED',
  deductionFen: 400n,
  rightsNo: GUARD_NO,
};

const GUARDS: readonly GuardCase[] = [
  { label: 'ADMIN 源 FAILED 之后联盟报成功', seed: seedAdminFailed, incoming: API_SUCCEEDED },
  {
    label: '导入源 FAILED 之后联盟报成功',
    seed: recorded({ source: 'IMPORT', status: 'FAILED' }),
    incoming: API_SUCCEEDED,
  },
  {
    label: 'API 源 SUCCEEDED 之后报 FAILED（成功后回退）',
    seed: recorded({ source: 'API', status: 'SUCCEEDED' }),
    incoming: { source: 'API', status: 'FAILED', deductionFen: 400n, rightsNo: GUARD_NO },
  },
  {
    label: 'API 源 FAILED 之后报 PROCESSING',
    seed: recorded({ source: 'API', status: 'FAILED' }),
    incoming: { source: 'API', status: 'PROCESSING', deductionFen: null, rightsNo: GUARD_NO },
  },
  {
    label: 'API 源 FAILED 之后报成功而无应扣佣金（会落 WAIT_COMMISSION）',
    seed: recorded({ source: 'API', status: 'FAILED' }),
    incoming: { source: 'API', status: 'SUCCEEDED', deductionFen: null, rightsNo: GUARD_NO },
  },
  {
    label: 'API 源 FAILED 之后 FAILED 重放',
    seed: recorded({ source: 'API', status: 'FAILED' }),
    incoming: { source: 'API', status: 'FAILED', deductionFen: 400n, rightsNo: GUARD_NO },
  },
];

it.each(GUARDS)(
  '[AC-B1-04zza#46] $label（入账后订单）：duplicate，什么都不写、不审计不告警；同一订单另一条 API 源 FAILED → SUCCEEDED 照样放开（applied、按成功扣回）',
  async ({ seed, incoming }) => {
    const h = await harness(p.db);
    const o = await h.credited();
    await seed(h, o);
    const before = await h.everything();

    expect(await h.record(o, incoming)).toEqual({ kind: 'duplicate' });
    expect(await h.everything()).toEqual(before);
    expect(await reasonAudits(h)).toEqual([]);
    expect(reasonAlerts(h)).toEqual([]);

    // 对照：只有 API 源、已存 FAILED、再报成功（带应扣佣金）这一种放开。
    // B2-04zx（D10-723）：放开的那一次经注入了审计端口（admin 的 createSystemAuditWriter）的 settlement
    // rights.record；在用例内动态导入，冻结文件在用例之外不改（D10-701 modify_existing）。
    const audited = await import('../../settlement/rights-audit-port/kit.ts');
    const rights = audited.auditedRights(h);
    const port = rights.withAudit(await audited.adminAuditWriter(h.clock));
    expect(
      await h.record(o, { source: 'API', status: 'FAILED', deductionFen: 100n, rightsNo: OPEN_NO }),
    ).toEqual({ kind: 'applied' });
    expect(
      await rights.commit(port, o, {
        source: 'API',
        status: 'SUCCEEDED',
        deductionFen: 100n,
        rightsNo: OPEN_NO,
      }),
    ).toEqual({ kind: 'applied' });
    const rows = await h.rightsRows(o);
    const opened = rows.find((row) => row.platform_rights_no === OPEN_NO);
    expect(opened).toMatchObject({ source: 'API', status: 'SUCCEEDED' });
    expect(await h.clawbackKeys(o)).toEqual(
      expect.arrayContaining(keysOf(o, `R${String(opened?.id)}`)),
    );
    // 被钉住的那条记录仍是种入后的样子。
    expect(rows.find((row) => row.platform_rights_no === GUARD_NO)).toEqual(
      before.rights.find((row) => row.platform_rights_no === GUARD_NO),
    );
  },
  TIMEOUT,
);
