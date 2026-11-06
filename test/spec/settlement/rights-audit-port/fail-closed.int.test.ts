// B2-04zx（FU-B104ZZA-AUDIT-PORT，编排 D10-717 ① / D10-723）①：settlement 的 rights-command 没注入审计端口
// （deps.audit 缺省，即 settlement/rights 与 rights-estimate 两个大夹具的建法）时，遇到 D10-699 的重开——已存
// order_rights 是 source=API、status=FAILED，联盟再报成功（入参 API、按 SUCCEEDED 存）——必须在写任何东西
// 之前抛错（fail-closed）：不再由 settlement 自己兜底直写 admin 的审计表。
// 钉法：在同一个调用方事务里、record 抛错之后、回滚之前，把 record 可能写的一切读一遍，必须与调用前一致
// （order_rights 仍 FAILED、row_version 不变；没有凭证、分录、余额、历史、事件、待处理行、审计行），也不碰
// 记账 / 事件 / 估值边界，不告警；调用方事务之后能照常读（不是 PG 错误把事务弄坏），回滚后库里与调用前一致。
// 默认订单同 settlement/rights/record-credited（N 1000、预留 1500、自购 / 直推 / 间推）；入账前用 WAITING 订单。
// 用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  auditHarness,
  databaseFixture,
  type AuditHarness,
  type RecordSpec,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const CLOSED_NO = 'closed-n1';

interface ReopenCase {
  readonly label: string;
  readonly seed: (h: AuditHarness) => Promise<SeededOrder>;
  /** Steps through the bare port that leave an API record FAILED (each must be applied). */
  readonly closing: readonly RecordSpec[];
  /** The union's later success on the same platform_rights_no. */
  readonly reopen: RecordSpec;
}

const credited = (h: AuditHarness) => h.credited();
const waiting = (h: AuditHarness) => h.order();

const CASES: readonly ReopenCase[] = [
  {
    label: '入账后订单，RIGHTS：API 先 PROCESSING 再 FAILED，联盟后报 SUCCEEDED（应扣佣金 400）',
    seed: credited,
    closing: [
      { source: 'API', status: 'PROCESSING', deductionFen: null, rightsNo: CLOSED_NO },
      { source: 'API', status: 'FAILED', deductionFen: 400n, rightsNo: CLOSED_NO },
    ],
    reopen: { source: 'API', status: 'SUCCEEDED', deductionFen: 400n, rightsNo: CLOSED_NO },
  },
  {
    label:
      '入账后订单，RIGHTS：API 直接 FAILED，联盟后报 SUCCEEDED（应扣佣金 1200，若放开会全额扣回）',
    seed: credited,
    closing: [{ source: 'API', status: 'FAILED', deductionFen: 1200n, rightsNo: CLOSED_NO }],
    reopen: { source: 'API', status: 'SUCCEEDED', deductionFen: 1200n, rightsNo: CLOSED_NO },
  },
  {
    label: '入账后订单，PUNISH：API FAILED，联盟后报 SUCCEEDED',
    seed: credited,
    closing: [
      { source: 'API', type: 'PUNISH', status: 'FAILED', deductionFen: null, rightsNo: CLOSED_NO },
    ],
    reopen: {
      source: 'API',
      type: 'PUNISH',
      status: 'SUCCEEDED',
      deductionFen: null,
      rightsNo: CLOSED_NO,
    },
  },
  {
    label:
      '入账前订单（WAITING），RIGHTS：API FAILED，联盟后报 SUCCEEDED（应扣佣金 400，若放开会走 R7）',
    seed: waiting,
    closing: [{ source: 'API', status: 'FAILED', deductionFen: 400n, rightsNo: CLOSED_NO }],
    reopen: { source: 'API', status: 'SUCCEEDED', deductionFen: 400n, rightsNo: CLOSED_NO },
  },
];

