// B2-04zx（FU-B104ZZA-AUDIT-PORT，编排 D10-723）②：注入了审计端口时，D10-699 的重开照 B1-04zza 现行——按
// SUCCEEDED 处理（同一条记录、row_version + 1，入账后按 BR-FUND-08 ② 扣回一次、键带 R{id}；入账前走 R7），
// 经端口、在 record 的同一事务上写一条审计（动作 order_rights_success_after_closed、目标 order_rights:<id>、
// after.reason = union_reported_success_after_closed），告警一条；审计只经端口写：注入的是不落库的假端口时，
// 审计表里没有任何行（settlement 自己不写）。每条用例先以同一订单、同一重开、缺端口的命令作对照：必须被拒、
// 什么都不写（本单要的 fail-closed），再用注入端口的命令放开。
// 默认订单同 settlement/rights/record-credited：N 1000、预留 1500 → B 850；应扣佣金 400 → N_new 600 → B 510：
// 扣回 170 / 34 / 17、平台 179，booked 510 / 600，余额 255 / 51 / 25。
// 用例全部是顶层 it（规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  REASON,
  REOPEN_ACTION,
  SYSTEM_ACTOR,
  TIMEOUT,
  adminAuditWriter,
  auditHarness,
  clawbackKey,
  databaseFixture,
  keysOf,
  recordingAudit,
  text,
  type AuditHarness,
  type RecordSpec,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const CLOSED_NO = 'closed-n1';
const CLOSE: RecordSpec = {
  source: 'API',
  status: 'FAILED',
  deductionFen: 400n,
  rightsNo: CLOSED_NO,
};
const REOPEN: RecordSpec = {
  source: 'API',
  status: 'SUCCEEDED',
  deductionFen: 400n,
  rightsNo: CLOSED_NO,
};

/** Seeds the closed API record and checks that the port-less command refuses its reopen. */
async function closedAndRefused(h: AuditHarness, o: SeededOrder) {
  expect(await h.commit(h.bare(), o, CLOSE)).toEqual({ kind: 'applied' });
  const closed = await h.rightsOf(o, CLOSED_NO);
  expect(closed).toMatchObject({ source: 'API', status: 'FAILED' });
  const committed = await h.appState();

  const refused = await h.attempt(h.bare(), o, REOPEN);
  expect(refused.result).toBeUndefined();
  expect(refused.error).toBeInstanceOf(Error);
  expect(refused.after).toEqual(refused.before);
  expect(await h.appState()).toEqual(committed);
  return closed;
}

