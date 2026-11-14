// The public send of POST /v1/auth/sms-codes (04 §6.1 sendSmsCode, x-auth optional; BR-ID-05,
// BR-ID-08; task B1-02zzz): which number a code goes to, before SmsCodeService.send.
//
// - purpose=login / bind: unchanged, anonymous or logged in — the code goes to the body's `phone`
//   (the contract requires it; its normalisation and every check stay SmsCodeService.send's).
// - purpose=step_up: the caller's own token only (stage ② principal; none → 10001; a principal of
//   another app than the verified device → 10403, as stage ③ already answers). The body must not
//   carry `phone` at all (any value, null and '' included → 20001 fields=[phone], nothing read,
//   nothing sent, nothing counted). The number is the token account's current users.phone_cipher,
//   read from the database on every send and decrypted here: never the request, the device or the
//   session. A token whose user row is gone → 10001 (it identifies no user, as oauth-attempts
//   answers it). No bound phone → 20001 fields=[code], no SMS: the same answer POST
//   /v1/auth/step-up gives such an account, which verifies by a new third-party authorization
//   (BR-ID-08, POST /v1/auth/oauth-attempts). Then SmsCodeService.send runs with that number, so
//   the per-phone limits (and the 60 s interval across devices and actions) count against it, and
//   POST /v1/auth/step-up checks the code against the same bound number and purpose.
// The session scope (deletion_only) and the version gate are stage ④a's (risk), before this.
// Nothing is logged here: no phone in any form, no code, no captcha_token.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { FieldCrypto, TokenPrincipal, VerifiedDevice } from '../../platform/index.ts';
import { PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';
import type { SmsCodeService, SmsResult } from './sms-codes.ts';

export interface SmsCodeRequestCommand {
  /** The schema-checked body; read as a record too, to see a `phone` the schema let through. */
  readonly body: Schema<'SendSmsCodeRequest'>;
  readonly verifiedDevice: VerifiedDevice;
  readonly principal?: TokenPrincipal;
  readonly client_ip?: string;
}

/** A step_up refusal decided here, before SmsCodeService.send (identity's error envelopes). */
export type StepUpSendRefusal =
  | { readonly code: 10001 | 10403 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } };

export type SmsCodeRequestResult = SmsResult | { readonly refused: StepUpSendRefusal };

export interface SmsCodeRequestService {
  send(command: SmsCodeRequestCommand): Promise<SmsCodeRequestResult>;
}

/** The account's bound phone: undefined without a user row, null when no phone is bound. */
export type BoundPhoneReader = (appId: string, uid: string) => Promise<string | null | undefined>;

/** Reads users.phone_cipher of (app, uid) and decrypts it; the number is not cached anywhere. */
export function createBoundPhoneReader(
  db: Kysely<DB>,
  crypto: Pick<FieldCrypto, 'decrypt'>,
): BoundPhoneReader {
  return async (appId, uid) => {
    const row = await db
      .withSchema('app')
      .selectFrom('users')
      .select(['phone_hmac', 'phone_cipher'])
      .where('app_id', '=', appId)
      .where('id', '=', uid)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    if (row.phone_hmac === null || row.phone_cipher === null) return null;
    return crypto.decrypt(row.phone_cipher.toString('utf8'), PHONE_CIPHER_CONTEXT);
  };
}

export function createSmsCodeRequestService(options: {
  readonly sms: Pick<SmsCodeService, 'send'>;
  readonly boundPhone: BoundPhoneReader;
}): SmsCodeRequestService {
  const { sms, boundPhone } = options;
  return {
    async send(command) {
      const { body, verifiedDevice, principal, client_ip: clientIp } = command;
      const { purpose, captcha_token: captchaToken, action } = body;
      const appId = verifiedDevice.appId;
      let phone: string | undefined = body.phone;
      if (purpose === 'step_up') {
        if (principal === undefined) return { refused: { code: 10001 } };
        if (principal.app_id !== appId) return { refused: { code: 10403 } };
        if (Object.prototype.hasOwnProperty.call(body, 'phone')) {
          return { refused: { code: 20001, data: { fields: ['phone'] } } };
        }
        const bound = await boundPhone(appId, principal.uid);
        if (bound === undefined) return { refused: { code: 10001 } };
        if (bound === null) return { refused: { code: 20001, data: { fields: ['code'] } } };
        phone = bound;
      }
      // login / bind: the contract requires `phone`; a body without one is refused like an
      // invalid number (no SMS, nothing counted).
      if (phone === undefined) {
        return { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } };
      }
      return sms.send({
        app_id: appId,
        phone,
        purpose,
        device_id: verifiedDevice.deviceId,
        ...(clientIp === undefined ? {} : { client_ip: clientIp }),
        ...(captchaToken === undefined ? {} : { captcha_token: captchaToken }),
        ...(action === undefined ? {} : { action }),
      });
    },
  };
}
