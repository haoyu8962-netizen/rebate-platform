// Unit tests of the phone change switch (B1-20b, BR-ID-06) and its early 30414 at the public send
// (BR-ID-05), without Redis or a database: the configuration reader and the SMS service are stubs.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { TokenPrincipal } from '../../platform/index.ts';
import type { LandingRegisterConfigReader } from '../ports/landing-invite.ts';
import {
  PHONE_CHANGE_ENABLED_KEY,
  createPhoneChangeSwitch,
  phoneChangeDisabledBy,
} from './phone-change-switch.ts';
import { createSmsCodeRequestService } from './sms-code-requests.ts';

const POOL = { pool: true } as unknown as Kysely<DB>;
const TRX = { trx: true } as unknown as Kysely<DB>;

function reader(value: unknown) {
  return vi.fn<LandingRegisterConfigReader['configValue']>(async () =>
    value === undefined ? null : { value, version: 1 },
  );
}

it('[AC-B1-20b-UNIT#1] only the boolean false turns the change off', () => {
  expect(phoneChangeDisabledBy(false)).toBe(true);
  for (const value of [true, 'false', 0, null, undefined, {}, []]) {
    expect(phoneChangeDisabledBy(value)).toBe(false);
  }
});

it('[AC-B1-20b-UNIT#2] reads the key on the given handle, else the pool; no reader or key → on', async () => {
  const off = reader(false);
  const flag = createPhoneChangeSwitch({ configValue: off }, POOL);
  expect(await flag.enabled('couli')).toBe(false);
  expect(off).toHaveBeenLastCalledWith('couli', PHONE_CHANGE_ENABLED_KEY, POOL);
  expect(await flag.enabled('couli', TRX)).toBe(false);
  expect(off).toHaveBeenLastCalledWith('couli', PHONE_CHANGE_ENABLED_KEY, TRX);
  expect(await createPhoneChangeSwitch({ configValue: reader(undefined) }, POOL).enabled('a')).toBe(
    true,
  );
  expect(await createPhoneChangeSwitch({ configValue: reader('false') }, POOL).enabled('a')).toBe(
    true,
  );
  expect(await createPhoneChangeSwitch(null, POOL).enabled('a')).toBe(true);
  expect(await createPhoneChangeSwitch({ configValue: off }, undefined).enabled('a')).toBe(true);
});

const PRINCIPAL: TokenPrincipal = {
  uid: 'u1',
  app_id: 'couli',
  sid: 's1',
  device_id: 'd1',
  scp: 'full',
};
const DEVICE = { deviceId: 'd1', appId: 'couli' };

function sendService(enabled: boolean) {
  const send = vi.fn(async () => ({
    code: 0 as const,
    data: { resend_after_sec: 60, expires_in_sec: 300 },
  }));
  const boundPhone = vi.fn(async () => '13912345678');
  const phoneChange = { enabled: vi.fn(async () => enabled) };
  return {
    send,
    boundPhone,
    phoneChange,
    service: createSmsCodeRequestService({ sms: { send }, boundPhone, phoneChange }),
  };
}

it('[AC-B1-20b-UNIT#3] step_up phone_change while off → 30414 before the phone check; nothing read or sent', async () => {
  const s = sendService(false);
  const result = await s.service.send({
    body: {
      purpose: 'step_up',
      action: 'phone_change',
      phone: 'x',
    } as Schema<'SendSmsCodeRequest'>,
    verifiedDevice: DEVICE,
    principal: PRINCIPAL,
  });
  expect(result).toEqual({ refused: { code: 30414 } });
  expect(s.phoneChange.enabled).toHaveBeenCalledWith('couli');
  expect(s.boundPhone).not.toHaveBeenCalled();
  expect(s.send).not.toHaveBeenCalled();
});

it('[AC-B1-20b-UNIT#4] other actions never read the switch; phone_change while on sends', async () => {
  const off = sendService(false);
  await off.service.send({
    body: { purpose: 'step_up', action: 'account_deletion' } as Schema<'SendSmsCodeRequest'>,
    verifiedDevice: DEVICE,
    principal: PRINCIPAL,
  });
  expect(off.phoneChange.enabled).not.toHaveBeenCalled();
  expect(off.send).toHaveBeenCalledTimes(1);
  const on = sendService(true);
  const result = await on.service.send({
    body: { purpose: 'step_up', action: 'phone_change' } as Schema<'SendSmsCodeRequest'>,
    verifiedDevice: DEVICE,
    principal: PRINCIPAL,
  });
  expect(result).toMatchObject({ code: 0 });
  expect(on.send).toHaveBeenCalledTimes(1);
});
