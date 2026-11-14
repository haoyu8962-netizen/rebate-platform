import { fileURLToPath } from 'node:url';
import { HttpException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { dereference } from '@readme/openapi-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import type { OpenAPIV3_1 } from 'openapi-types';
import type { Schema } from '@couli/contracts-ts';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  contractRouteSchema,
  createRootLogger,
  loadConfig,
} from '../../../platform/index.ts';
import type { SmsRequest, SmsResult } from '../../application/sms-codes.ts';
import { createSmsCodeRequestService } from '../../application/sms-code-requests.ts';
import { SMS_CODES } from '../../application/tokens.ts';
import { smsSenderToken, type FakeSmsSender } from '../../infra/fake-sms.ts';
import { SmsCodesController, smsErrorResponse } from './sms-codes.controller.ts';

const CONTRACT = fileURLToPath(
  new URL('../../../../../../../contracts/openapi.yaml', import.meta.url),
);
const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';

type Validate = ((data: unknown) => boolean) & { errors?: unknown[] | null };
type Status = '200' | '429' | '4XX' | '5XX';
const validators = new Map<Status, Validate>();
let retryAfterSchema: object;

beforeAll(async () => {
  const document = await dereference<OpenAPIV3_1.Document>(CONTRACT, {
    resolve: { external: false },
  });
  const responses = document.paths?.['/v1/auth/sms-codes']?.post?.responses ?? {};
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) =>
      Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  for (const status of ['200', '429', '4XX', '5XX'] as const) {
    const response = responses[status] as OpenAPIV3_1.ResponseObject | undefined;
    validators.set(status, ajv.compile(response?.content?.['application/json']?.schema as object));
  }
  const tooMany = responses['429'] as OpenAPIV3_1.ResponseObject;
  retryAfterSchema = (tooMany.headers?.['Retry-After'] as OpenAPIV3_1.HeaderObject).schema!;
  ajv.compile(retryAfterSchema);
});

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function valid(status: Status, body: unknown): void {
  const validate = validators.get(status)!;
  const ok = validate(body);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

it('[BR-ID-05] every failed send maps to its contract status and a valid ErrorEnvelope without free text', () => {
  const cases: [Exclude<SmsResult, { code: 0 }>, number, '429' | '4XX' | '5XX'][] = [
    [{ code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } }, 400, '4XX'],
    [{ code: 42901, retryAfterSec: 60 }, 429, '429'],
    [{ code: 44001, kind: 'blocked_prefix' }, 403, '4XX'],
    [{ code: 44001, kind: 'phone_blocklist', data: { risk_msg_code: 'blocked' } }, 403, '4XX'],
    [{ code: 44003 }, 403, '4XX'],
    [{ code: 50001 }, 500, '5XX'],
  ];
  for (const [result, status, schema] of cases) {
    const response = smsErrorResponse(result, TRACE);
    expect(response.statusCode).toBe(status);
    expect(response.body).toMatchObject({ code: result.code, trace_id: TRACE });
    expect(response.body.msg).not.toBe('');
    valid(schema, response.body);
  }
  expect(smsErrorResponse(cases[0]![0], TRACE).body.data).toEqual({
    fields: ['phone'],
    reason: 'phone_invalid',
  });
  expect(smsErrorResponse(cases[2]![0], TRACE).body).not.toHaveProperty('data');
  expect(smsErrorResponse(cases[3]![0], TRACE).body.data).toEqual({ risk_msg_code: 'blocked' });
  expect(smsErrorResponse({ code: 42901, retryAfterSec: 60 }, TRACE).retryAfterSec).toBe(60);
});

const BOUND = '13912345678';

function controller(result: SmsResult | null) {
  const send = vi.fn(async (request: SmsRequest) => {
    void request;
    return result!;
  });
  const boundPhone = vi.fn(async (appId: string, uid: string) => {
    void appId;
    void uid;
    return BOUND as string | null | undefined;
  });
  const service =
    result === null ? null : createSmsCodeRequestService({ sms: { send }, boundPhone });
  const headers: [string, string][] = [];
  const reply = { header: (name: string, value: string) => headers.push([name, value]) };
  const request = {
    id: TRACE,
    ip: '203.0.113.7',
    verifiedDevice: { deviceId: 'd1', appId: 'couli' },
    principal: {
      uid: 'u1',
      app_id: 'couli',
      sid: 's1',
      device_id: 'd1',
      scp: 'full' as const,
    },
    body: {
      purpose: 'step_up' as const,
      captcha_token: 'cap',
      action: 'account_deletion' as const,
    } as Schema<'SendSmsCodeRequest'>,
  };
  return {
    target: new SmsCodesController(service),
    send,
    boundPhone,
    headers,
    reply,
    request,
  };
}

