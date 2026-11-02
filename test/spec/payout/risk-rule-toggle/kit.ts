// B2-11f rule-test kit (规划/08 BR-ID-36 细则「规则清单的启停」, BR-WDR-29 ③ ⑨, BR-WDR-30 ⑫; rulings
// D10-536 (b), D10-537 ②, D10-566). The direct cases of risk's blocklist match reader: real rows,
// real status reader, time only through the injected FixedClock. The switch is set by writing
// app.risk_rules.status directly (the console's enable / disable is B1-03zg, after this task).
// Rule codes are written out by hand here, never read from risk's blocklistRule.
//
// The `rules` option of createBlocklistMatchReader does not exist before the implementation, so the
// factory is reached through a local type (task brief §9.2); nothing under apps/ changes. Only
// *.int.test.ts open the database and pass it in.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { CONTENT_CACHE_TTL_MS } from '../../../../apps/api/src/modules/content/domain/cache-policy.ts';
import type {
  RiskRuleKey,
  RiskRuleStatusReader,
} from '../../../../apps/api/src/modules/risk/application/risk-rule-status.ts';
import {
  createBlocklistMatchReader,
  type BlocklistMatchReader,
} from '../../../../apps/api/src/modules/risk/ports/blocklist-match.ts';
import { seedUser } from '../apply/kit.ts';

/** The refresh period of configuration items, which the rule status shares (BR-ID-36). */
export const TTL_MS = CONTENT_CACHE_TTL_MS;
/** 2026-10-19 (Monday) 10:00 +08:00. */
export const AT = '2026-10-19T02:00:00.000Z';
/** Later than every instant of these tests. */
const EXPIRES = new Date('2027-01-01T00:00:00.000Z');
export const SAME_DEVICE_RULE = 'SAME_DEVICE_MULTI_ACCOUNT';

