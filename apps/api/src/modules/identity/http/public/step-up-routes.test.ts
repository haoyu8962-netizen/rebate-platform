import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  contractRouteSchema,
  createRootLogger,
  loadConfig,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { ConsentService } from '../../application/consents.ts';
import { ConsentsController } from './consents.controller.ts';
import { identityFailure } from './error-envelopes.ts';
import { H5TokenController } from './h5-token.controller.ts';
import { OauthAttemptsController } from './oauth-attempts.controller.ts';
import { StepUpController } from './step-up.controller.ts';

const TRACE = 'b102f000000000000000000000000001';
const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'session-unit',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
};
const HEADERS = {
  'content-type': 'application/json',
  'x-app-id': 'couli',
  'x-platform': 'ios',
  'x-channel': 'appstore',
  'x-app-version': '2.0.0',
  'x-device-id': PRINCIPAL.device_id,
  'x-trace-id': TRACE,
};
const ROUTES = {
  '/v1/auth/oauth-attempts': 'createOauthAttempt',
  '/v1/auth/step-up': 'stepUp',
  '/v1/auth/h5-token': 'issueH5Token',
  '/v1/consents': 'recordConsent',
} as const;

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build() {
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-08T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  const schemas = new Map<string, unknown>();
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url in ROUTES) schemas.set(route.url, route.schema);
    });
  await app.init();
  return { app, schemas };
}

it('[BR-ID-04][BR-ID-08][BR-ID-12][BR-ID-32] the api entry mounts the four routes with their contract schemas', async () => {
  const { app: target, schemas } = await build();
  for (const [path, operationId] of Object.entries(ROUTES)) {
    expect(schemas.get(path)).toEqual(contractRouteSchema(operationId));
  }
  const h5 = await target.inject({
    method: 'POST',
    url: '/v1/auth/h5-token',
    headers: HEADERS,
    payload: '{}',
  });
  expect(h5.statusCode).toBe(401);
  expect(h5.json()).toEqual({ code: 10001, msg: '未登录', trace_id: TRACE });
  // Without a database the consent service does not exist: fail closed, nothing assumed.
  const consent = await target.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: HEADERS,
    payload: JSON.stringify({
      type: 'privacy',
      version: 1,
      accepted: true,
      channel: 'first_launch',
      client_at: '2026-10-08T01:59:00.000Z',
    }),
  });
  expect(consent.statusCode).toBe(500);
  expect(consent.json()).toMatchObject({ code: 50001, trace_id: TRACE });
});

it('[BR-ID-04][BR-ID-08] failures carry the contract status and only the data their code defines', () => {
  const cases = [
    [{ code: 10001 }, 401, undefined],
    [{ code: 20001, data: { fields: ['provider'] } }, 400, { fields: ['provider'] }],
    [{ code: 20003 }, 400, undefined],
    [{ code: 20004 }, 400, undefined],
    [{ code: 20004, data: { reason: 'identity_mismatch' } }, 400, { reason: 'identity_mismatch' }],
    [{ code: 50001 }, 500, undefined],
    [{ code: 50305, data: { provider: 'wechat' } }, 503, { provider: 'wechat' }],
  ] as const;
  for (const [result, status, data] of cases) {
    const error = identityFailure(result, TRACE);
    expect(error.getStatus()).toBe(status);
    const body = error.getResponse() as Record<string, unknown>;
    expect(body).toMatchObject({ code: result.code, msg: expect.any(String), trace_id: TRACE });
    expect(body['data']).toEqual(data);
  }
});

it('[BR-ID-12] the consent subject comes from the token, else from X-App-Id and X-Device-Id', async () => {
  const record = vi.fn<ConsentService['record']>(async () => ({ code: 0, data: {} }));
  const controller = new ConsentsController({ record });
  const body = {
    type: 'agreement',
    version: 2,
    accepted: true,
    channel: 'privacy_center',
    client_at: '2026-10-08T01:59:00.000Z',
  } as const;
  await expect(
    controller.record({
      id: TRACE,
      headers: { 'x-app-id': 'other', 'x-device-id': 'header-device' },
      body,
      principal: PRINCIPAL,
    }),
  ).resolves.toEqual({ code: 0, msg: '', data: {}, trace_id: TRACE });
  expect(record).toHaveBeenLastCalledWith({
    app_id: 'couli',
    body,
    principal: PRINCIPAL,
    device_id: 'header-device',
  });
  await controller.record({
    id: TRACE,
    headers: { 'x-app-id': 'couli', 'x-device-id': 'header-device' },
    body,
  });
  expect(record).toHaveBeenLastCalledWith({ app_id: 'couli', body, device_id: 'header-device' });
  record.mockResolvedValueOnce({ code: 20001, data: { fields: ['X-Device-Id'] } });
  await expect(
    controller.record({ id: TRACE, headers: { 'x-app-id': 'couli' }, body }),
  ).rejects.toMatchObject({ status: 400 });
});

it('[BR-ID-08][BR-ID-32] handlers refuse a request the stages did not vouch for', async () => {
  const issue = vi.fn();
  await expect(
    new StepUpController({ verify: issue }).verify({
      id: TRACE,
      body: { action: 'payout_account_change', code: '123456' },
    }),
  ).rejects.toThrow(/verified access token/);
  await expect(new H5TokenController({ issue }).issue({ id: TRACE, body: {} })).rejects.toThrow(
    /verified access token/,
  );
  await expect(
    new OauthAttemptsController(null).create({
      id: TRACE,
      body: { provider: 'wechat', purpose: 'login' },
    }),
  ).rejects.toThrow(/verified device/);
  expect(issue).not.toHaveBeenCalled();
});
