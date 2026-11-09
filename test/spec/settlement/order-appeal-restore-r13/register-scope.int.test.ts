// B2-09gg rule tests, what an order appeal may reach (claude-independent, SPEC_REF 03383a10): tenancy of
// the appeal entry (contracts/openapi.yaml adminRegisterAppeal: 20001 data.fields=[target_id]) and
// 08 BR-ID-36 / BR-FUND-22 申诉恢复 (OPS-07: an order appeal never changes the account's risk state), both
// on the D10-1180 scope. Orders reach CLAWED_BACK through the real credit and the real blacklist
// confirmation; registration and resolution go through the real console, the event through the worker's
// consumer. Synthetic, written here: the owner's user_risk_state row, set after the clawback so that it
// is a state held for another reason. test/spec is add-only, so these live in their own file.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  app,
  appealDiffs,
  clawedOrder,
  deliverLogged,
  everything,
  loggedResolutions,
  refId,
  suite,
  withConsole,
  withConsoleAndWorker,
  type App,
  type ConsoleEntry,
  type Sent,
  type Worker,
} from './kit.ts';

const s = suite();

const DAY_MS = 86_400_000;
const RISK_REASON = '另案账号安全处置（合成）';
const RISK_CATEGORY = 'account_security';

type HeldState = 'banned' | 'frozen';
type Decision = 'revoked' | 'upheld';

const registration = (orderId: string) => ({
  target_type: 'order',
  target_id: orderId,
  content: '这笔订单是我本人正常购买的，请核查。',
  reason: '本人经企业微信联系客服，核对订单信息一致',
});

/** A 200 answer carrying the processing appeal of the order, owned by `ownerId`. */
function accepted(sent: Sent, orderId: string, ownerId: string): Record<string, unknown> {
  expect(sent.statusCode, sent.body).toBe(200);
  const data = sent.json().data as Record<string, unknown>;
  expect(data).toMatchObject({
    target_type: 'order',
    target_id: orderId,
    status: 'processing',
    source: 'admin',
    user: { user_id: ownerId },
  });
  return data;
}

/** 20001 data.fields=[target_id]. */
function refused(sent: Sent): void {
  expect(sent.statusCode, sent.body).toBe(400);
  const body = sent.json();
  expect(body.code, sent.body).toBe(20001);
  expect(body.data, sent.body).toEqual({ fields: ['target_id'] });
}

function appealsOf(a: App) {
  return a.f.db
    .selectFrom('appeals')
    .selectAll()
    .where('app_id', '=', a.h.appId)
    .orderBy('id')
    .execute();
}

function riskRow(a: App, userId: string) {
  return a.f.db
    .selectFrom('user_risk_state')
    .selectAll()
    .where('app_id', '=', a.h.appId)
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
}

/** The owner's account state, held for a reason that has nothing to do with the order. */
async function holdAccount(a: App, userId: string, state: HeldState): Promise<Date | null> {
  const now = a.h.clock.now();
  const frozenUntil = state === 'frozen' ? new Date(now.getTime() + 30 * DAY_MS) : null;
  await a.f.db
    .insertInto('user_risk_state')
    .values({
      user_id: userId,
      app_id: a.h.appId,
      state,
      reason: RISK_REASON,
      reason_category: RISK_CATEGORY,
      frozen_until: frozenUntil,
      changed_by: 'test',
      changed_at: now,
    })
    .execute();
  return frozenUntil;
}

/**
 * One order appeal of a clawed-back order whose owner is banned or frozen: registered, closed with
 * `decision` and its event delivered. The account's row is compared whole after each of the three.
 */
