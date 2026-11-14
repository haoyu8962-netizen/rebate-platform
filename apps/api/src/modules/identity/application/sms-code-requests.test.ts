// Unit tests of the public send's number choice (B1-02zzz, BR-ID-08) without Redis or a database:
// the SMS code service and the bound phone reader are stubs.
import type { Schema } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import type { TokenPrincipal } from '../../platform/index.ts';
import { createSmsCodeRequestService } from './sms-code-requests.ts';
import type { SmsRequest, SmsResult } from './sms-codes.ts';

const DEVICE = { deviceId: 'd1', appId: 'couli' };
const PRINCIPAL: TokenPrincipal = {
  uid: 'u1',
  app_id: 'couli',
  sid: 's1',
  device_id: 'd1',
  scp: 'full',
};
const OK: SmsResult = { code: 0, data: { resend_after_sec: 60, expires_in_sec: 300 } };

// No argument → a user with a bound phone; an explicit undefined → no user row (BoundPhoneReader's
// contract), which a default parameter would silently replace with the default phone.
function setup(...args: [bound?: string | null | undefined]) {
  const bound = args.length === 0 ? '13912345678' : args[0];
  const send = vi.fn(async (request: SmsRequest) => {
    void request;
    return OK;
  });
  const boundPhone = vi.fn(async (appId: string, uid: string) => {
    void appId;
    void uid;
    return bound;
  });
  return { send, boundPhone, service: createSmsCodeRequestService({ sms: { send }, boundPhone }) };
}

function body(value: object): Schema<'SendSmsCodeRequest'> {
  return value as Schema<'SendSmsCodeRequest'>;
}

it('[AC-B1-02zzz-UNIT#1] step_up sends to the bound phone of the token account, never a request number', async () => {
  const s = setup();
  const result = await s.service.send({
    body: body({ purpose: 'step_up', action: 'withdraw', captcha_token: 'cap' }),
    verifiedDevice: DEVICE,
    principal: PRINCIPAL,
    client_ip: '203.0.113.7',
  });
  expect(result).toEqual(OK);
  expect(s.boundPhone).toHaveBeenCalledWith('couli', 'u1');
  expect(s.send).toHaveBeenCalledWith({
    app_id: 'couli',
    phone: '13912345678',
    purpose: 'step_up',
    device_id: 'd1',
    client_ip: '203.0.113.7',
    captcha_token: 'cap',
    action: 'withdraw',
  });
});

it('[AC-B1-02zzz-UNIT#2] step_up refusals: no token 10001, other app 10403, any phone 20001 [phone], no user 10001, unbound 20001 [code]; nothing sent', async () => {
  const cases: [ReturnType<typeof setup>, object, TokenPrincipal | undefined, object][] = [
    [setup(), { purpose: 'step_up', action: 'account_deletion' }, undefined, { code: 10001 }],
    [
      setup(),
      { purpose: 'step_up', action: 'account_deletion' },
      { ...PRINCIPAL, app_id: 'other' },
      { code: 10403 },
    ],
    ...['13912345678', '', null].map(
      (phone): [ReturnType<typeof setup>, object, TokenPrincipal | undefined, object] => [
        setup(),
        { purpose: 'step_up', action: 'account_deletion', phone },
        PRINCIPAL,
        { code: 20001, data: { fields: ['phone'] } },
      ],
    ),
    [setup(undefined), { purpose: 'step_up' }, PRINCIPAL, { code: 10001 }],
    [setup(null), { purpose: 'step_up' }, PRINCIPAL, { code: 20001, data: { fields: ['code'] } }],
  ];
  for (const [s, value, principal, refused] of cases) {
    expect(
      await s.service.send({
        body: body(value),
        verifiedDevice: DEVICE,
        ...(principal === undefined ? {} : { principal }),
      }),
    ).toEqual({ refused });
    expect(s.send).not.toHaveBeenCalled();
  }
});

it('[AC-B1-02zzz-UNIT#3] login and bind keep the body phone, anonymous or logged in, and never read the bound phone', async () => {
  for (const purpose of ['login', 'bind'] as const) {
    for (const principal of [undefined, PRINCIPAL]) {
      const s = setup();
      expect(
        await s.service.send({
          body: body({ purpose, phone: '+86 137 0000 0001' }),
          verifiedDevice: DEVICE,
          ...(principal === undefined ? {} : { principal }),
        }),
      ).toEqual(OK);
      expect(s.send).toHaveBeenCalledWith({
        app_id: 'couli',
        phone: '+86 137 0000 0001',
        purpose,
        device_id: 'd1',
      });
      expect(s.boundPhone).not.toHaveBeenCalled();
    }
  }
  const s = setup();
  expect(await s.service.send({ body: body({ purpose: 'bind' }), verifiedDevice: DEVICE })).toEqual(
    { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } },
  );
  expect(s.send).not.toHaveBeenCalled();
});
