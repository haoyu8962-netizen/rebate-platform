// B1-06zg HTTP harness: the real api bootstrap, contract route schema, request signature, token
// check, the real platform idempotency primitive (IDEMPOTENCY, over an in-memory wire storage)
// and the minimum-version gate (④a, judged in IDEMPOTENCY's post-miss hook for this x-idempotent
// operation). Only the ShopOpenService use case is replaced: the stand-in runs the case's `open`
// under the app's IDEMPOTENCY instance, as the use case does (shop-open.ts runShopEntry), so the
// request reaches ④a and the risk interceptor's fail-closed rule (MinimumVersionUnjudgedError)
// is satisfied exactly as with the real use case. No future controller is imported here: on the
// skeleton the route is not registered, so every case fails its first assertion (the route
// answers 200 before the case runs).
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { createTokenCheck } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import {
  ShopOpenService,
  type ShopOpenInput,
} from '../../../../apps/api/src/modules/linking/application/shop-open.ts';
import {
  FixedClock,
  IDEMPOTENCY,
  PlatformModule,
  REQUEST_CHECKS,
  createIdempotency,
  createRootLogger,
  isContractSignedRoute,
  loadConfig,
  type HandlerResult,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import { idempotencyStorage } from '../../catalog/favorites-route/storage.ts';

export interface Response {
  statusCode: number;
  json(): unknown;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'POST';
    url: string;
    payload: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}
interface ModuleShape {
  providers?: unknown[];
  [key: string]: unknown;
}
export type Send = (
  body: object,
  headers?: Record<string, string | undefined>,
  url?: string,
) => Promise<Response>;

const root = new URL('../../../../', import.meta.url);
export const PRODUCT_KEY = 'tb:synthetic_shop_item';
export const PATH = `/v1/products/${encodeURIComponent(PRODUCT_KEY)}/shop/open`;
export const body = { platform: 'taobao', item_ref: 'synthetic-shop-item-ref', installed: 'true' };
export const traceId = '0199a3b4-5c6d-7000-8000-0000000006b1';
export const IDEMPOTENCY_KEY = 'synthetic-http-shop-open';
const READY_IDEMPOTENCY_KEY = 'synthetic-http-shop-open-ready';
export const SHOP_URL = 'https://s.click.taobao.com/t?e=synthetic-http-shop';
export const data = {
  jump: {
    primary: {
      type: 'sdk',
      value: SHOP_URL,
      sdk: { provider: 'baichuan', open_by: 'url', url: SHOP_URL },
    },
    fallbacks: [{ type: 'h5', value: SHOP_URL }],
    expire_at: '2031-05-06T07:23:09.000Z',
  },
};

export interface Harness {
  readonly send: Send;
  readonly open: ReturnType<typeof vi.fn<(input: ShopOpenInput) => Promise<HandlerResult>>>;
  /** The minimum supported version the gate reads; null lets every version through. */
  minimum(value: string | null): void;
}

export async function withHttp(check: (harness: Harness) => Promise<void>) {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', root).href)) as {
    AppModule: { forEntry(options: unknown): ModuleShape };
  };
  const { LinkingModule } = (await import(
    new URL('apps/api/src/modules/linking/linking.module.ts', root).href
  )) as {
    LinkingModule: { forRoot(options: unknown): ModuleShape };
  };
  const { RiskModule } = (await import(
    new URL('apps/api/src/modules/risk/risk.module.ts', root).href
  )) as {
    RiskModule: { forRoot(options: Record<string, unknown>): ModuleShape };
  };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: ReturnType<typeof createRootLogger>;
      },
    ): Promise<HttpApp>;
  };
  const clock = new FixedClock('2031-05-06T07:08:09.000Z');
  const signingMaterial = randomBytes(32).toString('hex');
  const deviceId = randomUUID();
  const principal = {
    uid: randomUUID(),
    app_id: 'couli',
    sid: randomUUID(),
    device_id: deviceId,
    scp: 'full' as const,
  };
  const signature = createSignatureCheck({
    clock,
    devices: {
      findActive: async () => ({ appId: 'couli', deviceId, installSecret: signingMaterial }),
    },
    redis: {
      namespace: () => ({
        get: async () => null,
        set: async () => undefined,
        eval: async () => 'OK',
      }),
    },
  });
  const tokenCheck = createTokenCheck({
    tokens: {
      verifyAccess: async () => principal,
      issueAccess: async () => 'synthetic-access',
      issueRefresh: () => ({
        token: 'synthetic-refresh',
        hash: 'synthetic-hash',
        expireAt: clock.now(),
      }),
    },
    sessions: { find: async () => ({ revoked_at: null }) },
  });
  let minimum: string | null = null;
  const minSupportedVersion = async () => minimum;
  const open = vi.fn<(input: ShopOpenInput) => Promise<HandlerResult>>(async () => ({
    status: 200,
    envelope: { code: 0, msg: 'ok', trace_id: traceId, data },
  }));
  const logger = createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' });
  // The real idempotency primitive; only its PG wire storage is in memory (no sockets, no SQL
  // server). Provided as the app's IDEMPOTENCY, so RiskModule registers ④a's post-miss check and
  // entry observer on this very instance.
  const storage = idempotencyStorage();
  const idempotency = createIdempotency({ db: storage.db, clock, logger });
  // The use case's idempotency step: the caller (the verified principal) as subject, the decoded
  // product_key's path, the contract body and the Idempotency-Key; a miss runs the case's `open`
  // after the post-miss checks (④a), a replay or refusal of the primitive never reaches it.
  const shops = {
    async open(input: ShopOpenInput): Promise<HandlerResult> {
      const response = await idempotency.executeInTransaction(
        {
          appId: principal.app_id,
          actor: { userId: principal.uid, deviceId: principal.device_id, phoneHmac: null },
          method: 'POST',
          path: `/v1/products/${encodeURIComponent(input.productKey)}/shop/open`,
          key: input.idempotencyKey,
          body: input.body,
          traceId: input.traceId,
        },
        () => open(input),
      );
      return {
        status: response.status,
        envelope: JSON.parse(response.body) as HandlerResult['envelope'],
      };
    },
  };
  const originalRoot = AppModule.forEntry.bind(AppModule);
  const originalPlatform = PlatformModule.forRoot.bind(PlatformModule);
  const originalLinking = LinkingModule.forRoot.bind(LinkingModule);
  const originalRisk = RiskModule.forRoot.bind(RiskModule);
  const platformSpy = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = originalPlatform(options);
    return {
      ...module,
      providers: [...(module.providers ?? []), { provide: IDEMPOTENCY, useValue: idempotency }],
      exports: [...(module.exports ?? []), IDEMPOTENCY],
    };
  });
  const linkSpy = vi.spyOn(LinkingModule, 'forRoot').mockImplementation((options) => {
    const module = originalLinking(options);
    return {
      ...module,
      providers: [...(module.providers ?? []), { provide: ShopOpenService, useValue: shops }],
    };
  });
  const riskSpy = vi.spyOn(RiskModule, 'forRoot').mockImplementation((options) =>
    originalRisk({
      ...options,
      minimumVersions: {
        useFactory: () => ({
          pooled: { minSupportedVersion },
          on: () => ({ minSupportedVersion }),
        }),
      },
    }),
  );
  const rootSpy = vi.spyOn(AppModule, 'forEntry').mockImplementation((options) => {
    const module = originalRoot(options);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []),
        {
          provide: REQUEST_CHECKS,
          useValue: { checks: [signature, tokenCheck], bufferWhen: isContractSignedRoute },
        },
      ],
    };
  });
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('api', {
      clock,
      config: loadConfig({ APP_ENV: 'test' }),
      logger,
    });
    await app.init();
    const server = app;
    const send: Send = async (input, overrides = {}, url = PATH) => {
      const payload = JSON.stringify(input);
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const sign = createHmac('sha256', signingMaterial)
        .update(
          ['POST', url, timestamp, nonce, createHash('sha256').update(payload).digest('hex')].join(
            '\n',
          ),
        )
        .digest('hex');
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-app-id': 'couli',
        'x-platform': 'ios',
        'x-app-version': '1.0.0',
        'x-device-id': deviceId,
        'x-channel': 'appstore',
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign,
        'x-trace-id': traceId,
        'idempotency-key': IDEMPOTENCY_KEY,
        authorization: 'Bearer synthetic-access',
      };
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete headers[name];
        else headers[name] = value;
      }
      return server.inject({ method: 'POST', url, payload, headers });
    };
    // Each case first proves the implemented route exists and reaches the use case. Its own
    // Idempotency-Key: the case's first request with IDEMPOTENCY_KEY is then a miss, never a
    // replay of (or a 20901 conflict with) this one.
    const ready = await send(body, { 'idempotency-key': READY_IDEMPOTENCY_KEY });
    expect(ready.statusCode).toBe(200);
    expect(open).toHaveBeenCalledTimes(1);
    open.mockClear();
    await check({
      send,
      open,
      minimum: (value) => {
        minimum = value;
      },
    });
  } finally {
    rootSpy.mockRestore();
    riskSpy.mockRestore();
    linkSpy.mockRestore();
    platformSpy.mockRestore();
    try {
      await app?.close();
    } finally {
      await storage.db.destroy();
    }
  }
}
