import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { useHarness } from '../auth/kit.ts';
import {
  append,
  detail,
  FROM,
  grant,
  LIST,
  page,
  rejected,
  seed,
  setup,
  signedIn,
  TO,
  type Setup,
} from '../audit-query/kit.ts';
import {
  appendHold,
  AUTO_HOLD,
  expectHoldSnapshot,
  singleBound,
  SYSTEM_RISK,
  SYSTEM_RISK_NAME,
  UNMAPPED,
} from './kit.ts';

// Contract CT-24zj (adminListAuditLogs, adminGetAuditLog), task §9 items 4 and 5. System rows are
// written by the real adapter and read back through the real admin entry over HTTP; the audit
// query kit validates every response against the contract.
const h = useHarness();
const WINDOW = { from: FROM, to: TO };
const AT = '2026-10-08T03:00:00.000Z';
const EMPTY = { items: [], page: 1, page_size: 20, total: 0 };

const systemRow = (f: Setup) => appendHold(singleBound(h.db), new FixedClock(AT), f.appId);

function systemItem(orderId: string) {
  return {
    id: expect.any(String),
    actor_id: null,
    actor_kind: 'system',
    system_actor: SYSTEM_RISK,
    actor_name: SYSTEM_RISK_NAME,
    action: AUTO_HOLD,
    target_type: 'order',
    target_id: orderId,
    permission: null,
    ip: null,
    at: AT,
  };
}

/** Exactly what an admin row read before this task: no actor_kind, no system_actor. */
function accountItem(f: Setup) {
  return {
    id: expect.any(String),
    actor_id: f.actor.id,
    actor_name: f.actor.username,
    action: 'admin.login',
    target_type: 'admin_user',
    target_id: f.actor.id,
    permission: null,
    ip: '192.0.2.23',
    at: FROM,
  };
}

it('[AC-B1-34p#4] 列表：系统行 actor_id 空、actor_kind system、system_actor、中文名；后台账号行逐字段不变', async () => {
  const f = await setup(h);
  const orderId = await systemRow(f);
  await append(h, f.actor);
  const result = await page(f);
  expect(result.total).toBe(2);
  expect(result.items).toEqual([systemItem(orderId), accountItem(f)]);
  expect(result.items[1]).not.toHaveProperty('actor_kind');
  expect(result.items[1]).not.toHaveProperty('system_actor');
});

it('[AC-B1-34p#4] 详情：系统行与列表同形并带 before/after；后台账号行不带系统字段', async () => {
  const f = await setup(h);
  const orderId = await systemRow(f);
  await append(h, f.actor);
  const [system, account] = (await page(f)).items;
  const { before, after, ...listed } = await detail(f, system!.id);
  expect(listed).toEqual(systemItem(orderId));
  expect(listed.id).toBe(system!.id);
  expectHoldSnapshot(before, false, null);
  expectHoldSnapshot(after, true, UNMAPPED);
  const accountDetail = await detail(f, account!.id);
  expect(accountDetail).toEqual({ ...accountItem(f), before: null, after: null });
  expect(accountDetail).not.toHaveProperty('actor_kind');
  expect(accountDetail).not.toHaveProperty('system_actor');
});

it('[AC-B1-34p#5] 系统行不匹配任何 actor_id 过滤，target 过滤照常命中，permission 过滤不命中', async () => {
  const f = await setup(h);
  const orderId = await systemRow(f);
  await append(h, f.actor);
  expect((await page(f)).total).toBe(2);
  expect(await page(f, { ...WINDOW, actor_id: f.actor.id })).toMatchObject({
    total: 1,
    items: [accountItem(f)],
  });
  expect(await page(f, { ...WINDOW, actor_id: randomUUID() })).toEqual(EMPTY);
  for (const filter of [{ target_type: 'order' }, { target_id: orderId }]) {
    expect(await page(f, { ...WINDOW, ...filter })).toMatchObject({
      total: 1,
      items: [systemItem(orderId)],
    });
  }
  expect(await page(f, { ...WINDOW, permission: 'order.hold' })).toEqual(EMPTY);
});

it('[AC-B1-34p#5] 没有 audit.view_all：列表与计数都没有系统行，详情 20001 [id]', async () => {
  const f = await setup(h);
  const ordinary = await seed(h, f.appId);
  await grant(h, ordinary, f.actor, ['risk.ban']);
  const own = { ...f, token: (await signedIn(f, ordinary)).admin_token };
  const orderId = await systemRow(f);
  await append(h, ordinary);
  const visible = await page(own);
  expect(visible.total).toBe(1);
  expect(visible.items.map((item) => item.actor_id)).toEqual([ordinary.id]);
  expect(await page(own, { ...WINDOW, target_id: orderId })).toEqual(EMPTY);
  const system = (await page(f)).items.find((item) => item.target_id === orderId);
  expect(system).toBeDefined();
  await rejected(await own.read(own.token, `${LIST}/${system!.id}`), ['id'], true);
});

it('[AC-B1-34p#5] 勾选 audit.view_all 的账号看得到系统行与详情', async () => {
  const f = await setup(h);
  const viewer = await seed(h, f.appId);
  await grant(h, viewer, f.actor, ['audit.view_all']);
  const view = { ...f, token: (await signedIn(f, viewer)).admin_token };
  const orderId = await systemRow(f);
  const result = await page(view);
  expect(result.items).toEqual([systemItem(orderId)]);
  expect(await detail(view, result.items[0]!.id)).toMatchObject(systemItem(orderId));
});

it('[AC-B1-34p#5] 系统行不跨 app：他 app 超管的列表与详情都看不到', async () => {
  const f = await setup(h);
  const foreign = await seed(h, `other-${randomUUID()}`, { isSuper: true });
  const other = { ...f, token: (await signedIn(f, foreign)).admin_token };
  const orderId = await systemRow(f);
  const system = (await page(f)).items[0]!;
  expect(system).toMatchObject({ target_id: orderId });
  expect(await page(other)).toEqual(EMPTY);
  await rejected(await other.read(other.token, `${LIST}/${system.id}`), ['id'], true);
});
