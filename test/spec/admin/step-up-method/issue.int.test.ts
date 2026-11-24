import { expect, it } from 'vitest';
import { totp, useHarness } from '../auth/kit.ts';
import { error, lastCode, ok, SEND, setup, STEP, type Grant } from '../step-up/kit.ts';

const h = useHarness();
type Method = 'totp' | 'sms';
const methods: readonly Method[] = ['totp', 'sms'];
type StepUpSession = Awaited<ReturnType<typeof setup>>;

async function freshCode(session: StepUpSession, method: Method): Promise<string> {
  if (method === 'sms') {
    await ok(await session.send(), SEND);
    return lastCode(session.f);
  }
  // 登录已消耗当前时间窗的动态码。
  session.f.clock.advanceMs(30_000);
  return totp(session.a.secret, session.f.clock);
}

async function issue(session: StepUpSession, body: Record<string, unknown>): Promise<Grant> {
  const grant = await ok<Grant>(await session.f.post('/step-up', body, session.headers), STEP);
  expect(grant.step_up_token).toMatch(/\S/);
  return grant;
}

it.each(methods)(
  '[AC-CT-24zzv#14] %s 只带 method 或只带旧名 tier 均签发同形凭证',
  async (method) => {
    const session = await setup(h);
    const legacy = await issue(session, { tier: method, code: await freshCode(session, method) });
    // 下一条短信须跨过重发间隔，且两次签发各用一条新验证码。
    session.f.clock.advanceMs(60_000);
    const current = await issue(session, { method, code: await freshCode(session, method) });

    expect(Object.keys(current).toSorted()).toEqual(Object.keys(legacy).toSorted());
  },
  30_000,
);

it('[AC-CT-24zzv#15] 两个方式字段都缺失时返回 20001 并只指出 method', async () => {
  const session = await setup(h);
  const code = await freshCode(session, 'totp');
  const response = await session.f.post('/step-up', { code }, session.headers);

  await error(response, STEP, 20001, { fields: ['method'] });
}, 30_000);

it.each(methods)(
  '[AC-CT-24zzv#16] method=%s 与旧名冲突时只按 method 验码',
  async (method) => {
    const session = await setup(h);
    const tier = method === 'totp' ? 'sms' : 'totp';
    await issue(session, { method, tier, code: await freshCode(session, method) });
  },
  30_000,
);

it.each(methods)(
  '[AC-CT-24zzv#17] method 和 tier 同为 %s 时签发凭证',
  async (method) => {
    const session = await setup(h);
    await issue(session, { method, tier: method, code: await freshCode(session, method) });
  },
  30_000,
);
