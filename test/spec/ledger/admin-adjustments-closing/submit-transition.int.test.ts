// B2-12d round 4 (claude-independent; 编排 06:59): the writes of admin_adjustments go through the
// generated state machine (specs/state-machines/admin-adjustment.yaml → transitionAdminAdjustment;
// apps/api/AGENTS.md「状态迁移只调生成的 transition()」), and the prefill writes its system audit
// (BR-FUND-24 ①「全程写 audit_logs」, ⑧).
// - AA2 SUBMIT (from no row → APPROVED): B2-12c's one-step adminCreateAdjustment writes its form
//   through the SUBMIT event; the form is APPROVED with its voucher ADJ:{adjust_id} written in the
//   same transaction (the rollback of a failing form insert is pinned by B2-12c's own rule tests).
// - A refused transition writes nothing: the state machine refusing SUBMIT; through the real entry,
//   an APPROVED form taken to approve / reject (20902), a PENDING ACCOUNT_CLOSED form taken to the
//   manual submission path (reversal → reverse_not_allowed; a new form for the member in deletion →
//   adjust_user_deleted): no form added or changed, no voucher, no balance move.
// - The prefill's system audit: actor system:ledger, action adjustment_prefill, exactly one per
//   landed insert (the rebuild after a rejection included); none when the insert is skipped on the
//   partial unique key (a PENDING form of another writer committed while the insert waited).
// The state machine is the real generated function, observed by a pass-through recorder that can be
// told to refuse one event; everything else is the real admin and worker entries on the real
// database. The skeleton of this task is never imported. Amounts by hand in each test.
import { randomUUID } from 'node:crypto';
import type { AdminAdjustmentEvent, AdminAdjustmentState } from '@couli/domain';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import type * as AdjustmentMachine from '../../../../packages/domain/src/state-machines/admin-adjustment.gen.ts';
import {
  expectAdjusted,
  newForm,
  type AdminSent as CreateSent,
  type AuditRow,
  type Expectation,
} from '../admin-adjustments/kit.ts';
import {
  ADJUST,
  ADJUSTMENT_PENDING,
  DAY_MS,
  TIMEOUT,
  adjustVouchers,
  answer,
  audits,
  conflict,
  conforms,
  expectApproveAudit,
  expectApproved,
  expectMentions,
  expectPrefilled,
  fixture,
  formNow,
  formsOf,
  invalid,
  markCleaned,
  member,
  moneyOf,
  pendingClosing,
  requestNow,
  seedPrefill,
  seedRequest,
  settleOpenDeletions,
  suite,
  trace,
  userStatusOf,
  withClosingAdmin,
  withDeletionWorker,
  type AdjustFixture,
  type AdminSent,
  type FormRow,
} from './kit.ts';
import { settledFlag, until, waitersOn } from './kit-r2.ts';

const machine = vi.hoisted(() => ({
  calls: [] as { from: string | null; event: string }[],
  /** An event the recorder refuses (as the table would for an illegal move); null passes all. */
  refuse: null as string | null,
}));

vi.mock(
  '../../../../packages/domain/src/state-machines/admin-adjustment.gen.ts',
  async (importOriginal) => {
    const actual = await importOriginal<typeof AdjustmentMachine>();
    return {
      ...actual,
      transitionAdminAdjustment(
        from: AdminAdjustmentState | null,
        event: AdminAdjustmentEvent,
      ): ReturnType<typeof actual.transitionAdminAdjustment> {
        machine.calls.push({ from, event });
        if (machine.refuse === event) return { ok: false, reason: 'illegal', id: null };
        return actual.transitionAdminAdjustment(from, event);
      },
    };
  },
);

const s = suite();

/** The system audit of the prefill (BR-FUND-24 ①⑧). */
const PREFILL_ACTION = 'adjustment_prefill';
const SYSTEM_LEDGER = 'system:ledger';
const NOTE = '客服处理说明：企业微信沟通确认重复领取活动奖励，核实后调减';
const REASON = '核对后金额有误，次日按补建的新单处理';

/** A manual OTHER decrease (B2-12c), contra MKT_EXPENSE, no refs. */
function otherDecrease(userId: string, amount: bigint): Record<string, unknown> {
  return newForm({
    userId,
    direction: 'decrease',
    amount,
    reason: 'OTHER',
    note: NOTE,
    contra: 'MKT_EXPENSE',
  });
}

function otherExpectation(
  caller: Expectation['caller'],
  userId: string,
  amount: bigint,
  available: bigint,
): Expectation {
  return {
    caller,
    userId,
    direction: 'decrease',
    amount,
    reason: 'OTHER',
    contra: 'MKT_EXPENSE',
    refs: [],
    note: NOTE,
    before: { available, frozen: 0n },
  };
}

