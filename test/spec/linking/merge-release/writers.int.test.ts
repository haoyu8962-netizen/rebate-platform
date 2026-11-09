// B1-20c: the bindings around a merge, through the real taobao authorization submission (B1-06h,
// POST /v1/unions/taobao/bindings; real AppModule over PG and Redis, the upstream exchange faked by
// the bindings kit).
// - 规划/08 BR-ID-06「不冷却」: once releaseForMerge released the source's binding at the merge
//   instant, the phone account authorising the same taobao account gets the same relation id at
//   once (no 30151 cooling conflict).
// - D10-1099 T-7: a writer that takes the bindings' user lock (binding-lock.ts) after the merge
//   committed never writes an active binding for the tombstone (users.status = deleted): here the
//   merge commits while the submission's upstream exchange is in flight, after every earlier check
//   let the submission through.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { releaseForMerge } from '../../../../apps/api/src/modules/linking/index.ts';
import { accepted } from '../bindings/assertions.ts';
import { client, web } from '../bindings/client.ts';
import { RELATION, suite, type Fixture } from '../bindings/kit.ts';
import { binding, bindings, scenario, state } from '../bindings/records.ts';

const use = suite(createTestDatabase, acquireTestRedis);

/** The merge of `userId` commits now: the account becomes a tombstone. */
function tombstone(f: Fixture, appId: string, userId: string) {
  return sql`UPDATE app.users SET status = 'deleted', deleted_reason = 'merged'
    WHERE app_id = ${appId} AND id = ${userId}`.execute(f.db);
}

it('[AC-B1-20c#43] 源的淘宝绑定在并号时释放（不冷却）→ 手机号账号随即授权同一淘宝账号，拿回同一 relation_id', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const merged = await client(f, { appId: c.appId });
  const original = await binding(f, merged, accountId);
  const at = f.clock.now();
  await f.db
    .transaction()
    .execute((trx) => releaseForMerge(trx, { appId: c.appId, userId: merged.uid, at }));
  const s = await state(f, c);

  await accepted(await c.post(web(s.state)));

  const rows = await bindings(f, c);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === original.id)).toMatchObject({
    user_id: merged.uid,
    status: 'released',
    released_at: at,
    cooldown_until: at,
    relation_id: RELATION,
  });
  expect(rows.find((row) => row.id !== original.id)).toMatchObject({
    user_id: c.uid,
    union_account_id: accountId,
    relation_id: RELATION,
    status: 'active',
    bound_at: at,
  });
});

it('[AC-B1-20c#44] T-7 授权换取途中账号被并号置墓碑 → 不为墓碑写出 active 绑定（新行回滚）', async () => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c);
  f.exchange.mockImplementationOnce(async () => {
    await tombstone(f, c.appId, c.uid);
    return { kind: 'bound', relationId: RELATION };
  });

  const response = await c.post(web(s.state));

  expect(response.statusCode).not.toBe(200);
  expect(response.json<{ code: number }>().code).not.toBe(0);
  expect(f.exchange).toHaveBeenCalledOnce();
  expect((await bindings(f, c)).filter((row) => row.user_id === c.uid)).toEqual([]);
});

it('[AC-B1-20c#45] T-7 墓碑的 invalid 绑定在授权换取途中不会被改回 active（行原样）', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const invalid = await binding(f, c, accountId, { status: 'invalid' });
  const s = await state(f, c);
  f.exchange.mockImplementationOnce(async () => {
    await tombstone(f, c.appId, c.uid);
    return { kind: 'bound', relationId: RELATION };
  });

  const response = await c.post(web(s.state));

  expect(response.statusCode).not.toBe(200);
  expect(response.json<{ code: number }>().code).not.toBe(0);
  expect(await bindings(f, c)).toEqual([invalid]);
});
