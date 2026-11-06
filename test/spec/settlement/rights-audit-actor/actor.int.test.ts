// B2-04zz（FU-AUDIT-ACTOR-SETTLEMENT 实现半，编排 D10-717 ②、D10-769；契约 CT-26z）：D10-699 的重开
// （接口来源 API 的维权记录已落为 FAILED、联盟之后报成功 → 按 SUCCEEDED 处理，BR-FUND-06 细则「淘宝维权
// 『从卖家处补扣』」）写出的系统审计，系统身份由暂记的 system:risk 改为 CT-26z 新增的 system:settlement
// （contracts/enums/admin.yaml audit_system_actor，中文名「系统（结算）」）；动作 order_rights_success_after_closed、
// 目标 order_rights:<id>、前后状态与原因 union_reported_success_after_closed 都不变，审计仍只经注入的端口
// （B2-04zx），admin_id 为空。后台审计查询（admin 的 createAuditLogsReader + createAuditLogStore，不起 HTTP）
// 对这行显示系统操作人「系统（结算）」。任何一处都不得出现 system:risk。
// 夹具复用 test/spec/settlement/rights-audit-port/kit.ts（B2-04zx，只读引用）：默认订单同
// settlement/rights/record-credited（N 1000、预留 1500 → B 850；应扣佣金 400 → N_new 600 → B 510）。
// 用例全部是顶层 it（规划/11 §4.3）。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createAuditLogsReader } from '../../../../apps/api/src/modules/admin/application/audit-logs-read.ts';
import { createAuditLogIdCodec } from '../../../../apps/api/src/modules/admin/infra/audit-log-id.ts';
import { createAuditLogStore } from '../../../../apps/api/src/modules/admin/infra/audit-log-store.ts';
import {
  REASON,
  REOPEN_ACTION,
  TIMEOUT,
  adminAuditWriter,
  auditHarness,
  databaseFixture,
  keysOf,
  recordingAudit,
  text,
  type AuditHarness,
  type RecordSpec,
  type SeededOrder,
} from '../rights-audit-port/kit.ts';

const p = databaseFixture(createTestDatabase);

/** CT-26z: settlement's system identity (contracts/enums/admin.yaml audit_system_actor). */
const SETTLEMENT_ACTOR = 'system:settlement';
/** Its Chinese name in the same enum (系统操作人中文名). */
const SETTLEMENT_ACTOR_NAME = '系统（结算）';
/** The provisional identity this task retires; must not appear anywhere. */
const RISK_ACTOR = 'system:risk';

const CLOSED_NO = 'closed-actor-n1';
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

/** Seeds the closed API record (through the port-less command, which needs no audit for it). */
async function closed(h: AuditHarness, o: SeededOrder) {
  expect(await h.commit(h.bare(), o, CLOSE)).toEqual({ kind: 'applied' });
  const row = await h.rightsOf(o, CLOSED_NO);
  expect(row).toMatchObject({ source: 'API', status: 'FAILED' });
  return row;
}

/** The audit port's input of the reopen of `id`, as B2-04zx pinned it, with the new actor. */
function expectedInput(appId: string, id: string) {
  return {
    appId,
    actor: SETTLEMENT_ACTOR,
    action: REOPEN_ACTION,
    target: `order_rights:${id}`,
    before: { order_rights_id: id, status: 'FAILED', source: 'API' },
    after: { order_rights_id: id, status: 'SUCCEEDED', source: 'API', reason: REASON },
  };
}

