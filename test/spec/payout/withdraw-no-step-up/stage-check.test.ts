// B1-02zzzc (D10-1665 / D10-1666; BR-ID-08, BR-ID-01 ⑫): identity's stage ⑫ no longer maps
// POST /v1/withdrawals — inside an HTTP request it passes a withdrawal without any step-up context,
// header or Redis reservation, while the three operations that still need step-up keep failing
// closed with 10003 when called outside withStepUp. No database, network or listener.
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createStepUpCheck } from '../../../../apps/api/src/modules/identity/application/step-up-verify.ts';
import {
  FixedClock,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { RiskModule } from '../../../../apps/api/src/modules/risk/index.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function stageCheck() {
  const namespace = vi.fn();
  const warn = vi.fn();
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const check = createStepUpCheck({
    keys: {
      kid: 'b1-02zzzc',
      privateKey: pair.privateKey,
      publicKeys: new Map([['b1-02zzzc', pair.publicKey]]),
    },
    clock: new FixedClock('2026-11-15T02:00:00.000Z'),
    redis: { namespace } as unknown as RedisHandle,
    logger: { warn } as unknown as RootLogger,
  });
  return { check, namespace, warn };
}

type Command = Parameters<ReturnType<typeof createStepUpCheck>>[0];
function command(method: 'POST' | 'PUT', path: string): Command {
  return {
    appId: 'couli',
    actor: { userId: '019a0000-0000-7000-8000-0000000002cc', deviceId: null, phoneHmac: null },
    method,
    path,
    key: 'b1-02zzzc-stage-check',
    body: { amount_fen: 1000 },
    traceId: 'b1-02zzzc-stage-check',
  } as Command;
}

// Collapses the check's outcome into a plain value so that a rejection (e.g. a RequestRejection
// from an implementation that still gates withdrawals) surfaces as an assertion failure rather
// than as the innermost cause of the failure. 'passed' only when the check resolves to undefined.
function passedOrError(run: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve()
    .then(run)
    .then(
      (value: unknown) => (value === undefined ? 'passed' : value),
      (error: unknown) => error,
    );
}

it('[AC-B1-02zzzc#22] ⑫ 在 HTTP 请求内不再判 POST /v1/withdrawals：无 withStepUp、无令牌直接放过，不碰 Redis', async () => {
  vi.spyOn(RiskModule, 'hasHttpRequestScope').mockReturnValue(true);
  const { check, namespace, warn } = stageCheck();
  const outcome = await passedOrError(() => check(command('POST', '/v1/withdrawals')));
  expect(outcome).toBe('passed');
  expect(namespace).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B1-02zzzc#23] ⑫ 对仍要二次验证的收款账号变更、注销照旧：HTTP 内缺 step-up 上下文即 10003；提现同一检查器放过', async () => {
  vi.spyOn(RiskModule, 'hasHttpRequestScope').mockReturnValue(true);
  const { check, namespace } = stageCheck();
  for (const [method, path] of [
    ['PUT', '/v1/me/payout-account'],
    ['POST', '/v1/me/deletion'],
  ] as const) {
    await expect(check(command(method, path)), `${method} ${path}`).rejects.toMatchObject({
      code: 10003,
      statusCode: 403,
    });
  }
  const outcome = await passedOrError(() => check(command('POST', '/v1/withdrawals')));
  expect(outcome).toBe('passed');
  expect(namespace).not.toHaveBeenCalled();
});
