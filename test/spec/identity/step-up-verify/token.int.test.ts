// B1-02y: what stage ⑫ checks on X-Step-Up-Token (规划/08 BR-ID-08 正文与细则; 04 §5 step-up row;
// ruling §9.3 #2). Every refusal is 10003 (HTTP 403, no data) and the business does not run; each
// test ends with a valid token of the same user passing, so a stage that refuses everything fails.
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TTL_SECONDS,
  openFixture,
  stepUpRequired,
  succeeded,
  user,
  type Fixture,
  type User,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

const segment = (value: object) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** A compact ES256 JWS signed with `key` (any header and payload; for forged tokens). */
function jws(header: object, payload: object, key: KeyObject): string {
  const input = `${segment(header)}.${segment(payload)}`;
  const signature = sign('sha256', Buffer.from(input, 'ascii'), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${input}.${signature}`;
}

/** The claims a valid step_up_token of this user carries (issuer as the access token's). */
function claims(u: User, now: number, extra: Record<string, unknown> = {}) {
  const payload = JSON.parse(
    Buffer.from(u.session.access_token.split('.')[1]!, 'base64url').toString('utf8'),
  ) as { iss: string };
  return {
    uid: u.uid,
    app_id: u.appId,
    sid: u.session.sid,
    device_id: u.deviceId,
    action: 'account_deletion',
    jti: randomUUID(),
    iss: payload.iss,
    aud: 'step_up',
    iat: now,
    exp: now + TTL_SECONDS,
    ...extra,
  };
}

async function refusedThenValid(u: User, token: string | null): Promise<void> {
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(0);
  succeeded(await u.send('deletion', { stepUp: await u.mint() }));
  expect(u.handled()).toBe(1);
}

it('[AC-B1-02y#1] 缺少 X-Step-Up-Token 返回 10003，业务不执行', async () => {
  await refusedThenValid(await user(f), null);
});

it('[AC-B1-02y#2] 乱码、空串与三段非 JWT 的 token 返回 10003', async () => {
  const u = await user(f);
  for (const token of ['not-a-jwt', 'a.b.c', '']) {
    await stepUpRequired(await u.send('deletion', { stepUp: token }));
  }
  expect(u.handled()).toBe(0);
  succeeded(await u.send('deletion', { stepUp: await u.mint() }));
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#3] 篡改签名或载荷的 token 返回 10003', async () => {
  const u = await user(f);
  const valid = await u.mint();
  const [header, payload, signature] = valid.split('.') as [string, string, string];
  const flipped =
    signature.slice(0, 10) + (signature[10] === 'A' ? 'B' : 'A') + signature.slice(11);
  await stepUpRequired(await u.send('deletion', { stepUp: `${header}.${payload}.${flipped}` }));
  const other = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  const forgedPayload = segment({ ...other, exp: Number(other['exp']) + 3600 });
  await stepUpRequired(
    await u.send('deletion', { stepUp: `${header}.${forgedPayload}.${signature}` }),
  );
  expect(u.handled()).toBe(0);
  succeeded(await u.send('deletion', { stepUp: valid }));
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#4] 别的密钥签的、alg=none 的、签发者不对的 token 返回 10003', async () => {
  const u = await user(f);
  const now = Math.floor(f.clock.now().getTime() / 1000);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const header = { alg: 'ES256', kid: f.keys.kid, typ: 'JWT' };
  // Control of the forging helper: the real key with the real claims gives a token that passes
  // (last step), so each refusal below is about the one property changed.
  const genuine = jws(header, claims(u, now), f.keys.privateKey);
  await stepUpRequired(
    await u.send('deletion', { stepUp: jws(header, claims(u, now), privateKey) }),
  );
  const unsigned = `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims(u, now))}.`;
  await stepUpRequired(await u.send('deletion', { stepUp: unsigned }));
  await stepUpRequired(
    await u.send('deletion', {
      stepUp: jws(header, claims(u, now, { iss: 'couli-elsewhere' }), f.keys.privateKey),
    }),
  );
  expect(u.handled()).toBe(0);
  succeeded(await u.send('deletion', { stepUp: genuine }));
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#5] access_token 与 aud=h5 的 token 冒充 step_up_token 返回 10003', async () => {
  const u = await user(f);
  await stepUpRequired(await u.send('deletion', { stepUp: u.session.access_token }));
  await stepUpRequired(
    await u.send('deletion', { stepUp: await u.mint('account_deletion', { audience: 'h5' }) }),
  );
  const now = Math.floor(f.clock.now().getTime() / 1000);
  await stepUpRequired(
    await u.send('deletion', {
      stepUp: jws(
        { alg: 'ES256', kid: f.keys.kid, typ: 'JWT' },
        claims(u, now, { aud: 'app' }),
        f.keys.privateKey,
      ),
    }),
  );
  expect(u.handled()).toBe(0);
  succeeded(await u.send('deletion', { stepUp: await u.mint() }));
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#6] 按注入的 Clock 判过期：签发后第 299 秒通过，第 300 秒整返回 10003', async () => {
  const u = await user(f);
  const early = await u.mint();
  const late = await u.mint();
  f.clock.advanceMs(299_000);
  succeeded(await u.send('deletion', { stepUp: early }));
  expect(u.handled()).toBe(1);
  f.clock.advanceMs(1_000);
  await stepUpRequired(await u.send('deletion', { stepUp: late }));
  expect(u.handled()).toBe(1);
  succeeded(await u.send('deletion', { stepUp: await u.mint() }));
  expect(u.handled()).toBe(2);
});

// B1-02zzzc (D10-1665, D10-1702): POST /v1/withdrawals no longer judges a step-up token, so a
// withdrawal carrying another action's token is accepted (the token is ignored).
it('[AC-B1-02y#7] action 与接口不对应返回 10003：phone_change 的 token 调注销；提现不判 token，带 account_deletion / phone_change 的也照常受理', async () => {
  const u = await user(f);
  await stepUpRequired(await u.send('deletion', { stepUp: await u.mint('phone_change') }));
  await stepUpRequired(await u.send('deletion', { stepUp: await u.mint('payout_account_change') }));
  expect(u.handled()).toBe(0);
  succeeded(await u.send('withdraw', { stepUp: await u.mint('account_deletion') }));
  succeeded(await u.send('withdraw', { stepUp: await u.mint('phone_change') }));
  expect(u.handled()).toBe(2);
  succeeded(await u.send('withdraw', { stepUp: await u.mint('withdraw') }));
  succeeded(await u.send('deletion', { stepUp: await u.mint('account_deletion') }));
  expect(u.handled()).toBe(4);
});

it('[AC-B1-02y#8] 绑定别的 uid、别的设备、别的 app 的 token 返回 10003', async () => {
  const u = await user(f);
  const other = await user(f);
  // Another real user's token, valid for that user: the claims are compared with this request's
  // principal, never taken as the identity.
  await stepUpRequired(await u.send('deletion', { stepUp: await other.mint() }));
  for (const changed of [
    { uid: other.uid },
    { device_id: other.deviceId },
    { app_id: other.appId },
  ]) {
    await stepUpRequired(
      await u.send('deletion', { stepUp: await u.mint('account_deletion', { claims: changed }) }),
    );
  }
  expect(u.handled()).toBe(0);
  expect(other.handled()).toBe(0);
  succeeded(await other.send('deletion', { stepUp: await other.mint() }));
  expect(other.handled()).toBe(1);
  succeeded(await u.send('deletion', { stepUp: await u.mint() }));
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#9] 缺 jti、缺 action 或缺 device_id 的 token 返回 10003', async () => {
  const u = await user(f);
  for (const missing of ['jti', 'action', 'device_id']) {
    await stepUpRequired(
      await u.send('deletion', {
        stepUp: await u.mint('account_deletion', { claims: { [missing]: undefined } }),
      }),
    );
  }
  expect(u.handled()).toBe(0);
  succeeded(await u.send('deletion', { stepUp: await u.mint() }));
  expect(u.handled()).toBe(1);
});
