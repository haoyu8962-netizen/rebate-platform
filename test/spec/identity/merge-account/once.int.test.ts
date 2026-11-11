// B1-20c: a merge happens once (规划/08 BR-ID-06: merge_ticket 一次性; 细则「并号响应丢失」: the token
// check comes before the idempotent replay, so a retry with the same key finds the source session
// revoked → 10002; 细则「一个账号在同一个第三方平台只绑一个身份」与 10 AC-S1-130 ③: concurrent merges of
// the same provider into one account → at most one, the other 30411 and nothing of it written;
// D10-1099 Q-6 / B1-01zzs: the stored record of the key carries no access / refresh token).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, openKit, type Kit } from '../bind-phone/http-kit.ts';
import {
  MERGE_PATH,
  RESEND_GAP_MS,
  answer,
  idempotencyRowsContaining,
  merged,
  refused,
  revoked,
  scene,
  usable,
  type Envelope,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it('[AC-B1-20c#10] 响应丢失后同一幂等键重试 → 10002（源会话已吊销），不重做、不再签令牌', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  const key = randomUUID();
  merged(kit, await s.merge(ticket, { key }), s.target);
  const after = await s.snapshot();

  answer(kit, await s.merge(ticket, { key }), 10002);

  expect(await s.snapshot()).toEqual(after);
  expect(await s.rows.sessions(s.target)).toHaveLength(1);
});

it('[AC-B1-20c#11] 并号成功后换幂等键再用同一 ticket → 10002（源会话已吊销），什么都不写', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  merged(kit, await s.merge(ticket), s.target);
  const after = await s.snapshot();

  answer(kit, await s.merge(ticket), 10002);

  expect(await s.snapshot()).toEqual(after);
  await revoked(s, s.session.access_token);
});

it('[AC-B1-20c#12] D10-1099 Q-6 幂等存档里没有手机号账号的 access / refresh 令牌明文；存档的 data.tokens 为 null', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  const key = randomUUID();

  const tokens = merged(kit, await s.merge(ticket, { key }), s.target);

  expect(await idempotencyRowsContaining(kit.suite.db, tokens.access_token)).toBe(0);
  expect(await idempotencyRowsContaining(kit.suite.db, tokens.refresh_token)).toBe(0);
  const record = await s.db
    .selectFrom('idempotency_keys')
    .select(['status', 'response'])
    .where('app_id', '=', s.appId)
    .where('path', '=', MERGE_PATH)
    .where('key', '=', key)
    .executeTakeFirstOrThrow();
  expect(record.status).toBe('completed');
  const stored = record.response as unknown as { status: number; body: string };
  expect(stored.status).toBe(200);
  expect(JSON.parse(stored.body)).toMatchObject({
    code: 0,
    data: { user_id: s.target, is_new_user: false, tokens: null },
  });
});

it('[AC-B1-20c#13] 同一 ticket 两个幂等键同时确认 → 只成一笔；另一笔不成功，手机号账号只有一个并号会话', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();

  const responses = await Promise.all([s.merge(ticket), s.merge(ticket)]);

  const statuses = responses.map((response) => response.statusCode);
  expect(statuses.filter((status) => status === 200)).toHaveLength(1);
  const winner = responses.find((response) => response.statusCode === 200)!;
  merged(kit, winner, s.target);
  // The loser met either the consumed ticket (30411) or, arriving after the commit, the revoked
  // source session (10002); neither carries a merge offer. Meeting the winner's commit after
  // check ② but before check ⑥, the source account is already a tombstone, so the ⑥ deletion
  // check refuses it with 10007 (403, stage=processing) — BR-ID-01 check order, BR-ID-06, BR-ID-28.
  const loser = responses.find((response) => response !== winner)!;
  const body = loser.json<Envelope>();
  const msg = `loser ${String(loser.statusCode)} ${JSON.stringify(body)}`;
  expect([401, 403, 422], msg).toContain(loser.statusCode);
  expect([10002, 10007, 30411], msg).toContain(body.code);
  if (body.code === 10007) expect(body.data?.['stage'], msg).toBe('processing');
  expect(body.data?.['reason'], msg).toBeUndefined();
  expect(body.data?.['merge_ticket'], msg).toBeUndefined();
  expect(await s.rows.sessions(s.target)).toEqual([
    expect.objectContaining({ login_method: 'merge', revoked_at: null }),
  ]);
  expect(await s.rows.loginLogs(s.target)).toHaveLength(1);
  expect((await s.rows.oauth(s.target)).map((row) => row.id)).toEqual([s.sourceOauth]);
});

it('[AC-B1-20c#14] AC-S1-130 ③ 两个微信空号先后拿到并入同一账号的 ticket 再同时确认（20 轮）→ 每轮只成一笔，另一笔 30411、它的空号不置墓碑、令牌不吊销', async () => {
  for (let round = 0; round < 20; round += 1) {
    const first = await scene(kit, { provider: 'wechat' });
    const firstTicket = await first.offer();
    kit.clock.advanceMs(RESEND_GAP_MS);
    const second = await scene(kit, {
      provider: 'wechat',
      appId: first.appId,
      number: first.number,
      target: first.target,
    });
    const secondTicket = await second.offer();

    const responses = await Promise.all([first.merge(firstTicket), second.merge(secondTicket)]);

    expect(
      responses.map((response) => response.statusCode).sort((a, b) => a - b),
      `round ${String(round)}`,
    ).toEqual([200, 422]);
    const codes = responses.map((response) => response.json<Envelope>().code);
    expect(
      codes.filter((code) => code === 0),
      `round ${String(round)}`,
    ).toHaveLength(1);
    const winner = codes[0] === 0 ? first : second;
    const loser = codes[0] === 0 ? second : first;
    const loserResponse = codes[0] === 0 ? responses[1]! : responses[0]!;
    merged(kit, codes[0] === 0 ? responses[0]! : responses[1]!, first.target);
    refused(kit, loserResponse);

    const identities = await first.rows.oauth(first.target);
    expect(identities.filter((row) => row.provider === 'wechat')).toEqual([
      expect.objectContaining({ id: winner.sourceOauth, merged_from_user_id: winner.source }),
    ]);
    expect(await loser.user(loser.source)).toMatchObject({
      status: 'normal',
      deleted_reason: null,
    });
    expect((await loser.rows.oauth(loser.source)).map((row) => row.id)).toEqual([
      loser.sourceOauth,
    ]);
    expect(await loser.rows.sessions(loser.source)).toEqual([
      expect.objectContaining({ sid: loser.session.sid, revoked_at: null }),
    ]);
    await usable(loser, loser.session.access_token);
    expect(await winner.user(winner.source)).toMatchObject({
      status: 'deleted',
      deleted_reason: 'merged',
    });
  }
}, 240_000);