it.each(CASES)(
  '[AC-B2-04zx#1] 缺审计端口、$label：record 在写任何东西之前抛错（fail-closed）——同一调用方事务里抛错后读到的与调用前完全一致（order_rights 仍 FAILED、row_version 不变，无凭证 / 分录 / 余额 / 历史 / 事件 / 待处理 / 审计行），不调记账、事件、估值边界，不告警；事务仍可用、回滚后库与调用前一致；再来一次照样拒绝',
  async ({ seed, closing, reopen }) => {
    const h = await auditHarness(p.db);
    const o = await seed(h);
    for (const step of closing) {
      expect(await h.commit(h.bare(), o, step)).toEqual({ kind: 'applied' });
    }
    const closed = await h.rightsOf(o, CLOSED_NO);
    expect(closed).toMatchObject({ source: 'API', status: 'FAILED' });
    const committed = await h.appState();
    const everything = await h.everything();
    const calls = h.calls();

    const refused = await h.attempt(h.bare(), o, reopen);
    expect(refused.result).toBeUndefined();
    expect(refused.error).toBeInstanceOf(Error);
    // Nothing written on the caller's transaction, not just undone by its rollback.
    expect(refused.after).toEqual(refused.before);
    expect(refused.before).toEqual(committed);
    expect(h.calls()).toEqual(calls);
    expect(h.reasonAlerts()).toEqual([]);

    expect(await h.appState()).toEqual(committed);
    expect(await h.everything()).toEqual(everything);
    expect(await h.rightsOf(o, CLOSED_NO)).toEqual(closed);
    expect(await h.reasonAudits()).toEqual([]);
    expect(await h.audits()).toEqual([]);

    const again = await h.attempt(h.bare(), o, reopen);
    expect(again.result).toBeUndefined();
    expect(again.error).toBeInstanceOf(Error);
    expect(again.after).toEqual(again.before);
    expect(await h.appState()).toEqual(committed);
    expect(h.calls()).toEqual(calls);
    expect(h.reasonAlerts()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zx#2] 缺审计端口时的拒绝只对 D10-699 重开：同一订单上被拒的那条之外，另一条维权单号的 PROCESSING → SUCCEEDED（应扣佣金 400）照常 applied、按 BR-FUND-08 ② 扣回（键带 R{id}）；被拒那条仍是 FAILED 原样，审计表无行、无该原因告警',
  async () => {
    const h = await auditHarness(p.db);
    const o = await h.credited();
    expect(
      await h.commit(h.bare(), o, {
        source: 'API',
        status: 'FAILED',
        deductionFen: 400n,
        rightsNo: CLOSED_NO,
      }),
    ).toEqual({ kind: 'applied' });
    const closed = await h.rightsOf(o, CLOSED_NO);

    const refused = await h.attempt(h.bare(), o, {
      source: 'API',
      status: 'SUCCEEDED',
      deductionFen: 400n,
      rightsNo: CLOSED_NO,
    });
    expect(refused.error).toBeInstanceOf(Error);
    expect(refused.after).toEqual(refused.before);

    expect(
      await h.commit(h.bare(), o, {
        source: 'API',
        status: 'PROCESSING',
        deductionFen: null,
        rightsNo: 'other-n1',
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      await h.commit(h.bare(), o, {
        source: 'API',
        status: 'SUCCEEDED',
        deductionFen: 400n,
        rightsNo: 'other-n1',
      }),
    ).toEqual({ kind: 'applied' });
    const other = await h.rightsOf(o, 'other-n1');
    expect(other).toMatchObject({ source: 'API', status: 'SUCCEEDED' });
    expect(await h.clawbackKeys(o)).toHaveLength(4);
    expect((await h.clawbackKeys(o)).every((key) => key.endsWith(`:R${other.id}`))).toBe(true);
    expect(await h.rightsOf(o, CLOSED_NO)).toEqual(closed);
    expect(await h.audits()).toEqual([]);
    expect(h.reasonAlerts()).toEqual([]);
  },
  TIMEOUT,
);
