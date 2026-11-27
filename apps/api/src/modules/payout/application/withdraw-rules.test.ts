// B2-05u implementer unit tests (task brief §9.4, impl 2): the closed-method check of
// readWithdrawInput over the open-method port. Fake ports only (a fake parser and default set,
// nothing of identity): no database, no listener.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  createWithdrawRules,
  readWithdrawInput,
  type OpenPayoutMethodsPort,
  type WithdrawRulesOptions,
} from './withdraw-rules.ts';

const METHODS_KEY = 'withdraw.payout_methods';
const actor = { appId: 'b2_05u_unit', userId: 'user-1', deviceId: 'device-1' };
const HMAC = 'a'.repeat(64);

type Method = 'alipay' | 'bank_card' | 'wechat';

/** A fake port: any non-empty array of strings is valid, everything else is invalid. */
function fakePort(): OpenPayoutMethodsPort {
  return {
    key: METHODS_KEY,
    defaults: new Set(['alipay', 'bank_card']),
    parse: vi.fn((value: unknown) =>
      Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')
        ? new Set<string>(value as string[])
        : null,
    ),
  };
}

function fixture(
  method: Method,
  values: ReadonlyMap<string, unknown> = new Map(),
  // null = the port is not handed in (a hand-built assembly).
  port: OpenPayoutMethodsPort | null = fakePort(),
) {
  const clock = new FixedClock('2026-10-01T04:00:00.000Z');
  const handle = Object.freeze({ fixture: 'caller-handle' }) as unknown as Kysely<DB>;
  const options: WithdrawRulesOptions = {
    clock,
    logger: { warn: vi.fn() },
    config: {
      configValue: vi.fn(async (_app: string, key: string) =>
        values.has(key) ? { value: values.get(key), version: 1 } : null,
      ),
    },
    risk: {
      read: vi.fn(
        async () => new Map([[actor.userId, { state: 'normal' as const, frozen_until: null }]]),
      ),
    },
    appeal: { read: vi.fn(async () => null) },
    blocklist: { read: vi.fn(async () => null) },
    reverify: { check: vi.fn(async () => null) },
    realname: {
      read: vi.fn(async () => 'verified' as const),
      verified: vi.fn(async () => ({
        name: '阿·甲',
        birth_date: '1990-01-01',
        provider: 'synthetic',
        verified_at: clock.now(),
      })),
    },
    subject: {
      read: vi.fn(async () => ({ payout_method: method, payee_name: '阿·甲', payee_hmac: HMAC })),
    },
    laborAgreementSigned: vi.fn(async () => true),
    ledger: {
      getBalances: vi.fn(async () => [
        {
          app_id: actor.appId,
          user_id: actor.userId,
          account_id: actor.userId,
          available_fen: 800000n,
          frozen_fen: 0n,
          version: 1n,
          negative_since: null,
        },
      ]),
    },
    holds: { read: vi.fn(async () => []) },
    usage: {
      read: vi.fn(async () => ({
        daily_count: 0,
        monthly_count: 0,
        payee_daily_count: 0,
        payee_daily_other_users: 0,
        monthly_amount_fen: 0n,
      })),
    },
    selfPurchase: { read: vi.fn(async () => ({ count: 0, amount_fen: 0n })) },
    feeTax: {
      calculate: vi.fn(async (_handle, input) => ({
        fee_fen: 0n,
        tax_fen: 0n,
        net_fen: input.amountFen,
      })),
    },
    ...(port === null ? {} : { openPayoutMethods: port }),
  };
  return { handle, options };
}

it.each(['alipay', 'bank_card'] as const)(
  '[AC-B2-05u#6] withdraw.payout_methods 行缺失时按默认开放 %s：规则与提交都不拦，不记 warn',
  async (method) => {
    const f = fixture(method);
    const input = await readWithdrawInput(f.handle, actor, true, f.options);
    expect(input.payout_method).toBe(method);
    expect(f.options.config.configValue).toHaveBeenCalledWith(actor.appId, METHODS_KEY, f.handle);

    const service = createWithdrawRules(f.options);
    expect(await service.getRules(f.handle, actor)).toMatchObject({
      can_withdraw: true,
      block_code: null,
    });
    expect(await service.validate(f.handle, actor, 1000n, true)).toBeNull();
    expect(f.options.logger.warn).not.toHaveBeenCalled();
  },
);

