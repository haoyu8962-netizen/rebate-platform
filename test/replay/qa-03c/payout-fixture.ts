// Test infrastructure: capture the production application services without replacing their logic.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import type { Clock, EventBus, RootLogger } from '../../../apps/api/src/modules/platform/index.ts';
import type { FieldCrypto } from '../../../apps/api/src/modules/platform/crypto/index.ts';
import type { WithdrawApplyService } from '../../../apps/api/src/modules/payout/application/withdraw-apply.ts';
import type { WithdrawRulesService } from '../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import type { startReplay } from '../qa-03a/driver.ts';

type FactoryArgs = [Clock, RootLogger, Kysely<DB>?, FieldCrypto?, EventBus?];
interface Factory<T> {
  useFactory(...args: FactoryArgs): T | null;
}

/** URL import keeps Nest's decorated graph outside the rule-test TypeScript project. */
export async function capturePayout() {
  const { PayoutModule } = (await import(
    new URL('../../../apps/api/src/modules/payout/index.ts', import.meta.url).href
  )) as {
    PayoutModule: {
      forRoot(options?: {
        apply?: Factory<WithdrawApplyService>;
        rules?: Factory<WithdrawRulesService>;
      }): unknown;
    };
  };
  const captured: {
    apply?: WithdrawApplyService;
    rules?: WithdrawRulesService;
    crypto?: FieldCrypto;
    eventBus?: EventBus;
  } = {};
  const original = PayoutModule.forRoot.bind(PayoutModule);
  const apiSpy = vi.spyOn(PayoutModule, 'forRoot').mockImplementation((options) => {
    if (options?.apply === undefined || options.rules === undefined) return original(options);
    const apply = options.apply;
    const rules = options.rules;
    return original({
      ...options,
      apply: {
        ...apply,
        useFactory(...args) {
          const service = apply.useFactory(...args);
          if (service !== null) captured.apply = service;
          if (args[3] !== undefined) captured.crypto = args[3];
          if (args[4] !== undefined) captured.eventBus = args[4];
          return service;
        },
      },
      rules: {
        ...rules,
        useFactory(...args) {
          const service = rules.useFactory(...args);
          if (service !== null) captured.rules = service;
          return service;
        },
      },
    });
  });
  const { AppModule } = (await import(
    new URL('../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as {
    AppModule: { forEntry(options: { entry: string; config: { keyring: unknown } }): unknown };
  };
  const originalEntry = AppModule.forEntry.bind(AppModule);
  let keyring: unknown;
  const cryptoSpy = vi.spyOn(AppModule, 'forEntry').mockImplementation((options) => {
    if (options.entry === 'api') keyring = options.config.keyring;
    if (options.entry !== 'worker') return originalEntry(options);
    // QA-03a / b provision different ephemeral keyrings. Share the API fixture keyring with
    // every worker reader, just as deployed processes share it; no business port is replaced.
    expect(keyring).toBeDefined();
    return originalEntry({ ...options, config: { ...options.config, keyring } });
  });
  return {
    ready() {
      expect(captured.apply).toBeDefined();
      expect(captured.rules).toBeDefined();
      expect(captured.crypto).toBeDefined();
      expect(captured.eventBus).toBeDefined();
      return {
        apply: captured.apply!,
        rules: captured.rules!,
        crypto: captured.crypto!,
        eventBus: captured.eventBus!,
      };
    },
    restore() {
      cryptoSpy.mockRestore();
      apiSpy.mockRestore();
    },
  };
}

export async function seedPayee(h: Awaited<ReturnType<typeof startReplay>>, crypto: FieldCrypto) {
  const { db, appId, userId, clock } = h;
  const name = '合成回放姓名';
  const account = 'qa03c@example.test';
  const device = await db
    .selectFrom('devices')
    .select('id')
    .where('app_id', '=', appId)
    .executeTakeFirstOrThrow();
  const encrypt = (value: string, context: string) => Buffer.from(crypto.encrypt(value, context));
  await db
    .insertInto('realname')
    .values({
      id: randomUUID(),
      app_id: appId,
      user_id: userId,
      status: 'verified',
      name_cipher: encrypt(name, 'realname.name'),
      id_no_cipher: encrypt(userId, 'realname.id_no'),
      id_no_hmac: crypto.blindIndex(userId, 'realname.id_no'),
      birth_date_cipher: encrypt('1990-01-01', 'realname.birth_date'),
      provider: 'synthetic',
      verified_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('payout_accounts')
    .values({
      id: randomUUID(),
      app_id: appId,
      user_id: userId,
      payout_method: 'alipay',
      is_current: true,
      payee_name: name,
      alipay_hmac: crypto.blindIndex(account, 'payout_accounts.alipay'),
      alipay_logon_id_cipher: encrypt(account, 'payout_accounts.alipay'),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await sql`INSERT INTO app.consent_records
    (app_id,subject_type,user_id,device_id,type,version,accepted,channel,text_sha256,signer_snapshot,client_at,server_at)
    VALUES (${appId},'user',${userId},${device.id},'labor_agreement',1,true,'withdraw_flow',${'a'.repeat(64)},
      '{}'::jsonb,${clock.now()},${clock.now()})`.execute(db);
  const config: Record<string, unknown> = {
    'legal.labor_agreement.version': 1,
    'legal.labor_agreement.text_url': 'https://example.test/qa03c/labor',
    'legal.labor_agreement.text_sha256': 'a'.repeat(64),
    'legal.labor_agreement.resign_from_version': 1,
    'withdraw.auto_payout.enabled': true,
    'withdraw.auto_payout.first_withdrawal_limit_enabled': false,
    // One of three orders is invalid. Set an explicit 100% test threshold, retaining the real
    // facts calculation and recording 3334bp; this is fixture configuration, never a live change.
    'withdraw.auto_payout.warn.invalid_ratio_bp': 10000,
    'withdraw.auto_payout.warn.high_commission_rate_bp': 10000,
    'withdraw.auto_payout.warn.withdraw_received_ratio_bp': 10000,
    'payout.enabled': true,
    'payout.queue_paused': false,
    'payout.channel_enabled.alipay': true,
    'payout.mode': 'dry_run',
  };
  for (const [key, value] of Object.entries(config)) {
    await sql`INSERT INTO app.config_items (app_id,key,value,updated_by)
      VALUES (${appId},${key},${JSON.stringify(value)}::jsonb,'synthetic-replay')
      ON CONFLICT (app_id,key) DO UPDATE SET value=EXCLUDED.value,
        version=app.config_items.version+1`.execute(db);
  }
  return { appId, userId, deviceId: device.id };
}
