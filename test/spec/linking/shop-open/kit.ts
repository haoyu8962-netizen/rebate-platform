// B1-06zg rule-test kit (S-17 S17-l1; BR-PRICE-21 细则「进店」, BR-ATTR-05 / BR-ATTR-08 / BR-ID-18 进店例外).
// Only the two ports the brief names are stand-ins: catalog's shopOf and the adapter's convertShop
// (interface shapes only, no platform payloads). Authorization reads, auth sessions, idempotency and
// the database are real. Every persisted row is a synthetic fixture of an isolated tenant.
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import type { ShopOf } from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  createShopOpen,
  type ShopOpenCacheKey,
  type ShopOpenInput,
  type ShopOpenJump,
  type ShopOpenOptions,
} from '../../../../apps/api/src/modules/linking/application/shop-open.ts';
import {
  FixedClock,
  createIdempotency,
  type HandlerResult,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type {
  ActivePidInput,
  UnionAdapter,
  UnionPidRow,
} from '../../../../apps/api/src/modules/union/index.ts';

export const START = '2031-05-06T07:08:09.000Z';
export const TRACE = '0199a3b4-5c6d-7000-8000-0000000006a1';
export const PRODUCT_KEY = 'tb:synthetic_shop_item';
export const ITEM_REF = 'synthetic-shop-item-ref';
export const SHOP = { shopRef: '1001', shopName: '合成旗舰店' } as const;
type PidScene = ActivePidInput['pidScene'];
type Slots = Partial<Record<PidScene, string>>;
/** The default account's active slots (the app-wide current slots: union's own selection). */
export const ACTIVE_PID = {
  self_buy: 'mm_101_201_301',
  share: 'mm_102_202_302',
  agent: 'mm_103_203_303',
  query: 'mm_104_204_304',
  fallback: 'mm_105_205_305',
  taolijin: 'mm_106_206_306',
};
/** A second account of the same app and platform (registered later), with slots of its own. */
export const SECOND_PID = {
  self_buy: 'mm_111_211_311',
  share: 'mm_112_212_312',
  agent: 'mm_113_213_313',
  query: 'mm_114_214_314',
  fallback: 'mm_115_215_315',
  taolijin: 'mm_116_216_316',
};
/** Real ordinary (unpromoted) shop page shapes: none may appear in any refusal (确保转链). */
export const PLAIN_SHOP_URLS = [
  'https://shop1001.taobao.com',
  'https://shop1001.taobao.com/index.htm?spm=a1z10.1-c.0.0',
  'https://shop1001.m.taobao.com/',
  'https://store.taobao.com/shop/view_shop.htm?user_number_id=1001',
  'https://heyuan.tmall.com/shop/view_shop.htm',
  '//shop1001.taobao.com',
  'shop1001.taobao.com',
] as const;
/** Default and ceiling of link.convert_cache_ttl_sec (linking/domain/rules.ts). */
export const MAX_TTL_SEC = 900;

export type Binding =
  'absent' | 'unbound' | 'pending_auth' | 'active' | 'invalid' | 'released' | 'blocked';
export type ShopPlatform = 'taobao' | 'jd' | 'pdd';
type ConvertShop = NonNullable<UnionAdapter['convertShop']>;

/** A shop link the stand-in returns: distinct per shop and per relation id. */
export function shopLink(shopRef: string, relationId: string | null): string {
  return `https://s.click.taobao.com/t?e=synthetic-${shopRef}-${relationId ?? 'none'}`;
}

/** Keyed on every field the service puts in the key; no TTL, no identity policy of its own. */
export function memoryCache() {
  const entries = new Map<string, ShopOpenJump>();
  const keyOf = (key: ShopOpenCacheKey) =>
    JSON.stringify(Object.entries(key).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const get = vi.fn(async (key: ShopOpenCacheKey) => entries.get(keyOf(key)) ?? null);
  const put = vi.fn(async (key: ShopOpenCacheKey, jump: ShopOpenJump) => {
    entries.set(keyOf(key), jump);
  });
  return { get, put, entries };
}

export async function setup(db: Kysely<DB>, platform: ShopPlatform = 'taobao') {
  const clock = new FixedClock(START);
  const appId = `synthetic_shop_${randomUUID().replaceAll('-', '')}`;
  const a = randomUUID();
  const b = randomUUID();
  const device = randomUUID();
  const account = randomUUID();
  for (const [userId, suffix] of [
    [a, '1'],
    [b, '2'],
  ] as const) {
    await db
      .insertInto('users')
      .values({
        id: userId,
        app_id: appId,
        nickname: '合成用户',
        avatar: 'https://example.test/avatar',
        invite_code: `shop${suffix}`,
        attr_code: `shop000${suffix}`,
        level: 'T1',
        register_method: 'synthetic',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    await db
      .insertInto('user_risk_state')
      .values({
        app_id: appId,
        user_id: userId,
        state: 'normal',
        changed_by: 'synthetic-fixture',
        changed_at: clock.now(),
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }
  await db
    .insertInto('devices')
    .values({
      id: device,
      app_id: appId,
      device_hash: createHash('sha256').update(device).digest('hex'),
      id_source: 'idfv',
      install_secret_cipher: Buffer.from('synthetic-unused-cipher'),
      platform: 'ios',
      app_version: '2.0.0',
      last_seen_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('union_accounts')
    .values({
      id: account,
      app_id: appId,
      platform,
      account_name: 'synthetic-account',
      status: 'active',
      auth_status: 'active',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();

  const config = new Map<string, unknown>([
    [`shop.entry.enabled.${platform}`, true],
    [`shop.entry.source.${platform}`, 'dataoke'],
    [`convert.enabled.${platform}`, true],
  ]);
  const configValue = vi.fn(async (_app: string, key: string) =>
    config.has(key) ? { value: config.get(key) as DB['config_items']['value'], version: 1 } : null,
  );
  const slots = new Map<string, Slots>([[account, ACTIVE_PID]]);
  const getActivePid = vi.fn(async (query: ActivePidInput): Promise<UnionPidRow | null> => {
    // unionAccountId given: only that account's slot (B1-19d). Omitted: the app-wide current slot,
    // which is the default account's.
    const owner = query.unionAccountId ?? account;
    const pid = slots.get(owner)?.[query.pidScene];
    if (pid === undefined) return null;
    return {
      id: randomUUID(),
      app_id: query.appId,
      platform: query.platform,
      pid_scene: query.pidScene,
      pid,
      union_account_id: owner,
      site_id: null,
      status: 'active',
      row_version: 0,
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
      created_at: clock.now(),
      updated_at: clock.now(),
    };
  });
  /** Registers a later account of the same app and platform; the default stays `account`. */
  const addAccount = async (own: Slots = SECOND_PID) => {
    const id = randomUUID();
    const later = new Date(clock.now().getTime() + 1000);
    await db
      .insertInto('union_accounts')
      .values({
        id,
        app_id: appId,
        platform,
        account_name: 'synthetic-account-second',
        status: 'active',
        auth_status: 'active',
        created_at: later,
        updated_at: later,
      })
      .execute();
    slots.set(id, own);
    return id;
  };
  const convertShop = vi.fn<ConvertShop>(async (req, identity) => ({
    url: shopLink(req.shopRef, identity.claims.relationId),
  }));
  const adapter = {
    platform,
    shopConvertSources: ['dataoke'] as const,
    convertShop,
  } as unknown as UnionAdapter;
  const get = vi.fn(() => adapter);
  const shopOf = vi.fn<ShopOf>(async () => ({ ...SHOP }));
  const cache = memoryCache();
  const idempotency = createIdempotency({ db, clock, logger: { warn: vi.fn() } });
  const execute = vi.spyOn(idempotency, 'execute');
  const executeInTransaction = vi.spyOn(idempotency, 'executeInTransaction');
  const current = vi.fn(async () => ({ appId, userId: a as string | null, deviceId: device }));
  const resolve = vi.fn<ShopOpenOptions['authApps']['resolve']>(
    async (_app, env, client, method) => ({ ref: `synthetic/${env}/${client}/${method}` }),
  );
  const warn = vi.fn();
  const options: ShopOpenOptions = {
    db,
    clock,
    callerContext: { current },
    config: { configValue },
    pids: { getActivePid },
    registry: { get },
    shops: { shopOf },
    cache,
    idempotency,
    logger: { warn },
    appEnv: 'test',
    authApps: { resolve },
  };
  let serial = 0;
  const request = (
    extra: Partial<Omit<ShopOpenInput, 'body'>> & { body?: Partial<ShopOpenInput['body']> } = {},
  ): ShopOpenInput => {
    const { body, ...rest } = extra;
    return {
      productKey: PRODUCT_KEY,
      idempotencyKey: `synthetic-shop-open-${++serial}`,
      traceId: TRACE,
      client: 'ios',
      ...rest,
      body: { platform, item_ref: ITEM_REF, installed: 'unknown', ...body },
    };
  };
  const bind = async (
    status: Binding,
    userId = a,
    relationId = userId === a ? 'rel-A' : 'rel-B',
    accountId = account,
  ) => {
    if (status === 'absent') return;
    await db
      .insertInto('union_bindings')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: userId,
        platform,
        union_account_id: accountId,
        status,
        relation_id: relationId,
        blocked_reason: status === 'blocked' ? 'admin_disable' : null,
        released_at: status === 'released' ? clock.now() : null,
        cooldown_until: status === 'released' ? clock.now() : null,
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  };
  const setBinding = async (status: Binding, userId = a) => {
    await db
      .updateTable('union_bindings')
      .set({
        status: status as Exclude<Binding, 'absent'>,
        blocked_reason: status === 'blocked' ? 'admin_disable' : null,
        released_at: status === 'released' ? clock.now() : null,
        cooldown_until: status === 'released' ? clock.now() : null,
      })
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .execute();
  };
  const expireAccount = async () => {
    await db
      .updateTable('union_accounts')
      .set({ auth_status: 'expired' })
      .where('id', '=', account)
      .execute();
  };
  const opener = (userId: string | null) =>
    current.mockResolvedValue({ appId, userId, deviceId: device });
  const sessions = () =>
    db.selectFrom('union_auth_sessions').selectAll().where('app_id', '=', appId).execute();
  /** BR-ATTR-08 进店例外: no link, no link log, no open attempt (no quote snapshot). */
  const footprint = async () => ({
    links: await db.selectFrom('links').select('link_id').where('app_id', '=', appId).execute(),
    logs: await db.selectFrom('link_logs').select('id').where('app_id', '=', appId).execute(),
    attempts: await db
      .selectFrom('link_open_attempts')
      .select('attempt_id')
      .where('app_id', '=', appId)
      .execute(),
  });
  return {
    db,
    clock,
    appId,
    a,
    b,
    device,
    account,
    platform,
    config,
    configValue,
    getActivePid,
    addAccount,
    convertShop,
    adapter,
    get,
    shopOf,
    cache,
    idempotency,
    execute,
    executeInTransaction,
    current,
    resolve,
    warn,
    options,
    request,
    bind,
    setBinding,
    expireAccount,
    opener,
    sessions,
    footprint,
  };
}

export type Fixture = Awaited<ReturnType<typeof setup>>;

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
let schemas: Promise<Record<string, JsonSchema>> | undefined;

export async function validate(value: unknown, name: 'ShopOpenResponse' | 'ErrorEnvelope') {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((doc) => doc.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}

/**
 * The service under test. Construction stays outside every rejection assertion, so the skeleton's
 * NotImplemented makes each case red; every answer passes the contract envelope check.
 */
export function compose(f: Fixture, patch: Partial<ShopOpenOptions> = {}) {
  const service = createShopOpen({ ...f.options, ...patch });
  return async (input: ShopOpenInput = f.request()) => {
    const result = await service.open(input);
    await validate(
      result.envelope,
      result.envelope.code === 0 ? 'ShopOpenResponse' : 'ErrorEnvelope',
    );
    return result;
  };
}

/** A successful shop entry: the jump plan of BR-PRICE-21 细则「进店」 for `url`. */
export function shopJump(result: HandlerResult, url: string) {
  expect(result).toMatchObject({ status: 200, envelope: { code: 0 } });
  const data = result.envelope.data as components['schemas']['ShopOpenResult'];
  expect(Object.keys(data)).toEqual(['jump']);
  expect(data.jump.primary).toEqual({
    type: 'sdk',
    value: url,
    sdk: { provider: 'baichuan', open_by: 'url', url },
  });
  expect(data.jump.fallbacks).toEqual([{ type: 'h5', value: url }]);
  // Never a commission parameter of our own nor a user parameter beside the converted link.
  const serialized = JSON.stringify(data.jump);
  for (const forbidden of ['taoke', 'relation_id', '"pid"', 'open_by":"code'])
    expect(serialized).not.toContain(forbidden);
  return data.jump;
}

const AUTH_DATA = ['auth_url', 'state', 'auth_methods', 'reason'] as const;
/**
 * contracts/error-codes.yaml `data` of each refusal this endpoint answers with, and nothing more:
 * 50303 / 30153 / 10001 carry no data; 30146 / 50301 only platform + reason; 30101 / 30102 only the
 * authorization fields (sharer_auth_invalid never applies to the caller's own shop entry).
 */
const REFUSAL_DATA: Readonly<
  Record<number, { readonly keys: readonly string[]; readonly reasons: readonly string[] }>
> = {
  10001: { keys: [], reasons: [] },
  30101: { keys: AUTH_DATA, reasons: ['auth_unavailable'] },
  30102: { keys: AUTH_DATA, reasons: ['auth_unavailable'] },
  30153: { keys: [], reasons: [] },
  30146: { keys: ['platform', 'reason'], reasons: ['shop_entry_disabled', 'shop_unavailable'] },
  50301: { keys: ['platform', 'reason'], reasons: ['maintenance', 'not_launched'] },
  50303: { keys: [], reasons: [] },
};
/** Any platform page address, with or without a scheme (the auth_url itself is removed first). */
const ADDRESS = [
  /https?:\/\//i,
  /(?:^|[^\w])\/\/[\w-]+\./,
  /[\w-]+\.(?:taobao|tmall|jd|yangkeduo|pinduoduo)\.com/i,
  /(?:shop|example)\.example|example\.test/i,
];
/** Hosts of an ordinary shop page or of a converted shop link: never an authorization URL. */
const SHOP_HOST = /^(?:shop\d*|store)\.|(?:^|\.)tmall\.com$|^s\.click\.taobao\.com$/i;

/**
 * The shape of a refusal, without the database: the code and HTTP status; `data` only with the
 * fields error-codes.yaml defines for that code; no jump; no shop address nor shop name anywhere —
 * the only URL a refusal may carry is the 30101 / 30102 authorization URL, never on a shop host.
 */
export function refusalShape(
  result: HandlerResult,
  code: number,
  status = 422,
  platform = 'taobao',
) {
  expect(result).toMatchObject({ status, envelope: { code } });
  const allowed = REFUSAL_DATA[code];
  expect(allowed, `refusal ${code} is not one of this endpoint's codes`).toBeDefined();
  const data = result.envelope.data;
  let authUrl: string | undefined;
  if (data !== undefined) {
    expect(data).toBeTypeOf('object');
    expect(data).not.toBeNull();
    expect(Array.isArray(data)).toBe(false);
    const record = data as Record<string, unknown>;
    expect(Object.keys(record).filter((key) => !allowed!.keys.includes(key))).toEqual([]);
    if ('reason' in record) expect(allowed!.reasons).toContain(record.reason);
    if ('platform' in record) expect(record.platform).toBe(platform);
    if ('state' in record) expect(record.state).toBeTypeOf('string');
    if ('auth_methods' in record) {
      expect(Array.isArray(record.auth_methods)).toBe(true);
      for (const method of record.auth_methods as unknown[])
        expect(['web_code', 'sdk_token']).toContain(method);
    }
    if ('auth_url' in record) {
      expect(record.auth_url).toBeTypeOf('string');
      authUrl = record.auth_url as string;
      const url = new URL(authUrl);
      expect(url.protocol).toBe('https:');
      expect(url.host).not.toMatch(SHOP_HOST);
    }
  }
  let serialized = JSON.stringify(result);
  if (authUrl !== undefined) serialized = serialized.replaceAll(JSON.stringify(authUrl), '""');
  expect(serialized).not.toContain('jump');
  for (const pattern of ADDRESS) expect(serialized).not.toMatch(pattern);
  expect(serialized).not.toContain(SHOP.shopName);
  expect(serialized).not.toContain(`shop${SHOP.shopRef}`);
}

/** A refusal: refusalShape, and nothing persisted for links (BR-ATTR-08 进店例外). */
export async function refusal(result: HandlerResult, f: Fixture, code: number, status = 422) {
  refusalShape(result, code, status, f.platform);
  expect(await f.footprint()).toEqual({ links: [], logs: [], attempts: [] });
}

/** No authorization entry issued: no state, no URL, no session row. */
export async function noAuthState(result: HandlerResult, f: Fixture) {
  for (const key of ['auth_url', 'state', 'auth_methods'])
    expect(result.envelope.data ?? {}).not.toHaveProperty(key);
  expect(await f.sessions()).toEqual([]);
}

/** Neither the shop port nor the shop conversion was reached. */
export function untouched(f: Fixture) {
  expect(f.shopOf).not.toHaveBeenCalled();
  expect(f.convertShop).not.toHaveBeenCalled();
}
