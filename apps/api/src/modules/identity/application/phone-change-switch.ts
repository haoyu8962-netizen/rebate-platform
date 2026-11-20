// The self-service phone change switch `account.phone_change_enabled` (08 BR-ID-06 正文与细则
// 「开关的客户端副本」, BR-ID-05 发码判定顺序; task B1-20b, D10-2189). Only a stored value that is the
// JSON boolean false turns the change off; a missing key, a missing reader and any other value
// (the string "false" included) leave it on. First bindings never read it.
//
// Three places judge it: POST /v1/me/phone for an account that already has a phone (the final
// judgement, bind-phone.ts), POST /v1/auth/sms-codes purpose=step_up action=phone_change
// (sms-code-requests.ts) and POST /v1/auth/step-up action=phone_change (step-up.ts). The read is
// content's uncached reader on the given handle (identity.module assembles it from the landing
// configuration port), so a change applies to the next request.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { LandingRegisterConfigReader } from '../ports/landing-invite.ts';

/** Configuration key of the switch (BR-ID-06). */
export const PHONE_CHANGE_ENABLED_KEY = 'account.phone_change_enabled';

/** The refusal of a phone change while the switch is off (error 30414, HTTP 422). */
export const PHONE_CHANGE_DISABLED = Object.freeze({ code: 30414 } as const);
/** error.30414 of contracts/texts.default.json. */
export const PHONE_CHANGE_DISABLED_MSG = '暂不支持自助更换手机号，请联系客服';

export interface PhoneChangeSwitch {
  /** False only when the app's configured value is the boolean false. */
  enabled(appId: string, handle?: Kysely<DB>): Promise<boolean>;
}

/** Whether a stored configuration value turns the change off. */
export function phoneChangeDisabledBy(value: unknown): boolean {
  return value === false;
}

/**
 * The switch read through `reader` on `handle` (default `db`). Without a reader or a handle the key
 * counts as missing: the change stays on (BR-ID-06 缺键按开启).
 */
export function createPhoneChangeSwitch(
  reader: LandingRegisterConfigReader | null,
  db: Kysely<DB> | undefined,
): PhoneChangeSwitch {
  return Object.freeze({
    async enabled(appId: string, handle?: Kysely<DB>): Promise<boolean> {
      const on = handle ?? db;
      if (reader === null || on === undefined) return true;
      const entry = await reader.configValue(appId, PHONE_CHANGE_ENABLED_KEY, on);
      return !phoneChangeDisabledBy(entry?.value);
    },
  });
}
