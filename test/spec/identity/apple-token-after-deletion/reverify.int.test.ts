// B1-02zzd §10 #8–#10 (BR-ID-27, BR-ID-28; 编排 D10-966, D10-968; B1-02zy): the Apple
// re-verification (POST /v1/me/reverify/oauth, provider=apple) of an account that entered deletion
// while its exchange was out. The request passes the deletion guard while the account is normal and
// is parked at the exchange (reverify/kit.ts holdExchange); the status moves (a fixture statement:
// what the cooling-period expiry or the completion leaves), then the exchange answers the bound
// identity with a fresh refresh token. settlePassed writes nothing on such an account (B1-02zy), so
// the token is not stored: the answer stays what it is today, and one apple_unbind_revoke job revokes
// the token. A normal pass stores the token and queues nothing; a mismatch (20005) neither.
//
// Whether the token of a mismatched Apple identity (another Apple ID) should be revoked is not
// judged here (§10 #10): only that nothing is stored or queued for it.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BY_OAUTH,
  attemptOf,
  closeKit,
  envelope,
  firstOf,
  fixture,
  holdExchange,
  oauthBody,
  openKit,
  passed,
  type Device,
  type ExchangeAnswer,
  type Fixture,
  type Kit,
} from '../reverify/kit.ts';
import {
  appleBinding,
  appleToken,
  deliverOnce,
  expectNoPlaintext,
  expectNoRevocation,
  expectOneRevocation,
  keepAppleToken,
  moveStatus,
  revokedTokens,
  storedAppleToken,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const db = () => kit.suite.db;

/** An account with a bound phone and an Apple binding, flagged with apple as its trusted identity. */
async function appleFlagged(f: Fixture) {
  const { uid } = await f.user();
  const device = await f.device();
  const unionId = await f.bind(uid, 'apple');
  await f.flag(uid, { realname: false, providers: ['apple'] });
  return { uid, device, unionId };
}

/** One Apple submission on `from`, the exchange answering `answer` right away. */
async function submit(f: Fixture, uid: string, from: Device, answer: ExchangeAnswer) {
  const c = f.client(uid, from);
  const attempt = attemptOf(kit, await c.attempt('apple'));
  kit.exchange.mockResolvedValue(answer);
  return c.byOauth(oauthBody('apple', attempt.attempt_id));
}

/**
 * One Apple submission on `from` that passes the guard while the account is normal; while its
 * exchange is parked the account moves to `status`, then the exchange answers `answer`.
 */
async function submitWhileDeleting(
  f: Fixture,
  uid: string,
  from: Device,
  status: 'deleting' | 'deleted',
  answer: ExchangeAnswer,
) {
  const c = f.client(uid, from);
  const attempt = attemptOf(kit, await c.attempt('apple'));
  const held = holdExchange(kit);
  const request = c.byOauth(oauthBody('apple', attempt.attempt_id));
  try {
    await firstOf([held.reached, request]);
    await moveStatus(db(), f.appId, uid, status);
    held.release(answer);
  } finally {
    held.release({ unavailable: true });
  }
  return request;
}

it.each(['deleting', 'deleted'] as const)(
  '[AC-B1-02zzd#8][BR-ID-27][BR-ID-28] Apple 加验比对一致，但账号此时已是 %s：响应照旧 passed，不写 reverified_devices、不动绑定与已存令牌，恰好一条作业、解密等于本次令牌，日志无明文',
  async (status) => {
    const f = await fixture(kit);
    const { uid, device, unionId } = await appleFlagged(f);
    const earlier = appleToken();
    await keepAppleToken(db(), kit.crypto, f.appId, uid, earlier);
    const binding = await appleBinding(db(), f.appId, uid);
    const fresh = appleToken();
    passed(
      kit,
      BY_OAUTH,
      await submitWhileDeleting(f, uid, device, status, {
        union_id: unionId,
        apple_refresh_token: fresh,
      }),
    );
    expect(await f.devices(uid)).toEqual([]);
    expect(await appleBinding(db(), f.appId, uid)).toBe(binding);
    expect(await storedAppleToken(db(), kit.crypto, f.appId, uid)).toBe(earlier);
    const job = await expectOneRevocation(db(), kit.crypto, f.appId, fresh);
    expectNoPlaintext(kit.lines.join('\n'), [fresh], 'api 日志');
    const delivered = await deliverOnce(kit.crypto, job);
    expect(delivered.calls).toEqual([{ appId: f.appId, refreshToken: fresh }]);
  },
);

it('[AC-B1-02zzd#9][BR-ID-04] 正常账号 Apple 加验通过：令牌照常保存、不入队；同一账号换台设备加验时进入 deleting：保存的仍是上次的，入队的只有这次的', async () => {
  const f = await fixture(kit);
  const { uid, device, unionId } = await appleFlagged(f);
  const kept = appleToken();
  passed(
    kit,
    BY_OAUTH,
    await submit(f, uid, device, { union_id: unionId, apple_refresh_token: kept }),
  );
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  expect(await storedAppleToken(db(), kit.crypto, f.appId, uid)).toBe(kept);
  await expectNoRevocation(db(), f.appId);

  const other = await f.device();
  const fresh = appleToken();
  passed(
    kit,
    BY_OAUTH,
    await submitWhileDeleting(f, uid, other, 'deleting', {
      union_id: unionId,
      apple_refresh_token: fresh,
    }),
  );
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  expect(await storedAppleToken(db(), kit.crypto, f.appId, uid)).toBe(kept);
  await expectOneRevocation(db(), kit.crypto, f.appId, fresh);
});

it('[AC-B1-02zzd#10] 比对不一致（20005）：正常账号与进入 deleting 的账号都不保存、不入队；同一应用里另一个进入 deleting 的账号比对一致时只入队它的令牌', async () => {
  const f = await fixture(kit);
  const normal = await appleFlagged(f);
  const foreignNormal = appleToken();
  envelope(
    kit,
    BY_OAUTH,
    await submit(f, normal.uid, normal.device, {
      union_id: `union-${appleToken()}`,
      apple_refresh_token: foreignNormal,
    }),
    20005,
  );
  expect(await storedAppleToken(db(), kit.crypto, f.appId, normal.uid)).toBeNull();
  await expectNoRevocation(db(), f.appId);

  const leaving = await appleFlagged(f);
  const foreignLeaving = appleToken();
  envelope(
    kit,
    BY_OAUTH,
    await submitWhileDeleting(f, leaving.uid, leaving.device, 'deleting', {
      union_id: `union-${appleToken()}`,
      apple_refresh_token: foreignLeaving,
    }),
    20005,
  );
  expect(await storedAppleToken(db(), kit.crypto, f.appId, leaving.uid)).toBeNull();
  await expectNoRevocation(db(), f.appId);

  const matching = await appleFlagged(f);
  const fresh = appleToken();
  passed(
    kit,
    BY_OAUTH,
    await submitWhileDeleting(f, matching.uid, matching.device, 'deleting', {
      union_id: matching.unionId,
      apple_refresh_token: fresh,
    }),
  );
  await expectOneRevocation(db(), kit.crypto, f.appId, fresh);
  const revoked = await revokedTokens(db(), kit.crypto, f.appId);
  expect(revoked).not.toContain(foreignNormal);
  expect(revoked).not.toContain(foreignLeaving);
});