it(
  '[AC-B2-04zz#1] 入账后订单：API 源已 FAILED、联盟后报 SUCCEEDED 的重开经注入（记录调用的假）审计端口 applied；端口恰被调用一次、同一事务，入参 actor 恰为 system:settlement，动作 order_rights_success_after_closed、目标 order_rights:<id>、前后状态与原因 union_reported_success_after_closed 不变；入参任何位置都不含 system:risk；扣回照旧一次（键带 R{id}）',
  async () => {
    const h = await auditHarness(p.db);
    const o = await h.credited();
    const before = await closed(h, o);

    const fake = recordingAudit();
    const done = await h.attempt(h.withAudit(fake.audit), o, REOPEN);
    expect(done.error).toBeUndefined();
    expect(done.result).toEqual({ kind: 'applied' });
    expect(await h.rightsOf(o, CLOSED_NO)).toMatchObject({
      id: before.id,
      status: 'SUCCEEDED',
      row_version: before.row_version + 1,
    });
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, `R${before.id}`));

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.trx).toBe(done.trx);
    expect(String(fake.calls[0]?.input.actor)).toBe(SETTLEMENT_ACTOR);
    expect(fake.calls[0]?.input).toEqual(expectedInput(h.appId, before.id));
    expect(text(fake.calls.map((call) => call.input))).not.toContain(RISK_ACTOR);
    expect(await h.audits()).toEqual([]);
    expect(h.reasonAlerts()).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zz#2] 入账前订单（WAITING）：同一重开经注入（记录调用的假）审计端口 applied，按 R7 RIGHTS_PARTIAL 处理（返利状态不变、无凭证）；端口恰被调用一次、同一事务，入参 actor 恰为 system:settlement，其余审计字段不变；入参任何位置都不含 system:risk',
  async () => {
    const h = await auditHarness(p.db);
    const o = await h.order();
    const before = await closed(h, o);

    const fake = recordingAudit();
    const done = await h.attempt(h.withAudit(fake.audit), o, REOPEN);
    expect(done.error).toBeUndefined();
    expect(done.result).toEqual({ kind: 'applied' });
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', rights_pending: false });
    expect(await h.orderVoucherKeys(o)).toEqual([]);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.trx).toBe(done.trx);
    expect(String(fake.calls[0]?.input.actor)).toBe(SETTLEMENT_ACTOR);
    expect(fake.calls[0]?.input).toEqual(expectedInput(h.appId, before.id));
    expect(text(fake.calls.map((call) => call.input))).not.toContain(RISK_ACTOR);
    expect(await h.audits()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zz#3] 注入 admin 真实的 createSystemAuditWriter（生产的接法）：重开提交后恰一条审计行——本 App、admin_id 为空、system_actor = system:settlement、动作 order_rights_success_after_closed、目标 order_rights:<id>、before / after 不变（after.reason = union_reported_success_after_closed）；本 App 的审计行里没有 system:risk；后台审计查询（admin 的列表与详情读取，不起 HTTP，看全部审计的账号）对这行显示系统操作人 system:settlement、中文名「系统（结算）」、无账号',
  async () => {
    const h = await auditHarness(p.db);
    const o = await h.credited();
    const before = await closed(h, o);

    const done = await h.attempt(h.withAudit(await adminAuditWriter(h.clock)), o, REOPEN);
    expect(done.error).toBeUndefined();
    expect(done.result).toEqual({ kind: 'applied' });
    expect(await h.clawbackKeys(o)).toEqual(keysOf(o, `R${before.id}`));

    const audits = await h.audits();
    expect(audits).toHaveLength(1);
    const audit = audits[0] as unknown as Record<string, unknown>;
    expect(audit).toMatchObject({
      app_id: h.appId,
      admin_id: null,
      action: REOPEN_ACTION,
      target: `order_rights:${before.id}`,
    });
    expect(audit['system_actor']).toBe(SETTLEMENT_ACTOR);
    expect(audit['before']).toEqual({
      order_rights_id: before.id,
      status: 'FAILED',
      source: 'API',
    });
    expect(audit['after']).toEqual({
      order_rights_id: before.id,
      status: 'SUCCEEDED',
      source: 'API',
      reason: REASON,
    });
    expect(text(audits)).not.toContain(RISK_ACTOR);

    // admin's audit search as the console reads it (super admin: sees every record, system rows too).
    const ids = createAuditLogIdCodec(Buffer.alloc(16, 26));
    const reader = createAuditLogsReader({
      store: createAuditLogStore({ db: p.db }),
      profiles: { permissionKeys: async () => [] },
      ids: () => ids,
      configPermissions: new Map(),
    });
    const caller = { appId: h.appId, adminId: randomUUID(), isSuper: true };

    const page = await reader.list(caller, { page: 1, pageSize: 20 });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item).toMatchObject({
      actorId: null,
      actorKind: 'system',
      systemActor: SETTLEMENT_ACTOR,
      actorName: SETTLEMENT_ACTOR_NAME,
      action: REOPEN_ACTION,
    });

    const detail = await reader.get(caller, item.id);
    expect(detail).toMatchObject({
      id: item.id,
      actorId: null,
      actorKind: 'system',
      systemActor: SETTLEMENT_ACTOR,
      actorName: SETTLEMENT_ACTOR_NAME,
      action: REOPEN_ACTION,
    });
    expect(text(detail?.after)).toContain(REASON);
    expect(text([page, detail])).not.toContain(RISK_ACTOR);
  },
  TIMEOUT,
);
