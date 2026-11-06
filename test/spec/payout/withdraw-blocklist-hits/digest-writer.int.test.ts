import { randomBytes } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createBlocklistService,
  type RecordDigestBlockedHit,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { UUID_V7 } from '../../risk/blocklist/kit.ts';
import { close, fixture, hits, open, rule, type Harness } from './db-kit.ts';

let h: Harness;
let crypto: FieldCrypto;
beforeAll(async () => {
  h = await open(createTestDatabase);
  const provider = new LocalKeyProvider(randomBytes(32));
  crypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
}, 120_000);
afterAll(async () => {
  await close(h);
}, 60_000);

it.each([
  { label: '无关联手机号，两列同空', digest: null },
  {
    label: '已有手机号摘要与脱敏号，两列原样保存',
    digest: { hmac: '8'.repeat(64), masked: '138****8000' },
  },
])(
  '[AC-B2-05q#8][BR-ID-36] $label：已判定的提现拦截即使规则停用仍留痕，不改规则',
  async ({ digest }) => {
    const f = await fixture(h);
    const appId = f.actor.appId;
    await rule({ db: h.db, clock: f.clock }, appId, 'device', 'disabled');
    const rules = () =>
      h.db
        .withSchema('app')
        .selectFrom('risk_rules')
        .selectAll()
        .where('app_id', '=', appId)
        .execute();
    const before = await rules();
    expect(before).toEqual([
      expect.objectContaining({ rule_id: 'BLACKLIST_DEVICE', status: 'disabled' }),
    ]);
    const lines: string[] = [];
    const logger = createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (chunk: string) => void lines.push(chunk) },
    );
    const service = createBlocklistService({ db: h.db, clock: f.clock, crypto, logger });
    const input: RecordDigestBlockedHit = {
      app_id: appId,
      request_type: 'withdraw',
      user_id: f.actor.userId,
      amount_fen: 1300n,
      related_phone_digest: digest,
      dimension: 'device',
      value_hmac: '9'.repeat(64),
      rule_id: 'BLACKLIST_DEVICE',
    };
    // Turn unsupported digest input into an assertion failure, without attaching its error as
    // a cause: red-check must not mistake an internal TypeError for a valid red test.
    const outcome = await Promise.resolve()
      .then(() => service.recordDecidedHit!(input))
      .then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      );
    expect(outcome).toEqual({
      ok: true,
      value: { ref_id: expect.stringMatching(UUID_V7) },
    });
    expect(await hits(h, appId)).toEqual([
      expect.objectContaining({
        app_id: appId,
        user_id: f.actor.userId,
        amount_fen: 1300n,
        ref_type: 'blocked_request',
        ref_id: outcome.ok ? outcome.value.ref_id : undefined,
        request_type: 'withdraw',
        risk_action: 'block',
        dimension: input.dimension,
        value_hmac: input.value_hmac,
        rule_id: input.rule_id,
        created_at: f.clock.now(),
        related_phone_hmac: digest?.hmac ?? null,
        related_phone_masked: digest?.masked ?? null,
      }),
    ]);
    expect(await rules()).toEqual(before);
  },
);