/** The closing kit's answer of POST /admin/v1/adjustments as B2-12c's kit reads it. */
function asCreate(sent: AdminSent): CreateSent {
  expect(sent.op).toBe('create');
  return { op: 'create', statusCode: sent.statusCode, body: sent.body, json: () => sent.json() };
}

/** One adjustment_prefill record: by system:ledger (no admin) at `at`, naming form, member, request. */
function expectPrefillAudit(
  row: AuditRow | undefined,
  e: {
    readonly form: FormRow;
    readonly userId: string;
    readonly requestId: string;
    readonly at: Date;
  },
): void {
  expect(row, `an ${PREFILL_ACTION} record for ${e.form.adjust_id}`).toBeDefined();
  expect({
    action: row!.action,
    admin_id: row!.admin_id,
    system_actor: row!.system_actor,
    at: row!.at,
  }).toEqual({ action: PREFILL_ACTION, admin_id: null, system_actor: SYSTEM_LEDGER, at: e.at });
  expectMentions(row!, { ids: [e.form.adjust_id, e.userId, e.requestId], values: [] });
}

/**
 * On the suite's second pool: inserts a PENDING ACCOUNT_CLOSED form of the member (as another
 * writer would) and holds the transaction open until commit().
 */
async function holdPendingForm(
  f: AdjustFixture,
  userId: string,
  requestId: string,
): Promise<{ readonly pid: number; readonly adjustId: string; commit(): Promise<void> }> {
  const adjustId = randomUUID();
  let gotPid!: (pid: number) => void;
  const pidReady = new Promise<number>((resolve) => {
    gotPid = resolve;
  });
  let opened!: () => void;
  const gate = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      await trx
        .withSchema('app')
        .insertInto('admin_adjustments')
        .values({
          adjust_id: adjustId,
          app_id: f.appId,
          user_id: userId,
          direction: 'decrease',
          amount_fen: null,
          reason_code: 'ACCOUNT_CLOSED',
          refs: JSON.stringify([{ ref_type: 'account_deletion', ref_id: requestId }]),
          contra_subject: 'COMMISSION_REVENUE',
          contra_platform: null,
          note: null,
          status: 'PENDING',
          reverses_adjust_id: null,
          created_by: null,
          created_at: new Date(f.clock.now().getTime() - 3_600_000),
          reviewed_by: null,
          reviewed_at: null,
          reject_note: null,
          voucher_id: null,
        })
        .execute();
      const pid = rows[0]?.pid;
      if (typeof pid !== 'number') throw new Error('fixture: no backend pid');
      gotPid(pid);
      await gate;
    });
  done.catch(() => undefined);
  const pid = await Promise.race([
    pidReady,
    done.then(
      () => -1,
      () => -1,
    ),
  ]);
  if (pid < 0) throw new Error('fixture: the holder finished before it held the PENDING form');
  return {
    pid,
    adjustId,
    async commit() {
      opened();
      await done;
    },
  };
}

