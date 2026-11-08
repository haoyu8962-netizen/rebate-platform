// B1-02zzd §10 #1–#7, #11 and the enqueue helper (BR-ID-27, BR-ID-28; 编排 D10-966, D10-968): an
// Apple login of an account in deletion still answers as before (deleting → 10007 stage=processing,
// a retained binding to a deleted account → 50001), keeps nothing of the exchanged refresh token,
// and leaves exactly one apple_unbind_revoke job that revokes it — committed apart from the login
// transaction that rolled back. Normal accounts, logins without a token, WeChat logins and the
// restricted login without an account queue nothing (BR-ID-04 细则「受限登录」 unchanged). The real
// POST /v1/auth/login/{wechat,apple} of the api app (oauth-login/kit.ts); only the exchange is a double.
// Huawei login is still x-implementation: planned (contracts/openapi.yaml loginByHuawei): not reached.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { enqueueDiscardedAppleToken } from '../../../../apps/api/src/modules/identity/application/apple-unbind-revocation.ts';
import type { JobQueue } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  LOGIN,
  RESTRICTED,
  accepted,
  closeOauthKit,
  fixture,
  loginBody,
  openOauthKit,
  rejected,
  rows,
  type ExchangeAnswer,
  type Fixture,
  type OauthKit,
  type Provider,
} from '../oauth-login/kit.ts';
import { ROOT } from '../../risk/signature/kit.ts';
import {
  appleBinding,
  appleToken,
  bindApple,
  deliverOnce,
  expectNoPlaintext,
  expectNoRevocation,
  expectOneRevocation,
  keepAppleToken,
  moveStatus,
  revokedTokens,
  storedAppleToken,
} from './kit.ts';

let kit: OauthKit;
beforeAll(async () => {
  kit = await openOauthKit();
}, 180_000);
afterAll(async () => {
  await closeOauthKit(kit);
});

const IN_DELETION = [
  { status: 'deleting', code: 10007, data: { stage: 'processing' } },
  { status: 'deleted', code: 50001, data: undefined },
] as const;

/** One login of this device with a fresh attempt; the exchange answers `answer`. */
async function login(
  f: Fixture,
  provider: Provider,
  answer: ExchangeAnswer,
  headers: Record<string, string> = {},
) {
  kit.exchange.mockResolvedValue(answer);
  const attempt = await f.device.attempt(provider, headers);
  return f.device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id), headers);
}

const db = () => kit.suite.db;

it('[AC-B1-02zzd#1][BR-ID-27][BR-ID-28] Apple 登录绑定账号 status=deleting：仍 10007 stage=processing，绑定行令牌列不变，恰好一条 apple_unbind_revoke，密文解密等于本次换码所得、不含明文，worker 撤销的正是它', async () => {
  const f = await fixture(kit);
  const bound = await f.account('apple', 'deleting');
  const earlier = appleToken();
  await keepAppleToken(db(), f.crypto, f.appId, bound.uid, earlier);
  const binding = await appleBinding(db(), f.appId, bound.uid);
  const fresh = appleToken();
  rejected(
    kit,
    LOGIN.apple,
    await login(f, 'apple', { union_id: bound.unionId, apple_refresh_token: fresh }),
    10007,
    { stage: 'processing' },
  );
  expect(await appleBinding(db(), f.appId, bound.uid)).toBe(binding);
  expect(await storedAppleToken(db(), f.crypto, f.appId, bound.uid)).toBe(earlier);
  const job = await expectOneRevocation(db(), f.crypto, f.appId, fresh);
  const delivered = await deliverOnce(f.crypto, job);
  expect(delivered.calls).toEqual([{ appId: f.appId, refreshToken: fresh }]);
  expectNoPlaintext(delivered.lines.join('\n'), [fresh], 'worker 日志');
});

it('[AC-B1-02zzd#2][BR-ID-28] 保留绑定指向 status=deleted 的账号：仍 50001，不新建账号、不动绑定，恰好一条作业、解密等于本次令牌', async () => {
  const f = await fixture(kit);
  const bound = await f.account('apple', 'deleted');
  const before = await rows(f);
  const fresh = appleToken();
  rejected(
    kit,
    LOGIN.apple,
    await login(f, 'apple', { union_id: bound.unionId, apple_refresh_token: fresh }),
    50001,
  );
  const after = await rows(f);
  expect(after.users).toEqual(before.users);
  expect(after.oauth).toEqual(before.oauth);
  await expectOneRevocation(db(), f.crypto, f.appId, fresh);
});

it('[AC-B1-02zzd#3][BR-ID-04] 正常账号 Apple 登录：令牌照常加密保存、不入队；同一身份在账号进入 deleting 后再登录：保存的仍是上次的，入队的只有这次的', async () => {
  const f = await fixture(kit);
  const bound = await f.account('apple');
  const kept = appleToken();
  const data = accepted(
    kit,
    LOGIN.apple,
    await login(f, 'apple', { union_id: bound.unionId, apple_refresh_token: kept }),
  );
  expect(data).toMatchObject({ user_id: bound.uid, is_new_user: false });
  expect(await storedAppleToken(db(), f.crypto, f.appId, bound.uid)).toBe(kept);
  await expectNoRevocation(db(), f.appId);

  await moveStatus(db(), f.appId, bound.uid, 'deleting');
  const fresh = appleToken();
  rejected(
    kit,
    LOGIN.apple,
    await login(f, 'apple', { union_id: bound.unionId, apple_refresh_token: fresh }),
    10007,
    { stage: 'processing' },
  );
  expect(await storedAppleToken(db(), f.crypto, f.appId, bound.uid)).toBe(kept);
  await expectOneRevocation(db(), f.crypto, f.appId, fresh);
});

