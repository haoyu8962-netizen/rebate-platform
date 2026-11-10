// B1-06zm: the user's Taobao authorization (POST /v1/unions/taobao/bindings; union-bindings.ts;
// BR-ID-19, BR-ID-21) judges every status it writes through the generated union-binding
// transition(): a new row is U1 (no row + ACTIVATE), the user's own cooling row restored is U5
// (released + ACTIVATE), re-authorization with the same relation id is U4 (invalid + ACTIVATE).
// With the real table the answer and the rows are as before; with that step refused by the gate
// the submission answers 50001 (as for any illegal change, never written) and no binding row is
// inserted or changed (row_version included). Only the orchestrator runs this file.
//
// Second attempt (Codex spec-test r1 S1): one user, two devices, two valid states, the exchanges
// give different relation ids R1 / R2 and both submissions are held at their INSERT (SHARE lock on
// union_bindings) so each passed its first read seeing no binding. The one that commits first
// keeps its active row; the other loses the (app, user, platform) unique race, reads again, finds
// the user's own unreleased binding with another relation id and answers 30151 (BR-ID-19, 细则
// 「并发绑定」) with one conflict row (kind rebind), the winner's row unchanged. A writer that takes
// "the user's own binding found on the re-read" as success answers 200 twice and fails here.
import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import * as domain from '@couli/domain';
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { accepted, rejected, validate } from '../bindings/assertions.ts';
import { client, web } from '../bindings/client.ts';
import { RELATION, suite, type Fixture } from '../bindings/kit.ts';
import { binding, bindings, scenario, state, states } from '../bindings/records.ts';
import { asked, edge } from './kit.ts';

const gate = vi.hoisted(() => ({
  deny: new Set<string>(),
  table: null as ReadonlySet<string> | null,
}));

vi.mock('@couli/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@couli/domain')>();
  const { gatedTransition } = await import('./kit.ts');
  return {
    ...actual,
    transitionUnionBinding: vi.fn(gatedTransition(gate, actual.transitionUnionBinding)),
  };
});

const transition = vi.mocked(domain.transitionUnionBinding);
const use = suite(createTestDatabase, acquireTestRedis);

beforeEach(() => {
  gate.deny.clear();
  transition.mockClear();
});

afterEach(() => {
  gate.deny.clear();
});

const CASES = [
  { name: '无绑定行 → 新建 active', seed: null, step: edge(null, 'ACTIVATE') },
  {
    name: '本人冷却中 released → 原行恢复 active',
    seed: 'released',
    step: edge('released', 'ACTIVATE'),
  },
  {
    name: '本人 invalid 同 R → 原行回到 active',
    seed: 'invalid',
    step: edge('invalid', 'ACTIVATE'),
  },
] as const;

it.each(CASES)(
  '[AC-B1-06zm#15] 用户授权 $name：写入前问生成的 transition()（$step），应答与绑定照旧',
  async ({ seed, step }) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const original = seed === null ? null : await binding(f, c, accountId, { status: seed });
    const s = await state(f, c);

    await accepted(await c.post(web(s.state)));

    expect(asked(transition)).toContain(step);
    const rows = await bindings(f, c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: c.uid,
      union_account_id: accountId,
      relation_id: RELATION,
      status: 'active',
      released_at: null,
      cooldown_until: null,
      blocked_reason: null,
    });
    if (original === null) expect(rows[0]?.bound_at).toEqual(f.clock.now());
    else expect(rows[0]).toMatchObject({ id: original.id, bound_at: original.bound_at });
  },
);

it.each(CASES)(
  '[AC-B1-06zm#16] 用户授权 $name：生成物拒绝 $step 时 50001，不新增、不改任何绑定行（row_version 不变）',
  async ({ seed, step }) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    if (seed !== null) await binding(f, c, accountId, { status: seed });
    // Another user's row of the same App stays untouched as well.
    const neighbour = await client(f, { appId: c.appId });
    await binding(f, neighbour, accountId, { relation_id: 'synthetic-neighbour-R' });
    const before = await bindings(f, c);
    const s = await state(f, c);
    gate.deny.add(step);

    const response = await c.post(web(s.state));

    expect(asked(transition)).toContain(step);
    expect(response.statusCode).toBe(500);
    await validate(response.json(), 'ErrorEnvelope');
    expect(response.json<{ code: number }>().code).toBe(50001);
    expect(await bindings(f, c)).toEqual(before);
  },
);

