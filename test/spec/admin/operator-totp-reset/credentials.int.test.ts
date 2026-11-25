import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { createOperatorTotpReset } from '../../../../apps/api/src/modules/admin/application/operator-totp-reset.ts';
import {
  createAdminStepUpGate,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminRevocations } from '../../../../apps/api/src/modules/admin/infra/admin-revocations.ts';
import { createSystemAuditWriter } from '../../../../apps/api/src/modules/admin/infra/system-audit.ts';
import { createRedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { seed } from '../accounts/kit.ts';
import { alive, dead, harness, ticketGone } from '../admins-write/kit.ts';
import { binding, fixture, login, signedIn, totp } from '../auth/kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34t#12] 运维重置作废旧会话、登录票据和二次验证令牌，其他账号的会话仍可用', async () => {
  const f = await fixture(h);
  const redis = await createRedisHandle(
    { entry: 'admin', redisUrl: f.overrides.redisUrl },
    { logger: f.overrides.logger },
  );
  assert(redis !== null);
  try {
    const appId = `ops_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const target = await seed(h, appId, { isSuper: true });
    const other = await seed(h, appId);
    const revocations = createAdminRevocations({ redis: redis.namespace('admin-auth') });
    const stepUpRedis = redis.namespace('admin-step-up');
    const gate = createAdminStepUpGate({ clock: f.clock, redis: stepUpRedis, revocations });
    const useCase = createOperatorTotpReset({
      db: h.db.withoutPlugins().withSchema('app'),
      clock: f.clock,
      audit: createSystemAuditWriter({ clock: f.clock }),
      revocations,
    });

    const session = await signedIn(f, target);
    const otherSession = await signedIn(f, other);
    const pending = await login(f, target);
    const principal = { appId, adminId: target.id, sessionId: randomUUID() };
    const tier = 'totp' as const;
    const grant = await createAdminStepUpTokens({ clock: f.clock, redis: stepUpRedis }).issue({
      ...principal,
      tier,
    });
    const attempt = {
      principal,
      tier,
      traceId: randomUUID(),
      headers: { 'x-step-up-token': grant.step_up_token },
    };
    const business = vi.fn(async () => ({ statusCode: 409, body: { code: 20902 } }));
    await alive(f, session.admin_token);
    await alive(f, otherSession.admin_token);
    // 保留这枚已核验可用的令牌给重置后的同一次尝试。
    expect(await gate.run(attempt, business)).toMatchObject({ statusCode: 409 });
    business.mockClear();
    f.clock.advanceMs(30_250);

    expect(
      await useCase.reset({ appId, loginName: target.username, reason: '已当面核对本人身份' }),
    ).toEqual({ kind: 'reset' });
    expect(await revocations.voidedAt(principal)).toBe(f.clock.now().getTime());
    await dead(f, session.admin_token);
    await alive(f, otherSession.admin_token);
    ticketGone(
      await f.post('/totp', {
        login_ticket: pending.login_ticket,
        code: totp(target.secret, f.clock),
      }),
    );
    await expect(gate.run(attempt, business)).rejects.toMatchObject({ response: { code: 10003 } });
    expect(business).not.toHaveBeenCalled();

    const next = await login(f, target, 'bind_totp');
    expect((await binding(f, next.login_ticket)).totp_secret).not.toBe(target.secret);
  } finally {
    await redis.close();
  }
});
