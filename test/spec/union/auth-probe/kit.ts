// B1-22b: SPEC_REF eabcf00, BR-ID-24 and BR-TEXT-20, task §9 adjudications.
// All platform outcomes are injected classifications, never fabricated platform responses.
import { createHmac, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { vi } from 'vitest';
import type { ConfigValue } from '../../../../apps/api/src/modules/content/index.ts';
import type { SiteAuthAlertPort } from '../../../../apps/api/src/modules/notification/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import type { FieldCrypto, JobQueue } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createSiteAuthMonitor,
  type SiteAuthMonitorOptions,
  type SiteAuthProbe,
  type SiteAuthRefresher,
} from '../../../../apps/api/src/modules/union/index.ts';
import { memoryLogger } from '../../platform/queue/kit.ts';

export const NOW = '2026-12-16T01:00:00.000Z';
export const EXPIRES = '2026-12-29T16:00:00.000Z';
export const PHONES = ['13800138000', '13900139000'] as const;
export const PHONE_CONTEXT = 'union.auth_alert_phones';

// Opaque in-memory crypto double. It detects the wrong context and never embeds plaintext
// in ciphertext. These are synthetic phones, not credentials or a production keyring.
export function cryptoDouble() {
  const values = new Map<string, { plaintext: string; context: string }>();
  const crypto: FieldCrypto = {
    currentKeyVersion: 1,
    encrypt: vi.fn((plaintext: string, context: string) => {
      const cipher = `fixture-${randomUUID()}`;
      values.set(cipher, { plaintext, context });
      return cipher;
    }),
    decrypt: vi.fn((cipher: string, context: string) => {
      const stored = values.get(cipher);
      if (stored?.context !== context) throw new Error('fixture wrong crypto context');
      return stored.plaintext;
    }),
    blindIndex: vi.fn((value: string, context: string) =>
      createHmac('sha256', 'synthetic-test-only').update(`${context}:${value}`).digest('hex'),
    ),
    keyVersionOf: () => 1,
    needsReencrypt: () => false,
    reencrypt: (cipher, context) => crypto.encrypt(crypto.decrypt(cipher, context), context),
  };
  return crypto;
}

export function harness(db: Kysely<DB>, at = NOW) {
  const appId = `auth-probe-${randomUUID()}`;
  const clock = new FixedClock(at);
  const { logger, lines } = memoryLogger('worker');
  const crypto = cryptoDouble();
  const settings = new Map<string, ConfigValue>([
    ['union.auth_alert_phones', { cipher: crypto.encrypt(JSON.stringify(PHONES), PHONE_CONTEXT) }],
  ]);
  const configValue = vi.fn<SiteAuthMonitorOptions['config']['configValue']>(async (app, key) => {
    const value = app === appId ? settings.get(key) : undefined;
    return value === undefined ? null : { value, version: 1 };
  });
  const probe = vi.fn<SiteAuthProbe['probe']>(async (account) =>
    account.appId === appId ? { kind: 'ok' } : { kind: 'unsupported' },
  );
  const refresh = vi.fn<SiteAuthRefresher['refresh']>(async () => ({
    ok: false,
    error: 'unavailable',
  }));
  const send = vi.fn<JobQueue['send']>(async () => randomUUID());
  const plan = vi.fn<SiteAuthAlertPort['plan']>(async (_trx, input) => input.phoneIds.length);
  const deliver = vi.fn<SiteAuthAlertPort['deliver']>(async () => undefined);
  const options: SiteAuthMonitorOptions = {
    db,
    clock,
    logger,
    crypto,
    config: { configValue },
    probe: { probe },
    queue: { send },
    alerts: { plan, deliver },
  };
  // Construct outside any rejection assertion, before SQL using the B1-22a schema.
  const monitor = createSiteAuthMonitor(options);
  return {
    db,
    appId,
    clock,
    logger,
    lines,
    crypto,
    settings,
    configValue,
    probe,
    refresh,
    send,
    plan,
    deliver,
    options,
    monitor,
  };
}
export type Harness = ReturnType<typeof harness>;
export async function account(
  h: Pick<Harness, 'db' | 'appId' | 'clock'>,
  values: Partial<Insertable<DB['union_accounts']>> = {},
) {
  return h.db
    .insertInto('union_accounts')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      platform: 'taobao',
      account_name: 'synthetic site',
      status: 'active',
      auth_status: 'active',
      auth_expires_at: EXPIRES,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
      ...values,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export function stored(h: Pick<Harness, 'db' | 'appId'>, id: string) {
  return h.db
    .selectFrom('union_accounts')
    .selectAll()
    .where('app_id', '=', h.appId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}
export function plans(h: Harness) {
  return h.plan.mock.calls.filter(([, p]) => p.appId === h.appId).map(([, p]) => p);
}
export function jobs(h: Harness, accountId: string) {
  return h.send.mock.calls.filter((call) => JSON.stringify(call.slice(0, 3)).includes(accountId));
}
export function logs(h: Pick<Harness, 'lines' | 'appId'>, message: string) {
  return h.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.app_id === h.appId && line.msg === message);
}
export function notifications(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('notify_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('dedupe_key')
    .execute();
}
