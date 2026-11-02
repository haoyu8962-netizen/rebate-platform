// Risk's read-only blocklist match for the withdrawal rules (task B2-05c; BR-WDR-03 ③a, BR-ID-31):
// any of the member's phone HMAC (users.phone_hmac), id-number HMAC (realname.id_no_hmac of the
// verified record), the device hash of the device asked about (devices.device_hash; D10-571 B1-03zi:
// the row is found by app_id and id only, the deviceId comes from the verified token or from the
// member's sessions, and devices.user_id is never written) or the current payout account's HMAC
// (dimension alipay / bank_card / wechat_openid by
// payout method) on an ACTIVE, unexpired blocklist entry of the same app → the hit's text code
// `blocklist.<violation_type>` (04 §7, as the blocklist service answers 44001). Everything on the
// caller's handle (READ ONLY transactions included), `now` from the caller's Clock; nothing is
// written: the hit record of a refused request is the caller's to write outside its transaction
// (BlocklistService.recordHits). Dimension order: phone → id_no → device → payee account.
// B2-11f (BR-ID-36, D10-537 ②): a dimension whose rule BLACKLIST_<DIMENSION> is disabled is skipped and
// the next one is looked at; the answer keeps its shape. The state is read on the caller's handle; a
// failed read rejects, it never counts as disabled. Without `rules` every dimension is in force.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { blocklistRule } from '../application/blocklist.ts';
import type { RiskRuleStatusReader } from '../application/risk-rule-status.ts';

/** Risk resolves identity-owned HMACs via its existing identity ports. */
export interface BlocklistMatchReader {
  read(
    handle: Kysely<DB>,
    subject: {
      appId: string;
      userId: string;
      deviceId: string;
      payeeHmac: string | null;
      payoutMethod: 'alipay' | 'bank_card' | 'wechat' | null;
      now: Date;
    },
  ): Promise<{ risk_msg_code: string } | null>;
}

type Dimension = 'phone' | 'id_no' | 'device' | 'alipay' | 'bank_card' | 'wechat_openid';

const PAYEE_DIMENSION: Readonly<Record<'alipay' | 'bank_card' | 'wechat', Dimension>> = {
  alipay: 'alipay',
  bank_card: 'bank_card',
  wechat: 'wechat_openid',
};

export interface BlocklistMatchReaderOptions {
  readonly rules?: RiskRuleStatusReader;
}

export function createBlocklistMatchReader(
  options: BlocklistMatchReaderOptions = {},
): BlocklistMatchReader {
  const { rules } = options;
  async function match(
    handle: Kysely<DB>,
    appId: string,
    dimension: Dimension,
    valueHmac: string,
    now: Date,
  ): Promise<string | null> {
    const row = await handle
      .withSchema('app')
      .selectFrom('blocklist')
      .select('violation_type')
      .where('app_id', '=', appId)
      .where('dimension', '=', dimension)
      .where('value_hmac', '=', valueHmac)
      .where('status', '=', 'active')
      .where('expire_at', '>', now)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.violation_type ?? null;
  }

  return {
    async read(handle, subject) {
      const app = handle.withSchema('app');
      const values: { dimension: Dimension; hmac: string }[] = [];
      const user = await app
        .selectFrom('users')
        .select('phone_hmac')
        .where('app_id', '=', subject.appId)
        .where('id', '=', subject.userId)
        .executeTakeFirst();
      if (user?.phone_hmac) values.push({ dimension: 'phone', hmac: user.phone_hmac });
      const realname = await app
        .selectFrom('realname')
        .select('id_no_hmac')
        .where('app_id', '=', subject.appId)
        .where('user_id', '=', subject.userId)
        .where('status', '=', 'verified')
        .executeTakeFirst();
      if (realname?.id_no_hmac) values.push({ dimension: 'id_no', hmac: realname.id_no_hmac });
      const device = await app
        .selectFrom('devices')
        .select('device_hash')
        .where('app_id', '=', subject.appId)
        .where('id', '=', subject.deviceId)
        .executeTakeFirst();
      if (device?.device_hash) values.push({ dimension: 'device', hmac: device.device_hash });
      if (subject.payeeHmac !== null && subject.payoutMethod !== null) {
        values.push({ dimension: PAYEE_DIMENSION[subject.payoutMethod], hmac: subject.payeeHmac });
      }
      for (const { dimension, hmac } of values) {
        if (rules !== undefined) {
          const key = { app_id: subject.appId, rule_id: blocklistRule(dimension) };
          if (!(await rules.isEnabled(key, handle))) continue;
        }
        const violation = await match(handle, subject.appId, dimension, hmac, subject.now);
        if (violation !== null) return { risk_msg_code: `blocklist.${violation}` };
      }
      return null;
    },
  };
}