it(
  '[AC-B2-12d#31] B2-12c 一步提交（adminCreateAdjustment）经状态机 transitionAdminAdjustment 的 SUBMIT 事件（自无行起）写单：单为 APPROVED，发起人与批准人都是调用者，凭证 ADJ:{adjust_id} 就是单上的 voucher_id；提交只走 SUBMIT，不走 PREFILL / APPROVE / REJECT',
  async () => {
    const f = fixture(s);
    const userId = await member(f, { available: 3000n });
    await withClosingAdmin(f, async (h) => {
      machine.calls.length = 0;
      const sent = await h.create(otherDecrease(userId, 200n));
      const calls = [...machine.calls];
      const done = await expectAdjusted(
        f,
        asCreate(sent),
        otherExpectation(h.maker, userId, 200n, 3000n),
      );
      expect(calls, 'the submission asks the state machine for SUBMIT from no row').toContainEqual({
        from: null,
        event: 'SUBMIT',
      });
      expect(
        calls.filter((call) => call.event !== 'SUBMIT'),
        'a manual submission is no PREFILL, APPROVE or REJECT',
      ).toEqual([]);
      expect(done.row.status).toBe('APPROVED');
      expect((await adjustVouchers(f)).map((voucher) => [voucher.uniq_key, voucher.id])).toEqual([
        [`ADJ:${done.row.adjust_id}`, done.row.voucher_id],
      ]);
      expect(await formsOf(f, userId)).toEqual([done.row]);
      expect(await moneyOf(f, userId)).toEqual({ available: 2800n, frozen: 0n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#33] 状态机拒绝 SUBMIT 时一步提交不落库：不新增单、不写凭证与分录、余额与审计不动（应答非成功）；状态机恢复后同样的提交恰好生效一次',
  async () => {
    const f = fixture(s);
    const userId = await member(f, { available: 3000n });
    await withClosingAdmin(f, async (h) => {
      const before = await trace(f);
      const auditsBefore = await audits(f);
      machine.calls.length = 0;
      machine.refuse = 'SUBMIT';
      const refused = await h.create(otherDecrease(userId, 200n)).finally(() => {
        machine.refuse = null;
      });
      expect(machine.calls, 'the submission asked the state machine').toContainEqual({
        from: null,
        event: 'SUBMIT',
      });
      expect(refused.statusCode, refused.body).not.toBe(200);
      expect(refused.json().code, refused.body).not.toBe(0);
      await conforms(refused);
      expect(await trace(f), 'a refused transition writes nothing').toEqual(before);
      expect(await audits(f)).toEqual(auditsBefore);
      expect(await formsOf(f, userId)).toEqual([]);
      expect(await adjustVouchers(f)).toEqual([]);
      expect(await moneyOf(f, userId)).toEqual({ available: 3000n, frozen: 0n });

      const done = await expectAdjusted(
        f,
        asCreate(await h.create(otherDecrease(userId, 200n))),
        otherExpectation(h.maker, userId, 200n, 3000n),
      );
      expect(await formsOf(f, userId)).toEqual([done.row]);
      expect(await adjustVouchers(f)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#34] 真实入口上不合法的迁移不落库：一步提交生成的 APPROVED 单再批准、再驳回 → 20902；注销中会员的 PENDING ACCOUNT_CLOSED 单走人工提交路径（红冲它 → reverse_not_allowed；给该会员提新单 → adjust_user_deleted）→ 20001；都不新增也不改单、不写凭证、余额与审计不动；该预填单之后照常批准（1200 → 0）',
  async () => {
    const f = fixture(s);
    const normal = await member(f, { available: 3000n });
    const leaving = await member(f, { available: 1200n, status: 'deleting' });
    const request = await seedRequest(f, leaving);
    const prefilled = await seedPrefill(f, leaving, {
      refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
    });
    await withClosingAdmin(f, async (h) => {
      const submitted = await expectAdjusted(
        f,
        asCreate(await h.create(otherDecrease(normal, 200n))),
        otherExpectation(h.maker, normal, 200n, 3000n),
      );
      const before = await trace(f);
      const auditsBefore = await audits(f);

      await conflict(await h.approve(submitted.row.adjust_id));
      await conflict(await h.reject(submitted.row.adjust_id, { reason: REASON }));
      await invalid(
        await h.create({ reverses_adjust_id: prefilled.adjust_id, note: '冲回待批的预填单' }),
        ['reverses_adjust_id'],
        'reverse_not_allowed',
      );
      await invalid(
        await h.create(otherDecrease(leaving, 300n)),
        ['user_id'],
        'adjust_user_deleted',
      );

      expect(await trace(f), 'no form, voucher, entry, balance, event or message').toEqual(before);
      expect(await audits(f)).toEqual(auditsBefore);
      expect(await formNow(f, submitted.row.adjust_id)).toEqual(submitted.row);
      expect(await formNow(f, prefilled.adjust_id)).toEqual(prefilled);
      expect(await formsOf(f, leaving)).toEqual([prefilled]);
      expect(await moneyOf(f, normal)).toEqual({ available: 2800n, frozen: 0n });
      expect(await moneyOf(f, leaving)).toEqual({ available: 1200n, frozen: 0n });

      await expectApproved(f, await h.approve(prefilled.adjust_id), {
        caller: h.maker,
        form: prefilled,
        amount: 1200n,
      });
      await expectApproveAudit(f, { caller: h.maker, form: prefilled, amount: 1200n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#35] 预填写系统审计：进 processing 时插入的预填单恰好 1 条 adjustment_prefill（system:ledger、无 admin_id、时刻为预填时刻，带单、会员与注销单）；余额 0 不生成也不写；单待批期间的轮次不再写；驳回当日不补建不写，次日补建再写 1 条（指向新单），同日再跑不重复',
  async () => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    const rich = await member(f, { available: 2000n });
    const poor = await member(f);
    const richRequest = await seedRequest(f, rich, 'cooling');
    const poorRequest = await seedRequest(f, poor, 'cooling');
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(f, async (w) => {
        // 2026-11-30 10:30 +08:00: both enter processing; only the rich member gets a form.
        await w.round();
        const entered = f.clock.now();
        const forms = await formsOf(f, rich);
        expect(forms).toHaveLength(1);
        const first = expectPrefilled(f, forms[0], {
          userId: rich,
          requestId: richRequest.id,
          at: entered,
        });
        expect(await formsOf(f, poor)).toEqual([]);
        let records = await audits(f, PREFILL_ACTION);
        expect(records, 'one record for the one landed insert').toHaveLength(1);
        expectPrefillAudit(records[0], {
          form: first,
          userId: rich,
          requestId: richRequest.id,
          at: entered,
        });

        // 11:30: the form is PENDING → no second insert, no second record; the poor one completes.
        await markCleaned(f, richRequest.id);
        await markCleaned(f, poorRequest.id);
        f.clock.advanceMs(3_600_000);
        await w.round();
        expect((await requestNow(f, poorRequest.id)).status).toBe('done');
        expect(await userStatusOf(f, poor)).toBe('deleted');
        expect(await formsOf(f, rich)).toEqual([first]);
        expect(await audits(f, PREFILL_ACTION)).toEqual(records);

        // Rejected on 11-30: the same day gets no rebuild and no record. h.maker's session is past
        // its idle limit after the hour above: a fresh fund.adjust session rejects.
        const rejecter = await h.caller([ADJUST]);
        await answer(await h.reject(first.adjust_id, { reason: REASON }, { caller: rejecter }), 0);
        f.clock.advanceMs(60_000);
        await w.round();
        expect(await pendingClosing(f, rich)).toEqual([]);
        expect(await audits(f, PREFILL_ACTION)).toEqual(records);
        expect(w.warnings(ADJUSTMENT_PENDING, richRequest.id).length).toBeGreaterThanOrEqual(1);

        // 2026-12-01: the rebuild lands and writes its own record.
        f.clock.advanceMs(DAY_MS);
        await w.round();
        const rebuiltAt = f.clock.now();
        const pending = await pendingClosing(f, rich);
        expect(pending).toHaveLength(1);
        const rebuilt = expectPrefilled(f, pending[0], {
          userId: rich,
          requestId: richRequest.id,
          at: rebuiltAt,
        });
        records = await audits(f, PREFILL_ACTION);
        expect(records).toHaveLength(2);
        expectPrefillAudit(records[0], {
          form: first,
          userId: rich,
          requestId: richRequest.id,
          at: entered,
        });
        expectPrefillAudit(records[1], {
          form: rebuilt,
          userId: rich,
          requestId: richRequest.id,
          at: rebuiltAt,
        });
        expect(
          records.filter((row) =>
            JSON.stringify([row.target, row.before, row.after]).includes(poor),
          ),
          'no record names the member with balance 0',
        ).toEqual([]);

        f.clock.advanceMs(3_600_000);
        await w.round();
        expect(await formsOf(f, rich)).toHaveLength(2);
        expect(await audits(f, PREFILL_ACTION)).toEqual(records);
        expect(await moneyOf(f, rich)).toEqual({ available: 2000n, frozen: 0n });
        expect(await adjustVouchers(f)).toEqual([]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#36] 预填因部分唯一键冲突跳过时不写审计：处理轮次的预填插入等在另一写者未提交的 PENDING ACCOUNT_CLOSED 单上（pg_blocking_pids 认等待），对方提交后跳过 → 仍只有那一张单、没有 adjustment_prefill，注销停在 processing 并告警；次日轮次（单仍待批）也不写',
  async () => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    const userId = await member(f, { available: 900n, status: 'deleting' });
    const request = await seedRequest(f, userId);
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(f, async (w) => {
        const held = await holdPendingForm(f, userId, request.id);
        let round: Promise<void> | undefined;
        try {
          round = w.round();
          const finished = settledFlag(round);
          await until(
            async () => (await waitersOn(f, held.pid)) >= 1,
            finished,
            "the round's prefill insert waits on the uncommitted PENDING form",
          );
        } finally {
          await held.commit();
        }
        await round;
        const forms = await formsOf(f, userId);
        expect(
          forms.map((row) => row.adjust_id),
          'the skipped insert adds no form',
        ).toEqual([held.adjustId]);
        const other = forms[0]!;
        expect(other).toMatchObject({ status: 'PENDING', amount_fen: null, created_by: null });
        expect(await audits(f, PREFILL_ACTION), 'a skipped insert writes no record').toEqual([]);
        expect((await requestNow(f, request.id)).status).toBe('processing');
        expect(await userStatusOf(f, userId)).toBe('deleting');
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(1);
        expect(await moneyOf(f, userId)).toEqual({ available: 900n, frozen: 0n });

        f.clock.advanceMs(DAY_MS);
        await w.round();
        expect(await formsOf(f, userId)).toEqual([other]);
        expect(await audits(f, PREFILL_ACTION)).toEqual([]);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(2);

        // The form the other writer committed is an ordinary prefilled form: it approves.
        const approver = await h.caller([ADJUST]);
        await expectApproved(f, await h.approve(other.adjust_id, { caller: approver }), {
          caller: approver,
          form: other,
          amount: 900n,
        });
      });
    });
  },
  TIMEOUT,
);
