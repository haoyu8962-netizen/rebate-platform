// Real AppModule, PG and Redis; only planned payout handlers are replaced. No level check is
// installed by this fixture: app.module must supply both production paths itself.
// B1-13j: B1-13e implemented getPayoutAccount, so each payout operation is judged on its own. A
// planned one still gets the stub handler below; an implemented one keeps its real route (a stub
// on the same method and path would collide with it) and its real handler is wrapped, before the
// routes are registered, so `handled` still counts every entry into the business handler.
// B1-13k: B1-13f implemented savePayoutAccount. Its real route validates the contract body before
// any guard (so BODY is now a contract-valid Alipay body; the planned stub has no route schema and
// accepts it too), and judges ⑧ ⑨ ⑫ inside the handler's idempotency call (post-miss checks), so
// entering the real PUT handler is not "the business ran": for PUT the probe wraps the business
// service (PAYOUT_ACCOUNT_CHANGE) the controller calls after those checks. openHttp ends with a
// positive control (selfCheck): a phone-bound, real-name-verified user passes the level checks on
// GET and PUT and each counts exactly once, so a probe that never fires cannot pass the 0 counts.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import type * as Access from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type * as Sessions from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type * as Tokens from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type * as StepUp from '../../../../apps/api/src/modules/identity/application/step-up-verify.ts';
import type * as Risk from '../../../../apps/api/src/modules/risk/index.ts';
import { summaryClaim } from '../step-up-digest/payout-summary.ts';
import { seedUser } from '../registration/kit.ts';
import { buildApp } from '../sms-codes/http-kit.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { apiRequire, ROOT, sign } from '../../risk/signature/kit.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';

