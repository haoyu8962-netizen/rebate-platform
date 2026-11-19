// B1-02zzzb (BR-ID-08 细则「绑定业务摘要」; BR-ID-33; payout AGENTS.md hard rule 8): neither the
// plaintext payout accounts sent in `summary` / the save body nor the digest itself reach a pino
// line or a response; the token carries only the fingerprint. Real AppModule, PG and Redis
// (kit.ts); the pino lines are the kit's in-memory root logger.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  LOGIN,
  NAME,
  TIMEOUT,
  bankBody,
  card,
  claimsOf,
  close,
  digestsOf,
  member,
  open,
  privateDataAbsent,
  reset,
  saveRefused,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
}, 120_000);
beforeEach(() => reset(kit));
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
}, TIMEOUT);

/** The HMAC part of a `p:<payout_method>:<HMAC>` digest. */
function fingerprintOf(digest: string): string {
  return digest.slice(digest.lastIndexOf(':') + 1);
}

it(
  '[AC-B1-02zzzb#9] 签发与比对全程：日志、响应与 token claims 不含明文收款账号 / 卡号 / 支付宝登录号，摘要原文不进日志与响应',
  async () => {
    const m = await member(kit);
    const logon = 'secret.payee@example.com';
    const other = 'other.payee@example.com';
    const digits = card(3);
    const otherCard = card(4);
    const forAlipay = await m.token('payout_account_change', {
      payout_method: 'alipay',
      alipay_logon_id: logon,
    });
    const forCard = await m.token('payout_account_change', {
      payout_method: 'bank_card',
      card_no: digits,
    });
    const alipayBody = { payout_method: 'alipay', alipay_logon_id: other, payee_name: NAME };
    saveRefused(kit, await m.save(alipayBody, forAlipay));
    saveRefused(kit, await m.save(bankBody(otherCard), forCard));
    const tokens = [forAlipay, forCard];
    const secrets = [logon, other, digits, otherCard, LOGIN];
    privateDataAbsent(kit, [...m.bodies, ...tokens.map((token) => claimsOf(token))], secrets);
    const digests = tokens.flatMap((token) => digestsOf(token));
    expect(digests).toHaveLength(2);
    // The fingerprints (and the digest strings) stay in the token: no log line, no response body.
    const fingerprints = digests.filter((digest) => digest.startsWith('p:')).map(fingerprintOf);
    expect(fingerprints).toHaveLength(2);
    privateDataAbsent(kit, m.bodies, [...digests, ...fingerprints]);
  },
  TIMEOUT,
);