it(
  '[AC-B2-04zx#3] 入账后订单：缺端口的命令拒绝重开、什么都不写；注入（记录调用的假）审计端口的命令对同一重开 applied——同一条记录 SUCCEEDED、row_version + 1，按 BR-FUND-08 ② 扣回一次 170 / 34 / 17、平台 179（键带 R{id}）；端口恰被调用一次、用的是 record 的同一事务、入参为系统身份 + 动作 order_rights_success_after_closed + 目标 order_rights:<id> + 前后状态与原因；审计表无行（settlement 不自写）；该原因告警一条；重放 → duplicate，端口不再被调用、不重复扣',
  async () => {
    const h = await auditHarness(p.db);
    const o = await h.credited();
    const closed = await closedAndRefused(h, o);

    const fake = recordingAudit();
    const port = h.withAudit(fake.audit);
    const done = await h.attempt(port, o, REOPEN);
    expect(done.error).toBeUndefined();
    expect(done.result).toEqual({ kind: 'applied' });

    const row = await h.rightsOf(o, CLOSED_NO);
    expect(row).toMatchObject({
      id: closed.id,
      source: 'API',
      type: 'RIGHTS',
      status: 'SUCCEEDED',
      deduction_commission_fen: 400n,
      row_version: closed.row_version + 1,
    });
    const eventId = `R${closed.id}`;
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, eventId));
    expect(await h.voucherLines(clawbackKey(o, 'self', eventId))).toHaveLength(2);
    expect(await h.balance(o.user('self'))).toBe(255n);
    expect(await h.balance(o.user('direct'))).toBe(51n);
    expect(await h.balance(o.user('indirect'))).toBe(25n);
    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 510n,
      booked_n_fen: 600n,
      rights_pending: false,
    });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.trx).toBe(done.trx);
    expect(fake.calls[0]?.input).toEqual({
      appId: h.appId,
      actor: expect.stringMatching(SYSTEM_ACTOR),
      action: REOPEN_ACTION,
      target: `order_rights:${closed.id}`,
      before: { order_rights_id: closed.id, status: 'FAILED', source: 'API' },
      after: { order_rights_id: closed.id, status: 'SUCCEEDED', source: 'API', reason: REASON },
    });
    expect(await h.audits()).toEqual([]);
    expect(h.reasonAlerts()).toHaveLength(1);

    const settled = await h.everything();
    const replay = await h.attempt(port, o, REOPEN);
    expect(replay.result).toEqual({ kind: 'duplicate' });
    expect(fake.calls).toHaveLength(1);
    expect(await h.everything()).toEqual(settled);
    expect(h.reasonAlerts()).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zx#4] 入账前订单（WAITING）：缺端口的命令拒绝重开、什么都不写；注入（记录调用的假）审计端口的命令对同一重开 applied——同一条记录 SUCCEEDED，按 R7 RIGHTS_PARTIAL 处理（返利状态不变、无凭证）；端口恰被调用一次、同一事务、入参同上；审计表无行；该原因告警一条',
  async () => {
    const h = await auditHarness(p.db);
    const o = await h.order();
    const closed = await closedAndRefused(h, o);

    const fake = recordingAudit();
    const done = await h.attempt(h.withAudit(fake.audit), o, REOPEN);
    expect(done.error).toBeUndefined();
    expect(done.result).toEqual({ kind: 'applied' });

    expect(await h.rightsOf(o, CLOSED_NO)).toMatchObject({
      id: closed.id,
      status: 'SUCCEEDED',
      row_version: closed.row_version + 1,
    });
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', rights_pending: false });
    expect(await h.history(o)).toContainEqual(
      expect.objectContaining({
        field: 'rebate',
        from_status: 'WAITING',
        event: 'RIGHTS_PARTIAL',
        to_status: 'WAITING',
      }),
    );
    expect(await h.orderVoucherKeys(o)).toEqual([]);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.trx).toBe(done.trx);
    expect(fake.calls[0]?.input).toEqual({
      appId: h.appId,
      actor: expect.stringMatching(SYSTEM_ACTOR),
      action: REOPEN_ACTION,
      target: `order_rights:${closed.id}`,
      before: { order_rights_id: closed.id, status: 'FAILED', source: 'API' },
      after: { order_rights_id: closed.id, status: 'SUCCEEDED', source: 'API', reason: REASON },
    });
    expect(await h.audits()).toEqual([]);
    expect(h.reasonAlerts()).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zx#5] 注入 admin 真实的 createSystemAuditWriter（生产的接法）：缺端口的命令先拒绝；经端口的重开若调用方事务随后失败 → 维权记录、扣回、审计行一起回滚（仍 FAILED、无审计行）；提交时恰一条审计行（本 App、admin_id 为空、system_actor 为系统身份、动作 order_rights_success_after_closed、目标 order_rights:<id>、带原因）',
  async () => {
    const h = await auditHarness(p.db);
    const o = await h.credited();
    const closed = await closedAndRefused(h, o);
    const port = h.withAudit(await adminAuditWriter(h.clock));
    const committed = await h.appState();

    await expect(
      h.attempt(port, o, REOPEN, {
        after: async () => {
          throw new Error('caller rolls back');
        },
      }),
    ).rejects.toThrow('caller rolls back');
    expect(await h.appState()).toEqual(committed);
    expect(await h.rightsOf(o, CLOSED_NO)).toEqual(closed);
    expect(await h.audits()).toEqual([]);

    const done = await h.attempt(port, o, REOPEN);
    expect(done.result).toEqual({ kind: 'applied' });
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, `R${closed.id}`));
    const audits = await h.audits();
    expect(audits).toHaveLength(1);
    const audit = audits[0] as unknown as Record<string, unknown>;
    expect(audit).toMatchObject({
      app_id: h.appId,
      admin_id: null,
      action: REOPEN_ACTION,
      target: `order_rights:${closed.id}`,
    });
    expect(String(audit['system_actor'])).toMatch(SYSTEM_ACTOR);
    expect(text(audit['after'])).toContain(REASON);
  },
  TIMEOUT,
);