export const PAYOUT = '/v1/me/payout-account';
// B1-13k: contract-valid SavePayoutAccountRequest (alipay shape), so the real route of B1-13f gets
// past its body schema (20001) to the stages under test. PAYEE is also the verified real name the
// positive control seeds, so the real business does not stop at a name mismatch.
export const PAYEE = '测试';
export const BODY = {
  payout_method: 'alipay',
  alipay_logon_id: 'identity-level@example.com',
  payee_name: PAYEE,
};
type Method = 'GET' | 'PUT' | 'POST';
export interface Response {
  statusCode: number;
  payload: string;
  headers: Record<string, unknown>;
  json<T = Record<string, unknown>>(): T;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol | Constructor): T;
  inject(options: {
    method: Method;
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}
interface Request extends StepUp.StepUpHttpRequest {
  id: string;
  body: unknown;
  readonly headers: Record<string, string | undefined>;
}
type Constructor = abstract new (...args: never[]) => unknown;
type Handler = (this: unknown, ...args: unknown[]) => unknown;
// reflect-metadata (loaded by @nestjs/common): the route metadata lives on the handler function.
const metadata = Reflect as unknown as {
  getMetadata(key: unknown, target: object): unknown;
  getOwnMetadataKeys(target: object): unknown[];
  getOwnMetadata(key: unknown, target: object): unknown;
  defineMetadata(key: unknown, value: unknown, target: object): void;
};
type Decorator = (target: object, name: string, descriptor: PropertyDescriptor) => void;
interface DynamicModuleLike {
  providers?: unknown[];
  [field: string]: unknown;
}

export async function openHttp(db: Kysely<DB>, redisUrl: string): Promise<Fixture> {
  const f = await build(db, redisUrl);
  try {
    await selfCheck(f);
  } catch (error) {
    await f.close();
    throw error;
  }
  return f;
}

async function build(db: Kysely<DB>, redisUrl: string) {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  const identity = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as Pick<typeof StepUp, 'withStepUp'> & {
    IdentityModule: { forRoot(options: unknown): DynamicModuleLike };
  };
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof Tokens;
  const risk = (await import(
    new URL('apps/api/src/modules/risk/index.ts', ROOT).href
  )) as typeof Risk;
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: Platform.PlatformOptions): Record<string, unknown> };
  };
  const common = (await import(pathToFileURL(apiRequire.resolve('@nestjs/common')).href)) as {
    Controller(path: string): (target: Constructor) => void;
    Get(path: string): Decorator;
    Put(path: string): Decorator;
    Req(): (target: object, name: string, index: number) => void;
    HttpException: new (body: unknown, status: number) => Error;
    RequestMethod: { GET: number; PUT: number };
  };
  const constants = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/common/constants.js')).href
  )) as { PATH_METADATA: string; METHOD_METADATA: string };
  const core = (await import(pathToFileURL(apiRequire.resolve('@nestjs/core')).href)) as {
    ModulesContainer: new () => Map<string, { controllers: Map<unknown, { metatype: unknown }> }>;
  };
  const clock = new platform.FixedClock('2026-10-17T02:00:00.000Z');
  const handled = new Map<string, number>();
  const stepUpCalls: string[] = [];
  let idem: Platform.Idempotency;
  class PlannedPayout {
    get(request: Request) {
      const uid = request.principal!.uid;
      handled.set(uid, (handled.get(uid) ?? 0) + 1);
      return { code: 0, msg: '', data: { fixture: true }, trace_id: request.id };
    }
    async put(request: Request) {
      const principal = request.principal!;
      const response = await identity.withStepUp(request, () =>
        idem.executeInTransaction(
          {
            appId: principal.app_id,
            actor: { userId: principal.uid, deviceId: null, phoneHmac: null },
            method: 'PUT',
            path: PAYOUT,
            key: request.headers['idempotency-key'],
            body: request.body,
            traceId: request.id,
          },
          async () => ({ status: 200, envelope: this.get(request) }),
        ),
      );
      if (response.status !== 200)
        throw new common.HttpException(JSON.parse(response.body), response.status);
      return JSON.parse(response.body) as unknown;
    }
  }
  const projection = (await import(
    new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
  )) as { CONTRACT_ROUTE_SCHEMAS: Record<string, unknown> };
  // B1-13j: per operation, not "both planned". GET is judged by the level guard before the
  // handler, so entering the real handler is the same event the stub counted ('handler' probe).
  // B1-13k: PUT is judged inside the handler's idempotency call (post-miss checks ⑧ ⑨ before ⑫
  // step-up), so a real PUT is counted where its business starts: every method of the
  // PAYOUT_ACCOUNT_CHANGE service the controller calls from the idempotency handler ('service').
  const operations = [
    { operation: 'getPayoutAccount', name: 'get', method: 'GET', probe: 'handler' },
    { operation: 'savePayoutAccount', name: 'put', method: 'PUT', probe: 'service' },
  ] as const;
  const implemented = operations.filter(({ operation }) =>
    Object.hasOwn(projection.CONTRACT_ROUTE_SCHEMAS, operation),
  );
  const handlerProbes = implemented.filter(({ probe }) => probe === 'handler');
  const putMounted = implemented.some(({ name }) => name === 'put');
  const planned = operations.filter((entry) => !implemented.includes(entry));
  common.Controller('v1/me/payout-account')(PlannedPayout);
  for (const { name } of planned) {
    common.Req()(PlannedPayout.prototype, name, 0);
    (name === 'get' ? common.Get('') : common.Put(''))(
      PlannedPayout.prototype,
      name,
      Object.getOwnPropertyDescriptor(PlannedPayout.prototype, name)!,
    );
  }
  // Counts an entry into a real handler under the token principal it was called for; an entry
  // whose arguments carry no principal counts against every user (never silently dropped).
  const count = (args: unknown[]) => {
    const carrier = args.find(
      (arg): arg is { principal: { uid: string } } =>
        typeof arg === 'object' &&
        arg !== null &&
        typeof (arg as { principal?: { uid?: unknown } }).principal?.uid === 'string',
    );
    const uid = carrier?.principal.uid ?? '*';
    handled.set(uid, (handled.get(uid) ?? 0) + 1);
  };
  // B1-13k: the same rule for a business-service call, whose command carries the token's userId.
  const countCommand = (args: unknown[]) => {
    const command = args.find(
      (arg): arg is { userId: string } =>
        typeof arg === 'object' &&
        arg !== null &&
        typeof (arg as { userId?: unknown }).userId === 'string',
    );
    const uid = command?.userId ?? '*';
    handled.set(uid, (handled.get(uid) ?? 0) + 1);
  };
  // B1-13k: wraps the PUT business service where IdentityModule provides it, before Nest creates
  // it (the instance is frozen, and the controller keeps the reference it was constructed with).
  const changeToken = (tokens as unknown as Record<string, unknown>)['PAYOUT_ACCOUNT_CHANGE'];
  if (putMounted)
    expect(typeof changeToken, 'savePayoutAccount 已实现，但没有 PAYOUT_ACCOUNT_CHANGE 令牌').toBe(
      'symbol',
    );
  let changeProviders = 0;
  let changeServices = 0;
  const probeService = (service: unknown): unknown => {
    if (typeof service !== 'object' || service === null) return service;
    const wrapped: Record<string, unknown> = {};
    let methods = 0;
    for (const name of Object.keys(service)) {
      const value = (service as Record<string, unknown>)[name];
      if (typeof value !== 'function') {
        wrapped[name] = value;
        continue;
      }
      methods += 1;
      wrapped[name] = (...args: unknown[]) => {
        countCommand(args);
        return (value as Handler).apply(service, args);
      };
    }
    if (methods > 0) changeServices += 1;
    return Object.freeze(wrapped);
  };
  const originalIdentity = identity.IdentityModule.forRoot.bind(identity.IdentityModule);
  const identitySpy = vi
    .spyOn(identity.IdentityModule, 'forRoot')
    .mockImplementation((options: unknown) => {
      const module = originalIdentity(options);
      if (!putMounted) return module;
      return {
        ...module,
        providers: (module.providers ?? []).map((provider) => {
          if (
            typeof provider !== 'object' ||
            provider === null ||
            !('provide' in provider) ||
            provider.provide !== changeToken ||
            !('useFactory' in provider)
          )
            return provider;
          changeProviders += 1;
          const factory = provider.useFactory as (...deps: unknown[]) => unknown;
          return {
            ...provider,
            useFactory: async (...deps: unknown[]) => probeService(await factory(...deps)),
          };
        }),
      };
    });
  const restore: (() => void)[] = [];
  const segments = (value: unknown) =>
    (Array.isArray(value) ? value : [value ?? ''])
      .map((path) => String(path).replace(/^\/+|\/+$/g, ''))
      .filter((path) => path !== '');
  // Before init (Nest registers routes in init and keeps the handler function it finds then).
  const probeRealRoutes = (running: App) => {
    for (const { operation, method } of handlerProbes) {
      let wrapped = 0;
      const seen = new Set<unknown>();
      for (const module of running
        .get<Map<string, { controllers: Map<unknown, { metatype: unknown }> }>>(
          core.ModulesContainer,
        )
        .values()) {
        for (const { metatype } of module.controllers.values()) {
          if (typeof metatype !== 'function' || seen.has(metatype)) continue;
          seen.add(metatype);
          const prefixes = segments(metadata.getMetadata(constants.PATH_METADATA, metatype));
          for (
            let proto = metatype.prototype as object | null;
            proto !== null && proto !== Object.prototype;
            proto = Object.getPrototypeOf(proto) as object | null
          ) {
            for (const name of Object.getOwnPropertyNames(proto)) {
              const descriptor = Object.getOwnPropertyDescriptor(proto, name)!;
              if (name === 'constructor' || typeof descriptor.value !== 'function') continue;
              const original = descriptor.value as Handler;
              if (
                metadata.getMetadata(constants.METHOD_METADATA, original) !==
                common.RequestMethod[method]
              )
                continue;
              const paths = segments(metadata.getMetadata(constants.PATH_METADATA, original));
              const full = (prefixes.length === 0 ? [''] : prefixes).flatMap((prefix) =>
                (paths.length === 0 ? [''] : paths).map((path) =>
                  [prefix, path].filter((part) => part !== '').join('/'),
                ),
              );
              if (!full.includes(PAYOUT.slice(1))) continue;
              const probe: Handler = function (this: unknown, ...args: unknown[]) {
                count(args);
                return original.apply(this, args);
              };
              for (const key of metadata.getOwnMetadataKeys(original))
                metadata.defineMetadata(key, metadata.getOwnMetadata(key, original), probe);
              Object.defineProperty(proto, name, { ...descriptor, value: probe });
              const owner = proto;
              restore.push(() => Object.defineProperty(owner, name, descriptor));
              wrapped += 1;
            }
          }
        }
      }
      expect(wrapped, `${operation} 已实现，但找不到 ${method} ${PAYOUT} 的真实处理函数`).toBe(1);
    }
  };
  const unprobe = () => {
    for (const undo of restore.splice(0).reverse()) undo();
  };
  // Observe actual Redis commands as well as the final key: a reserve-then-release must fail.
  const originalPlatform = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const redisSpy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = originalPlatform(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) => {
        if (
          typeof provider !== 'object' ||
          provider === null ||
          !('provide' in provider) ||
          provider.provide !== platform.REDIS ||
          !('useFactory' in provider)
        )
          return provider;
        const factory = provider.useFactory as () => Promise<Platform.RedisHandle>;
        return {
          provide: platform.REDIS,
          useFactory: async () => {
            const handle = await factory();
            return {
              ...handle,
              namespace(name: string) {
                const ns = handle.namespace(name);
                return {
                  get: (key: string) => ns.get(key),
                  set: ns.set.bind(ns),
                  eval: (script: string, args: Parameters<Platform.RedisNamespace['eval']>[1]) => {
                    if (name === 'step_up') stepUpCalls.push(...args.keys);
                    return ns.eval(script, args);
                  },
                };
              },
              close: () => handle.close(),
              onApplicationShutdown: () => handle.onApplicationShutdown(),
            };
          },
        };
      }),
    };
  });
  const original = AppModule.forEntry.bind(AppModule);
  const entrySpy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return {
      ...module,
      controllers: [
        ...((module['controllers'] ?? []) as unknown[]),
        ...(planned.length === 0 ? [] : [PlannedPayout]),
      ],
    };
  });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-02za-'));
  const { logger } = memoryLogger();
  let app: App | undefined;
  try {
    app = (await buildApp(db, dir, redisUrl, clock, logger)) as unknown as App;
    probeRealRoutes(app);
    if (putMounted) {
      // B1-13k: exactly one business service, created with the app (before init), is probed.
      expect(changeProviders, `找不到 PAYOUT_ACCOUNT_CHANGE 的提供者`).toBe(1);
      expect(changeServices, `PAYOUT_ACCOUNT_CHANGE 未装配（null）或没有可包装的方法`).toBe(1);
    }
    await app.init();
    idem = app.get<Platform.Idempotency>(platform.IDEMPOTENCY);
    const running = app;
    return {
      db,
      app: running,
      clock,
      idem,
      stepUpCalls,
      // B1-13k: true once savePayoutAccount has its real route (contract body schema applies).
      putMounted,
      crypto: app.get<Platform.FieldCrypto>(platform.FIELD_CRYPTO),
      keys: app.get<Access.TokenKeyProvider>(tokens.TOKEN_KEYS),
      tokens: app.get<Access.TokenService>(tokens.TOKEN_SERVICE),
      redis: app.get<Platform.RedisHandle>(platform.REDIS),
      risk: app.get<Risk.RiskStateService>(risk.riskStateServiceToken()),
      // '*': a real-handler entry without a principal counts against every user (B1-13j).
      handled: (uid: string) => (handled.get(uid) ?? 0) + (handled.get('*') ?? 0),
      async close() {
        try {
          await running.close();
        } finally {
          unprobe();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      unprobe();
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    entrySpy.mockRestore();
    identitySpy.mockRestore();
    redisSpy.mockRestore();
  }
}
export type Fixture = Awaited<ReturnType<typeof build>>;

export async function client(
  f: Fixture,
  options: {
    phone?: boolean;
    scope?: 'full' | 'deletion_only';
    minVersion?: string;
    config?: Record<string, unknown>;
  } = {},
) {
  const appId = `il_${randomBytes(10).toString('hex')}`;
  for (const [key, value] of Object.entries(options.config ?? {})) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
      (${appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'b1-02za')`.execute(f.db);
  }
  if (options.minVersion !== undefined) {
    await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version,
      min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', ${options.minVersion},
      ${options.minVersion}, 'test', 'test', 'https://example.test/store', 'appstore', '[]'::jsonb)`.execute(
      f.db,
    );
  }
  const headers = {
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const registration = await f.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(registration.statusCode).toBe(200);
  const device = registration.json<{ data: { device_id: string; install_secret: string } }>().data;
  const uid = await seedUser(
    f.db,
    appId,
    options.phone ? { phoneHmac: randomBytes(32).toString('hex') } : {},
  );
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof Sessions;
  const access = (await import(
    new URL('apps/api/src/modules/identity/application/access-tokens.ts', ROOT).href
  )) as typeof Access;
  const session = await f.db
    .withSchema('app')
    .transaction()
    .execute((trx) =>
      sessions.createSession(
        trx,
        { uid, app_id: appId, device_id: device.device_id, scp: options.scope ?? 'full' },
        { clock: f.clock, tokens: f.tokens },
      ),
    );
  return {
    uid,
    appId,
    session,
    async bind(phone: boolean) {
      await f.db
        .withSchema('app')
        .updateTable('users')
        .set({ phone_hmac: phone ? randomBytes(32).toString('hex') : null })
        .where('id', '=', uid)
        .where('app_id', '=', appId)
        .execute();
    },
    async ban(state: 'normal' | 'banned') {
      await f.db.transaction().execute((trx) =>
        f.risk.setRiskState(trx, {
          app_id: appId,
          user_id: uid,
          state,
          reason: 'identity-level fixture',
          reason_category: state === 'normal' ? null : 'other',
          frozen_until: null,
          changed_by: 'fixture',
        }),
      );
    },
    // B1-13k: a verified app.realname row (synthetic identity, encrypted like identity writes it),
    // for the positive control only.
    async verifyRealname(name = PAYEE) {
      const crypto = f.crypto;
      await sql`INSERT INTO app.realname (id, app_id, user_id, status, name_cipher, id_no_cipher,
        id_no_hmac, birth_date_cipher, provider, verified_at)
        VALUES (${randomUUID()}, ${appId}, ${uid}, 'verified',
        ${Buffer.from(crypto.encrypt(name, 'realname.name'))},
        ${Buffer.from(crypto.encrypt(uid, 'realname.id_no'))},
        ${crypto.blindIndex(uid, 'realname.id_no')},
        ${Buffer.from(crypto.encrypt('1990-01-01', 'realname.birth_date'))}, 'fixture',
        ${f.clock.now()})`.execute(f.db);
    },
    /**
     * B1-02zzzb (BR-ID-08 细则「绑定业务摘要」): the token carries the digest of the account
     * `stepUpBody` saves (when omitted: BODY, the body send() puts), as POST /v1/auth/step-up
     * signs it.
     */
    async stepUp(stepUpBody?: object) {
      const jti = randomUUID();
      const token = await access.signScopedToken(f.keys, {
        audience: 'step_up',
        claims: {
          uid,
          app_id: appId,
          sid: session.sid,
          device_id: device.device_id,
          action: 'payout_account_change',
          jti,
          ...summaryClaim(f.crypto, stepUpBody, BODY),
        },
        issuedAt: Math.floor(f.clock.now().getTime() / 1000),
        ttlSeconds: 300,
      });
      return { token, jti };
    },
    async accessWithClaims(extra: Record<string, unknown>) {
      const jose = (await import(pathToFileURL(apiRequire.resolve('jose')).href)) as {
        SignJWT: new (claims: object) => {
          setProtectedHeader(value: object): {
            setIssuer(value: string): {
              setAudience(value: string): {
                setIssuedAt(value: number): {
                  setExpirationTime(value: number): {
                    sign(key: Access.TokenKeyProvider['privateKey']): Promise<string>;
                  };
                };
              };
            };
          };
        };
      };
      const now = Math.floor(f.clock.now().getTime() / 1000);
      return new jose.SignJWT({
        uid,
        app_id: appId,
        sid: session.sid,
        device_id: device.device_id,
        scp: options.scope ?? 'full',
        ...extra,
      })
        .setProtectedHeader({ alg: 'ES256', kid: f.keys.kid, typ: 'JWT' })
        .setIssuer('couli-api')
        .setAudience('app')
        .setIssuedAt(now)
        .setExpirationTime(now + 900)
        .sign(f.keys.privateKey);
    },
    send(
      method: Method,
      path = PAYOUT,
      options: {
        key?: string | null;
        stepUp?: string;
        token?: string;
        version?: string;
        body?: object;
        headers?: Record<string, string>;
      } = {},
    ) {
      const raw = method === 'GET' ? '' : JSON.stringify(options.body ?? BODY);
      const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const key = options.key === undefined ? randomUUID() : options.key;
      return f.app.inject({
        method,
        url: path,
        ...(method === 'GET' ? {} : { payload: raw }),
        headers: {
          ...headers,
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
          'x-device-id': device.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign(method, path, Buffer.from(raw), timestamp, nonce, device.install_secret),
          authorization: `Bearer ${options.token ?? session.access_token}`,
          'x-trace-id': randomUUID(),
          ...(key === null ? {} : { 'idempotency-key': key }),
          ...(options.stepUp === undefined ? {} : { 'x-step-up-token': options.stepUp }),
          ...(options.version === undefined ? {} : { 'x-app-version': options.version }),
          ...options.headers,
        },
      });
    },
  };
}

export async function refusal(response: Response, status: number, code: number, noData = true) {
  expect(response.statusCode, response.payload).toBe(status);
  const body = response.json();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  if (noData) expect(body).not.toHaveProperty('data');
  expect(response.headers['x-trace-id']).toBe(body['trace_id']);
  const validate = await envelopeValidator();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

// B1-13k: positive control of the `handled` probes, run by openHttp before any test (the frozen
// http.int.test.ts has no AC number for it). A phone-bound, real-name-verified user passes stages
// ⑧ ⑨ (and ⑫ with a valid step-up token): the real GET handler, and the PUT business (the stub on a
// planned PUT, the PAYOUT_ACCOUNT_CHANGE service on the real one) each count exactly once. Without
// it a probe that never fires would pass every "0" assertion of the refusals.
async function selfCheck(f: Fixture) {
  const c = await client(f, { phone: true });
  await c.verifyRealname();
  const get = await c.send('GET');
  expect(get.statusCode, get.payload).toBe(200);
  expect(get.json()['code'], get.payload).toBe(0);
  expect(f.handled(c.uid), 'GET 放行后真实处理函数应恰好计数 1').toBe(1);
  const step = await c.stepUp();
  const put = await c.send('PUT', PAYOUT, { stepUp: step.token });
  // Not a refusal of a stage before the business (signature … ⑫ step-up). The business itself may
  // answer anything (a 20001 of its own included): the count below is what proves it was entered.
  expect([10001, 10002, 10003, 10005, 10006, 10401, 10402, 10403, 10405, 30304]).not.toContain(
    put.json()['code'],
  );
  expect(f.handled(c.uid), `PUT 放行后业务入口应恰好计数 1：${put.payload}`).toBe(2);
}