export const DIMENSIONS = [
  'phone',
  'id_no',
  'device',
  'alipay',
  'bank_card',
  'wechat_openid',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** The rule of each dimension as the risk rule catalogue names it (BLACKLIST_<DIMENSION>). */
export const RULE_OF: Readonly<Record<Dimension, string>> = {
  phone: 'BLACKLIST_PHONE',
  id_no: 'BLACKLIST_ID_NO',
  device: 'BLACKLIST_DEVICE',
  alipay: 'BLACKLIST_ALIPAY',
  bank_card: 'BLACKLIST_BANK_CARD',
  wechat_openid: 'BLACKLIST_WECHAT_OPENID',
};

export type RuleStatus = 'enabled' | 'disabled' | 'active';
export type Violation = 'malicious_rights' | 'fraud_invite' | 'other';

/** Sets the status as the console would: the row is created when missing, else status + version. */
export async function setRule(
  db: Kysely<DB>,
  appId: string,
  ruleId: string,
  status: RuleStatus,
  at: Date,
): Promise<void> {
  const sameDevice = ruleId === SAME_DEVICE_RULE;
  await sql`INSERT INTO app.risk_rules AS r
      (id, app_id, rule_id, scene, conditions, risk_action, status, version, created_at, updated_at)
    VALUES (${randomUUID()}, ${appId}, ${ruleId}, ${sameDevice ? 'withdrawal' : 'withdraw'},
      '{}'::jsonb, ${sameDevice ? 'manual_review' : 'block'}, ${status}, 1, ${at}, ${at})
    ON CONFLICT (app_id, rule_id) DO UPDATE SET status = EXCLUDED.status,
      version = r.version + 1, updated_at = EXCLUDED.updated_at`.execute(db);
}

/** One active, unexpired blocklist row of the value. */
export async function block(
  db: Kysely<DB>,
  appId: string,
  dimension: Dimension,
  valueHmac: string,
  violation: Violation = 'other',
): Promise<void> {
  await sql`INSERT INTO app.blocklist
      (id, app_id, dimension, value_hmac, violation_type, expire_at, status, created_by)
    VALUES (${randomUUID()}, ${appId}, ${dimension}, ${valueHmac}, ${violation}, ${EXPIRES},
      'active', 'synthetic')`.execute(db);
}

export async function hitRows(db: Kysely<DB>, appId: string) {
  const { rows } = await sql<{
    rule_id: string;
    ref_type: string;
    ref_id: string;
  }>`SELECT rule_id, ref_type, ref_id FROM app.risk_hits WHERE app_id = ${appId} ORDER BY id`.execute(
    db,
  );
  return rows;
}

export async function judgementRows(db: Kysely<DB>, appId: string) {
  const { rows } = await sql<{
    rule_id: string;
    ref_id: string;
  }>`SELECT rule_id, ref_id FROM app.risk_judgements WHERE app_id = ${appId} ORDER BY id`.execute(
    db,
  );
  return rows;
}

type MatchFactory = (options?: { readonly rules?: RiskRuleStatusReader }) => BlocklistMatchReader;

/** The reader under test, with the status reader the implementation is to take. */
export function matchReader(rules: RiskRuleStatusReader): BlocklistMatchReader {
  return (createBlocklistMatchReader as unknown as MatchFactory)({ rules });
}

export interface RuleRead {
  readonly ruleKey: RiskRuleKey;
  readonly executor: Kysely<DB> | undefined;
}

/** `inner`, recording every read with the handle it was given. */
export function recording(inner: RiskRuleStatusReader): {
  rules: RiskRuleStatusReader;
  reads: RuleRead[];
} {
  const reads: RuleRead[] = [];
  return {
    reads,
    rules: {
      async isEnabled(ruleKey, executor) {
        reads.push({ ruleKey, executor });
        return inner.isEnabled(ruleKey, executor);
      },
    },
  };
}

/** A promise as a value, so that a rejection is asserted and never fails the test by itself. */
export async function settled<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Each dimension's value of a seeded member: distinct low-entropy digests. */
export const VALUES: Readonly<Record<Dimension, string>> = {
  phone: 'a'.repeat(64),
  id_no: 'b'.repeat(64),
  device: 'c'.repeat(64),
  alipay: 'd'.repeat(64),
  bank_card: 'd'.repeat(64),
  wechat_openid: 'd'.repeat(64),
};

const METHOD_OF: Readonly<Record<Dimension, 'alipay' | 'bank_card' | 'wechat'>> = {
  phone: 'alipay',
  id_no: 'alipay',
  device: 'alipay',
  alipay: 'alipay',
  bank_card: 'bank_card',
  wechat_openid: 'wechat',
};

/** A member of a fresh app with a phone digest, a verified id number and a device of their own. */
export async function seedMember(db: Kysely<DB>, at: Date) {
  const appId = `rule_toggle_${randomUUID()}`;
  const userId = await seedUser(db, appId);
  const deviceId = randomUUID();
  await sql`UPDATE app.users SET phone_hmac = ${VALUES.phone}
    WHERE app_id = ${appId} AND id = ${userId}`.execute(db);
  await sql`INSERT INTO app.realname
      (id, app_id, user_id, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, status,
       provider, verified_at)
    VALUES (${randomUUID()}, ${appId}, ${userId}, ${Buffer.from('synthetic')},
      ${Buffer.from('synthetic')}, ${VALUES.id_no}, ${Buffer.from('synthetic')}, 'verified',
      'synthetic', ${at})`.execute(db);
  await sql`INSERT INTO app.devices
      (id, app_id, user_id, device_hash, id_source, platform, app_version, last_seen_at,
       install_secret_cipher)
    VALUES (${deviceId}, ${appId}, ${userId}, ${VALUES.device}, 'idfv', 'ios', '1.0.0', ${at},
      ${Buffer.from('synthetic')})`.execute(db);
  return {
    appId,
    userId,
    deviceId,
    /** The reader's subject; the payee method follows the dimension under test. */
    subject(dimension: Dimension = 'phone') {
      return {
        appId,
        userId,
        deviceId,
        payeeHmac: VALUES.alipay,
        payoutMethod: METHOD_OF[dimension],
        now: at,
      };
    },
    block(dimension: Dimension, violation: Violation = 'other') {
      return block(db, appId, dimension, VALUES[dimension], violation);
    },
    setRule(dimension: Dimension, status: RuleStatus) {
      return setRule(db, appId, RULE_OF[dimension], status, at);
    },
  };
}