it('[AC-B1-02zzd#4] deleting 账号、换码结果没有 refresh_token：仍 10007，不入队；再次登录带回令牌时才入队一条', async () => {
  const f = await fixture(kit);
  const bound = await f.account('apple', 'deleting');
  rejected(kit, LOGIN.apple, await login(f, 'apple', { union_id: bound.unionId }), 10007, {
    stage: 'processing',
  });
  await expectNoRevocation(db(), f.appId);
  expect(await storedAppleToken(db(), f.crypto, f.appId, bound.uid)).toBeNull();

  const fresh = appleToken();
  rejected(
    kit,
    LOGIN.apple,
    await login(f, 'apple', { union_id: bound.unionId, apple_refresh_token: fresh }),
    10007,
    { stage: 'processing' },
  );
  expect(await storedAppleToken(db(), f.crypto, f.appId, bound.uid)).toBeNull();
  await expectOneRevocation(db(), f.crypto, f.appId, fresh);
});

it('[AC-B1-02zzd#5] 微信登录 deleting 账号：仍 10007，不入队；同一账号的 Apple 身份登录才入队一条（只撤 Apple 令牌）', async () => {
  const f = await fixture(kit);
  const wechat = await f.account('wechat', 'deleting');
  const appleUnion = await bindApple(db(), f.appId, wechat.uid);
  rejected(
    kit,
    LOGIN.wechat,
    await login(f, 'wechat', { union_id: wechat.unionId, open_id: `open-${appleToken()}` }),
    10007,
    { stage: 'processing' },
  );
  await expectNoRevocation(db(), f.appId);

  const fresh = appleToken();
  rejected(
    kit,
    LOGIN.apple,
    await login(f, 'apple', { union_id: appleUnion, apple_refresh_token: fresh }),
    10007,
    { stage: 'processing' },
  );
  await expectOneRevocation(db(), f.crypto, f.appId, fresh);
});

it('[AC-B1-02zzd#6][BR-ID-04] 受限登录查不到账号 → 10405 no_account：令牌不保存、不入队；同样受限的登录查到 deleting 账号 → 10007 并只入队那一次的令牌', async () => {
  const f = await fixture(kit);
  const before = await rows(f);
  const orphan = appleToken();
  rejected(
    kit,
    LOGIN.apple,
    await login(
      f,
      'apple',
      { union_id: `union-${appleToken()}`, apple_refresh_token: orphan },
      RESTRICTED,
    ),
    10405,
    { reason: 'no_account' },
  );
  expect(await rows(f)).toEqual(before);
  await expectNoRevocation(db(), f.appId);

  const bound = await f.account('apple', 'deleting');
  const fresh = appleToken();
  rejected(
    kit,
    LOGIN.apple,
    await login(f, 'apple', { union_id: bound.unionId, apple_refresh_token: fresh }, RESTRICTED),
    10007,
    { stage: 'processing' },
  );
  await expectOneRevocation(db(), f.crypto, f.appId, fresh);
  expect(await revokedTokens(db(), f.crypto, f.appId)).not.toContain(orphan);
});

it.each(IN_DELETION)(
  '[AC-B1-02zzd#7] 回滚不连带作业：$status 账号的 Apple 登录答 $code，登录事务的写入全部回滚（会话、令牌、日志、同意、用户、绑定都不变），作业仍已提交',
  async ({ status, code, data }) => {
    const f = await fixture(kit);
    const bound = await f.account('apple', status);
    const before = await rows(f);
    const fresh = appleToken();
    rejected(
      kit,
      LOGIN.apple,
      await login(f, 'apple', { union_id: bound.unionId, apple_refresh_token: fresh }),
      code,
      data,
    );
    expect(await rows(f)).toEqual(before);
    await expectOneRevocation(db(), f.crypto, f.appId, fresh);
  },
);

it.each(IN_DELETION)(
  '[AC-B1-02zzd#11] 日志不出现令牌明文：$status 账号的 Apple 登录前后，api 日志与作业里都没有本次令牌，作业已入队',
  async ({ status, code, data }) => {
    const f = await fixture(kit);
    const bound = await f.account('apple', status);
    const start = kit.lines.length;
    const fresh = appleToken();
    rejected(
      kit,
      LOGIN.apple,
      await login(f, 'apple', { union_id: bound.unionId, apple_refresh_token: fresh }),
      code,
      data,
    );
    expectNoPlaintext(kit.lines.slice(start).join('\n'), [fresh], 'api 日志');
    await expectOneRevocation(db(), f.crypto, f.appId, fresh);
  },
);

it('[AC-B1-02zzd#13] enqueueDiscardedAppleToken：自开短事务提交一条 data-copy 队列的 apple_unbind_revoke，载荷 {appId, cipher}，密文解密等于令牌、不含明文', async () => {
  const f = await fixture(kit);
  const platform = (await import(new URL('apps/api/src/modules/platform/index.ts', ROOT).href)) as {
    JOB_QUEUE: symbol;
  };
  const queue = kit.app.get<JobQueue>(platform.JOB_QUEUE);
  const token = appleToken();
  await enqueueDiscardedAppleToken(
    { queue, db: db(), crypto: f.crypto },
    { appId: f.appId, refreshToken: token },
  );
  await expectOneRevocation(db(), f.crypto, f.appId, token);
});