it('[BR-ID-05][BR-ID-08] the controller passes the verified app and device, the client IP, the body and the bound phone of the token account, and answers 200 per contract', async () => {
  const c = controller({ code: 0, data: { resend_after_sec: 60, expires_in_sec: 300 } });
  const body = await c.target.send(c.request, c.reply);
  valid('200', body);
  expect(body).toEqual({
    code: 0,
    msg: '',
    data: { resend_after_sec: 60, expires_in_sec: 300 },
    trace_id: TRACE,
  });
  expect(c.boundPhone).toHaveBeenCalledWith('couli', 'u1');
  expect(c.send).toHaveBeenCalledWith({
    app_id: 'couli',
    phone: BOUND,
    purpose: 'step_up',
    device_id: 'd1',
    client_ip: '203.0.113.7',
    captcha_token: 'cap',
    action: 'account_deletion',
  });
  expect(c.headers).toEqual([]);
});

it('[BR-ID-05] a 42901 sets Retry-After (a contract integer ≥ 1) and throws the 429 envelope', async () => {
  const c = controller({ code: 42901, retryAfterSec: 79_801 });
  const error = await c.target.send(c.request, c.reply).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(429);
  valid('429', (error as HttpException).getResponse());
  expect(c.headers).toEqual([['Retry-After', '79801']]);
  const ajv = new Ajv2020({ strict: false });
  ajvFormats.default(ajv);
  expect(ajv.compile(retryAfterSchema)(79_801)).toBe(true);
});

it('[BR-ID-08] step_up refusals decided before the send are contract envelopes and send nothing', async () => {
  const anonymous = controller({ code: 0, data: { resend_after_sec: 60, expires_in_sec: 300 } });
  const { principal, ...withoutToken } = anonymous.request;
  void principal;
  const cases: [Promise<unknown>, number, number, object | undefined][] = [
    [anonymous.target.send(withoutToken, anonymous.reply), 401, 10001, undefined],
    [
      anonymous.target.send(
        { ...anonymous.request, body: { ...anonymous.request.body, phone: BOUND } },
        anonymous.reply,
      ),
      400,
      20001,
      { fields: ['phone'] },
    ],
  ];
  for (const [pending, status, code, data] of cases) {
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    const body = (error as HttpException).getResponse() as Record<string, unknown>;
    valid('4XX', body);
    expect(body).toMatchObject({ code, trace_id: TRACE });
    if (data === undefined) expect(body).not.toHaveProperty('data');
    else expect(body['data']).toEqual(data);
  }
  expect(anonymous.send).not.toHaveBeenCalled();
});

it('[BR-ID-05] without the service (no Redis or no database) or a verified device the request fails closed', async () => {
  const missing = controller(null);
  await expect(missing.target.send(missing.request, missing.reply)).rejects.toThrow(
    /SMS codes need Redis/,
  );
  const unverified = controller({ code: 44003 });
  const { verifiedDevice, ...request } = unverified.request;
  void verifiedDevice;
  await expect(unverified.target.send(request, unverified.reply)).rejects.toThrow(
    /verified device/,
  );
  expect(unverified.send).not.toHaveBeenCalled();
});

it('[BR-ID-05] the api entry mounts the contract route schema and provides the fake sender, without a service when Redis is absent', async () => {
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-06T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  const schemas: unknown[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url === '/v1/auth/sms-codes')
        schemas.push({ method: route.method, schema: route.schema });
    });
  await app.init();
  expect(schemas).toEqual([{ method: 'POST', schema: contractRouteSchema('sendSmsCode') }]);
  const sender = app.get<FakeSmsSender>(smsSenderToken());
  expect(sender.outbox()).toEqual([]);
  expect(app.get(SMS_CODES)).toBeNull();
});
