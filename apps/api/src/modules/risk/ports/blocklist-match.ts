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
// B2-05q (BR-ID-36): match() is the same walk (same order, the same single status read per
// dimension looked at) and also names what hit — the dimension, its value digest and the rule code
// — so that the caller can record the decided hit without judging or reading the status again.
// read() keeps its answer: the text code only.
// B1-03zj (BR-WDR-29 ⑨, D10-731 ①): `deviceIds`, when given, stands for `deviceId` — every device
// of the member (⑨ asks over all devices of the member's sessions). The walk keeps its order, with
// the device step looking at each listed device's hash in the order given: phone → id_no → each
// device → payee account, so ⑨ names the dimension ③a would; each dimension's rule status is still
// read at most once per walk, and everything stays on the caller's handle.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { blocklistRule } from '../application/blocklist.ts';
import type { BlockedHitTarget } from '../application/blocklist.ts';
import type { RiskRuleStatusReader } from '../application/risk-rule-status.ts';

/** Risk resolves identity-owned HMACs via its existing identity ports. */
export interface BlocklistMatchReader {
  read(
    handle: Kysely<DB>,
    subject: {
      appId: string;
      userId: string;
      deviceId: string;
      /**
       * B1-03zj: the devices to look at in place of `deviceId` (in this order, duplicates looked
       * at once); `deviceId` is then not read. An empty list looks at no device.
       */
      deviceIds?: readonly string[];
      payeeHmac: string | null;
      payoutMethod: 'alipay' | 'bank_card' | 'wechat' | null;
      now: Date;
    },
  ): Promise<{ risk_msg_code: string } | null>;
  /**
   * B2-05q (BR-ID-36): read()'s decision together with its target (dimension, value digest, rule
   * code) for hit recording; legacy readers may omit this member.
   */
  match?(
    handle: Kysely<DB>,
    subject: Parameters<BlocklistMatchReader['read']>[1],
  ): Promise<{ risk_msg_code: string; hit: BlockedHitTarget } | null>;
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

  /** The first dimension in force with an active entry, in the fixed order; null without one. */
  async function decide(
    handle: Kysely<DB>,
    subject: Parameters<BlocklistMatchReader['read']>[1],
  ): Promise<{ risk_msg_code: string; hit: BlockedHitTarget } | null> {
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
    const deviceIds = [...new Set(subject.deviceIds ?? [subject.deviceId])];
    if (deviceIds.length > 0) {
      const devices = await app
        .selectFrom('devices')
        .select(['id', 'device_hash'])
        .where('app_id', '=', subject.appId)
        .where('id', 'in', deviceIds)
        .execute();
      const hashOf = new Map(devices.map((row) => [row.id, row.device_hash]));
      for (const id of deviceIds) {
        const hash = hashOf.get(id);
        if (hash) values.push({ dimension: 'device', hmac: hash });
      }
    }
    if (subject.payeeHmac !== null && subject.payoutMethod !== null) {
      values.push({ dimension: PAYEE_DIMENSION[subject.payoutMethod], hmac: subject.payeeHmac });
    }
    // One status read per dimension looked at, however many devices the device step has.
    const inForce = new Map<Dimension, boolean>();
    const looked = new Set<string>();
    for (const { dimension, hmac } of values) {
      const ruleId = blocklistRule(dimension);
      if (rules !== undefined) {
        let enabled = inForce.get(dimension);
        if (enabled === undefined) {
          enabled = await rules.isEnabled({ app_id: subject.appId, rule_id: ruleId }, handle);
          inForce.set(dimension, enabled);
        }
        if (!enabled) continue;
      }
      const seen = `${dimension}:${hmac}`;
      if (looked.has(seen)) continue;
      looked.add(seen);
      const violation = await match(handle, subject.appId, dimension, hmac, subject.now);
      if (violation !== null) {
        return {
          risk_msg_code: `blocklist.${violation}`,
          hit: { dimension, value_hmac: hmac, rule_id: ruleId },
        };
      }
    }
    return null;
  }

  return {
    async read(handle, subject) {
      const decided = await decide(handle, subject);
      return decided === null ? null : { risk_msg_code: decided.risk_msg_code };
    },
    match: decide,
  };
}
