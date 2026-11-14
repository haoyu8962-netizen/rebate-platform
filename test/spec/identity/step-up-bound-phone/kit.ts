// Reuse the real HTTP entry, guards, database, Redis, field encryption and fake SMS adapter.
// No replacement for the controller or the phone-selection code under test.
import { expect } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { outbox } from '../sms-codes/http-kit.ts';
import {
  fixture,
  type Fixture,
  type HttpKit,
  accepted,
  rejected as baseRejected,
  validate,
} from '../step-up/http-kit.ts';

export { openHttpKit, closeHttpKit, type HttpKit } from '../step-up/http-kit.ts';
type Response = Parameters<typeof validate>[2];
export function rejected(
  kit: HttpKit,
  path: string,
  response: Response,
  code: number,
  data?: object,
): void {
  if (code !== 10405) {
    baseRejected(kit, path, response, code, data);
    return;
  }
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ code, ...(data === undefined ? {} : { data }) });
  validate(kit, path, response);
}
export const SMS = '/v1/auth/sms-codes';
export const ACTIONS = [
  'withdraw',
  'payout_account_change',
  'phone_change',
  'account_deletion',
] as const;

export async function account(kit: HttpKit, bound = true): Promise<Fixture> {
  const f = await fixture(kit, bound);
  await f.db
    .insertInto('config_items')
    .values({
      app_id: f.appId,
      key: 'account.phone_change_enabled',
      value: JSON.stringify(true),
      version: 1,
      updated_by: 'fixture',
    })
    .execute();
  return f;
}

export function messages(f: Fixture) {
  return outbox(f.kit.app).filter((message) => message.app_id === f.appId);
}

export async function sendBound(f: Fixture, action: string = 'account_deletion') {
  const response = await f.post(SMS, { purpose: 'step_up', action });
  expect(accepted(f.kit, SMS, response)).toEqual({ resend_after_sec: 60, expires_in_sec: 300 });
  const sent = messages(f);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ app_id: f.appId, phone: f.number, purpose: 'step_up' });
  expect(sent[0]!.code).toMatch(/^\d{6}$/);
  return sent[0]!;
}

export async function restrictedSession(f: Fixture) {
  return f.db.transaction().execute((trx) =>
    createSession(
      trx,
      {
        uid: f.uid,
        app_id: f.appId,
        device_id: f.device.deviceId,
        scp: 'deletion_only',
      },
      { clock: f.kit.clock, tokens: f.tokens },
    ),
  );
}