/** Two submissions waiting for their INSERT on union_bindings (polled, never timed). */
async function waitForInsertWaiters(f: Fixture, signal: AbortSignal): Promise<boolean> {
  while (!signal.aborted) {
    const result = await sql<{ waiting: number }>`
      SELECT count(DISTINCT pid)::int AS waiting
      FROM pg_locks
      WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND relation = 'app.union_bindings'::regclass
        AND mode = 'RowExclusiveLock'
        AND NOT granted
    `.execute(f.db);
    if (result.rows[0]?.waiting === 2) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

const R1 = 'synthetic-relation-device-one';
const R2 = 'synthetic-relation-device-two';

it('[AC-B1-06zm#17] 同一用户两台设备并发授权分别换得 R1、R2：先提交者 active，后提交者重读见本人不同 relation_id → 30151，先者绑定不变、写 rebind 冲突日志', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const second = await client(f, { appId: c.appId, uid: c.uid });
  const devices = [
    { who: c, state: (await state(f, c)).state, code: 'synthetic-code-one', relation: R1 },
    {
      who: second,
      state: (await state(f, second)).state,
      code: 'synthetic-code-two',
      relation: R2,
    },
  ];
  const issued = await states(f, c);
  const bothExchanges = Promise.withResolvers<void>();
  const releaseExchange = Promise.withResolvers<void>();
  let arrivals = 0;
  f.exchange.mockImplementation(async ({ credential }) => {
    arrivals += 1;
    if (arrivals === 2) bothExchanges.resolve();
    await releaseExchange.promise;
    const code = 'code' in credential ? credential.code : null;
    const device = devices.find((d) => d.code === code);
    return device === undefined
      ? { kind: 'credential_invalid' }
      : { kind: 'bound', relationId: device.relation };
  });

  // SHARE lets both read (no binding yet) and holds both INSERTs: neither sees the other's row
  // before its own write, so the loser can only learn of the winner by reading again.
  const locked = Promise.withResolvers<void>();
  const unlock = Promise.withResolvers<void>();
  const lock = f.db.transaction().execute(async (trx) => {
    await sql`LOCK TABLE app.union_bindings IN SHARE MODE`.execute(trx);
    locked.resolve();
    await unlock.promise;
  });
  await Promise.race([locked.promise, lock]);
  const requests = devices.map((d) => d.who.post(web(d.state, d.code), { key: randomUUID() }));
  const deadline = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => deadline.resolve(false), 5000);
  const stop = new AbortController();
  const prematureResponse = Promise.race(requests).then(() => false);
  let exchanged = false;
  let waiting = false;
  let observation: Promise<boolean> | undefined;
  try {
    exchanged = await Promise.race([
      bothExchanges.promise.then(() => true),
      prematureResponse,
      deadline.promise,
    ]);
    if (exchanged) {
      releaseExchange.resolve();
      observation = waitForInsertWaiters(f, stop.signal);
      waiting = await Promise.race([observation, prematureResponse, deadline.promise]);
    }
  } finally {
    clearTimeout(timer);
    stop.abort();
    releaseExchange.resolve();
    unlock.resolve();
    await lock;
    await observation;
    await Promise.allSettled(requests);
  }

  expect(exchanged, '两个独立 state 都必须进入换凭证端口').toBe(true);
  expect(waiting, '放行前两个 INSERT 均须等待数据库锁，确保后者走到并发重读').toBe(true);
  const responses = await Promise.all(requests);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 422]);
  const won = responses.findIndex((response) => response.statusCode === 200);
  const winner = devices[won]!;
  await accepted(responses[won]!);
  await rejected(responses[1 - won]!, 30151);
  for (const response of responses) {
    expect(response.payload).not.toContain(R1);
    expect(response.payload).not.toContain(R2);
  }

  // The winner's binding is the only row, as it wrote it; the loser's R is nowhere.
  expect(await bindings(f, c)).toEqual([
    expect.objectContaining({
      app_id: c.appId,
      user_id: c.uid,
      platform: 'taobao',
      union_account_id: accountId,
      relation_id: winner.relation,
      status: 'active',
      bound_at: f.clock.now(),
      released_at: null,
      cooldown_until: null,
      blocked_reason: null,
    }),
  ]);
  // One conflict row for the refused submission (kind rebind), already resolved because the
  // user has the active binding by then (../infra/binding-conflicts.ts).
  const logged = await f.db
    .selectFrom('union_binding_conflicts')
    .selectAll()
    .where('app_id', '=', c.appId)
    .execute();
  expect(logged).toEqual([
    expect.objectContaining({
      user_id: c.uid,
      platform: 'taobao',
      union_account_id: accountId,
      kind: 'rebind',
      occurred_at: f.clock.now(),
      resolved_at: f.clock.now(),
      resolution: 'already_active',
    }),
  ]);
  expect(await states(f, c)).toEqual(issued.map((row) => ({ ...row, used_at: f.clock.now() })));
  expect(f.exchange).toHaveBeenCalledTimes(2);
  // The new row was judged by the generated transition() (U1: no row + ACTIVATE).
  expect(asked(transition)).toContain(edge(null, 'ACTIVATE'));
}, 20_000);