async function appealOnHeldAccount(
  a: App,
  admin: ConsoleEntry,
  worker: Worker,
  state: HeldState,
  decision: Decision,
): Promise<void> {
  const { order, entryId } = await clawedOrder(a, admin);
  const owner = order.user('self');
  const frozenUntil = await holdAccount(a, owner, state);
  const before = await riskRow(a, owner);
  expect(before).toMatchObject({
    state,
    reason: RISK_REASON,
    reason_category: RISK_CATEGORY,
    frozen_until: frozenUntil,
  });

  const appeal = accepted(await admin.register(registration(order.orderId)), order.orderId, owner);
  const appealId = appeal['appeal_id'] as string;
  expect(await riskRow(a, owner), `${state} after registering`).toEqual(before);
  expect((await appealsOf(a)).find((row) => row.id === appealId)).toMatchObject({
    target_type: 'order',
    status: 'processing',
    prev_risk_state: null,
  });

  const closed = await admin.resolve(appealId, {
    decision,
    note: '核实后结案',
    expected_row_version: 0,
  });
  expect(closed.statusCode, closed.body).toBe(200);
  expect(await riskRow(a, owner), `${state} after ${decision}`).toEqual(before);

  const logged = (await loggedResolutions(a)).find((row) => row.data['appeal_id'] === appealId);
  expect(logged, `appeal.resolved of ${appealId}`).toBeDefined();
  await deliverLogged(a, worker, logged!);
  expect(await riskRow(a, owner), `${state} after the event of ${decision}`).toEqual(before);

  const ref = refId(order, entryId);
  const diffs = (await appealDiffs(a.f)).filter((row) => row.ref_id === ref);
  expect(diffs, `differences of ${ref}`).toHaveLength(decision === 'revoked' ? 1 : 0);
}

it(
  '[AC-B2-09gg#13] 跨 app 隔离：两个 app 各有一笔真实黑名单确认扣回的订单（sub_order_id 不同），一方的客服登记另一方的订单 → 20001 data.fields=[target_id]，两边的申诉、审计、订单、账务都不变；同样的两笔订单在各自 app 里受理（证明被拒是因为租户，不是因为订单不可申诉）',
  async () => {
    const a = await app(s);
    const b = await app(s);
    await withConsole(b, async (other) => {
      await withConsole(a, async (admin) => {
        const mine = await clawedOrder(a, admin);
        const foreign = await clawedOrder(b, other);
        expect(foreign.order.subOrderId).not.toBe(mine.order.subOrderId);
        const beforeA = await everything(a);
        const beforeB = await everything(b);

        refused(await other.register(registration(mine.order.orderId)));
        refused(await admin.register(registration(foreign.order.orderId)));

        expect(await everything(a)).toEqual(beforeA);
        expect(await everything(b)).toEqual(beforeB);
        expect(await appealsOf(a)).toEqual([]);
        expect(await appealsOf(b)).toEqual([]);

        accepted(
          await admin.register(registration(mine.order.orderId)),
          mine.order.orderId,
          mine.order.user('self'),
        );
        accepted(
          await other.register(registration(foreign.order.orderId)),
          foreign.order.orderId,
          foreign.order.user('self'),
        );
        expect((await appealsOf(a)).map((row) => row.target_id)).toEqual([mine.order.orderId]);
        expect((await appealsOf(b)).map((row) => row.target_id)).toEqual([foreign.order.orderId]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#14] 订单申诉不改账户风险状态（BR-ID-36、OPS-07）：所属用户因别的原因 banned，对真实黑名单扣回的订单登记、撤销结案、维持结案、事件投递之后 user_risk_state 整行原样（不变 appealing、撤销也不解封），appeals.prev_risk_state 为空；撤销照常登记差错单，维持不登记',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      await appealOnHeldAccount(a, admin, worker, 'banned', 'revoked');
      await appealOnHeldAccount(a, admin, worker, 'banned', 'upheld');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#15] 订单申诉不改账户风险状态（BR-ID-36、OPS-07）：所属用户因别的原因 frozen 且带 frozen_until，对真实黑名单扣回的订单登记、撤销结案、维持结案、事件投递之后 user_risk_state 整行原样（state、reason、frozen_until 都不变，撤销也不解冻），appeals.prev_risk_state 为空；撤销照常登记差错单，维持不登记',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      await appealOnHeldAccount(a, admin, worker, 'frozen', 'revoked');
      await appealOnHeldAccount(a, admin, worker, 'frozen', 'upheld');
    });
  },
  TIMEOUT,
);