it('[AC-B2-05u#6] withdraw.payout_methods 行缺失时默认不含 wechat：已绑微信的会员得 30305', async () => {
  const f = fixture('wechat');
  const service = createWithdrawRules(f.options);
  expect(await service.getRules(f.handle, actor)).toMatchObject({
    can_withdraw: false,
    block_code: 30305,
  });
  expect(await service.validate(f.handle, actor, 1000n, true)).toMatchObject({ code: 30305 });
  expect(f.options.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-05u#6] 非法值按默认并记 withdraw_config_default（只带 app_id 与 config_key）', async () => {
  const f = fixture('alipay', new Map([[METHODS_KEY, []]]));
  const input = await readWithdrawInput(f.handle, actor, true, f.options);
  expect(input.payout_method).toBe('alipay');
  expect(vi.mocked(f.options.logger.warn).mock.calls).toEqual([
    [{ app_id: actor.appId, config_key: METHODS_KEY }, 'withdraw_config_default'],
  ]);
});

it('[AC-B2-05u#4] 方式关闭时只把规则用的方式置空：黑名单与按收款账号的次数仍用真实账号', async () => {
  const f = fixture('alipay', new Map([[METHODS_KEY, ['bank_card']]]));
  const input = await readWithdrawInput(f.handle, actor, true, f.options);
  expect(input.payout_method).toBeNull();
  expect(f.options.blocklist.read).toHaveBeenCalledWith(
    f.handle,
    expect.objectContaining({ payeeHmac: HMAC, payoutMethod: 'alipay' }),
  );
  expect(f.options.usage.read).toHaveBeenCalledWith(
    f.handle,
    expect.objectContaining({ payeeHmac: HMAC }),
  );
  expect(await createWithdrawRules(f.options).validate(f.handle, actor, 1000n, true)).toMatchObject(
    { code: 30305 },
  );
});

// §9.4 ②: an already created withdrawal never looks at the switch. The only reader of the port in
// the payout module is readOpenPayoutMethods, called only by readWithdrawInput.
it('[AC-B2-05u#7] payout 模块里只有 readWithdrawInput 读 withdraw.payout_methods', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
    }
  };
  walk(root);
  const marker =
    /withdraw\.payout_methods|openPayoutMethods|OpenPayoutMethodsPort|readOpenPayoutMethods/;
  const readers = files
    .filter((file) => marker.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file).split('\\').join('/'));
  expect(readers).toEqual(['application/withdraw-rules.ts']);

  const source = readFileSync(join(root, 'application/withdraw-rules.ts'), 'utf8');
  const calls = [...source.matchAll(/await readOpenPayoutMethods\(/g)].map((m) => m.index);
  expect(calls).toHaveLength(1);
  const portReads = [...source.matchAll(/options\.openPayoutMethods/g)].map((m) => m.index);
  expect(portReads).toHaveLength(1);
  const start = source.indexOf('export async function readWithdrawInput(');
  const end = source.indexOf('\nexport ', start + 1);
  expect(start).toBeGreaterThan(-1);
  for (const at of [...calls, ...portReads]) {
    expect(at).toBeGreaterThan(start);
    expect(at).toBeLessThan(end);
  }
  // 规划/02 §4.1: nothing in payout imports identity, the switch's parser included.
  expect(source).not.toMatch(/from\s*'[^']*\/identity\//);
});

it('[AC-B2-05u#wiring] 开放方式端口没交进来时不读该配置键，规则用真实方式', async () => {
  const f = fixture('wechat', new Map([[METHODS_KEY, ['alipay']]]), null);
  const input = await readWithdrawInput(f.handle, actor, true, f.options);
  expect(input.payout_method).toBe('wechat');
  expect(f.options.config.configValue).not.toHaveBeenCalledWith(
    actor.appId,
    METHODS_KEY,
    expect.anything(),
  );
  expect(f.options.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-05u#wiring] app.module 的提现规则装配处交了开放方式端口（identity 的键、默认集合与解析函数）', () => {
  const file = fileURLToPath(new URL('../../../app.module.ts', import.meta.url));
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('function withdrawRuleOptions(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  const body = source.slice(start, end);
  expect(body).toContain('subject: createWithdrawSubjectReader()');
  expect(body).toMatch(
    /openPayoutMethods:\s*\{\s*key:\s*PAYOUT_METHODS_KEY,\s*defaults:\s*DEFAULT_PAYOUT_METHODS,\s*parse:\s*parsePayoutMethods,?\s*\}/,
  );
  // The three come from identity's index.ts, and both the rules and the application use it.
  const identityImport = source.match(
    /import \{([^}]*)\} from '\.\/modules\/identity\/index\.ts';/,
  );
  expect(identityImport).not.toBeNull();
  for (const name of ['DEFAULT_PAYOUT_METHODS', 'PAYOUT_METHODS_KEY', 'parsePayoutMethods']) {
    expect(identityImport?.[1]).toMatch(new RegExp(`\\b${name}\\b`));
  }
  expect(source).toMatch(/createWithdrawRules\(withdrawRuleOptions\(/);
  expect(source).toMatch(/const rules = withdrawRuleOptions\(/);
});
