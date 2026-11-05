// B1-06zf rule-test kit (FU-PDD-AUTH-LINK, D10-647): the Pinduoduo authorization link of the open's
// 30111 auth_jump and of GET /v1/unions/pdd/auth-url, through the real api entry (createHttpApp +
// inject) over a throwaway PostgreSQL and Redis, an injected FixedClock and a local field keyring.
// Nothing in AppModule or LinkingModule is replaced: identity's caller and attr_code ports, the
// signature and token checks, idempotency, link registration, the governed demo union adapters and
// the demo quoter are the entry's own. Requests are signed with the install secret of a device
// registered through POST /v1/devices and carry a session token of identity's own token service.
// Observed on DemoUnionAdapter (called through and recorded):
// - pddAuthorityUrl: every call with its identity, context and answer. A case may make it reject
//   with a union error (failAuthorityUrl), answer obvious demo values it sets (answerAuthorityUrl),
//   or build the entry without the port at all
//   (authorityUrl: 'missing': the method is taken off the demo prototype before the entry starts);
// - queryPddAuthority: called through with the demo's own `pdd_unauthorized` scenario until a case
//   files its users (fileUsers), so an open is "not filed" unless the case says otherwise;
// - convert: called through, its identity recorded.
// Every case seeds its own App (tenant): union accounts, active Pinduoduo promotion slots of four
// scenes (distinct pids), configuration and users, so caches, links and states never cross cases.
// A tenant may also get a second Pinduoduo account, registered after the first, with its own slots
// of every scene (secondAccount), and may have listed slots seeded retired instead of active.
// Only *.int.test.ts import @couli/db/testing and hand its factories in.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { isServerIdentity } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DemoUnionAdapter,
  type CallCtx,
  type PddAuthorityUrl,
  type UnionIdentity,
} from '../../../../apps/api/src/modules/union/index.ts';

export const NOW = '2026-11-05T02:00:00.000Z';
/** BR-ID-17: a state lives 10 minutes. */
export const STATE_TTL_MS = 600_000;
/** Opens of one case are this far apart: past the open's single-flight window. */
export const OPEN_GAP_MS = 3_001;
export const PDD_SCENES = ['self_buy', 'query', 'share', 'agent'] as const;
export type PddScene = (typeof PDD_SCENES)[number];
/** The tenant's first Pinduoduo account, or the second one registered a minute after it. */
export type PddAccount = 'first' | 'second';
/** A promotion slot of one account (the first when account is omitted). */
export interface SlotRef {
  readonly scene: PddScene;
  readonly account?: PddAccount;
}
export interface TenantOptions {
  /** A second Pinduoduo account with its own slots of every scene, all registered later. */
  readonly secondAccount?: boolean;
  /** These slots are seeded retired instead of active (their pid values still exist). */
  readonly retired?: readonly SlotRef[];
}
export type AuthData = components['schemas']['UnionAuthUrlData'];
export type AuthJumpPlan = components['schemas']['AuthJumpPlan'];
export type BindingStatus = 'pending_auth' | 'invalid' | 'active' | 'blocked';

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  readonly url: string;
  stop(): Promise<void>;
}
export interface Provisioning {
  createTestDatabase(): Promise<TestDatabase>;
  acquireTestRedis(): Promise<TestRedis>;
}

export interface HarnessOptions {
  /** 'missing': the entry starts with demo adapters that have no pddAuthorityUrl port. */
  readonly authorityUrl?: 'present' | 'missing';
}

export interface InjectResponse {
  readonly statusCode: number;
  readonly payload: string;
  json(): unknown;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<InjectResponse>;
}

/** One pddAuthorityUrl call of a demo adapter; result null when it rejected. */
export interface AuthorityUrlCall {
  readonly identity: UnionIdentity;
  readonly ctx: CallCtx;
  readonly result: PddAuthorityUrl | null;
}

/** One queryPddAuthority or convert call of a demo adapter. */
export interface IdentityCall {
  readonly identity: UnionIdentity;
  readonly ctx: CallCtx;
}

export interface AppUser {
  readonly uid: string;
  readonly attrCode: string;
  readonly deviceId: string;
  /** GET /v1/products/search?platform=pdd as this user: the first card's registered link_id. */
  searchLink(): Promise<string>;
  /**
   * The user's own link of the agent scene: a copy of a fresh search link of theirs registered
   * under the first account's agent slot (scene agent, pid_scene agent, the snapshot to match).
   */
  agentLink(): Promise<string>;
  /** GET /v1/unions/{platform}/auth-url?installed=false as this user. */
  authUrl(platform: 'pdd' | 'taobao'): Promise<InjectResponse>;
  /** POST /v1/links/{link_id}/open (installed=false), signed, a fresh Idempotency-Key. */
  open(linkId: string): Promise<InjectResponse>;
  /** GET /v1/unions/bindings as this user (the authorization page). */
  bindings(): Promise<InjectResponse>;
}

export interface Tenant {
  readonly appId: string;
  readonly pddAccountId: string;
  /** The second Pinduoduo account (null unless the tenant was seeded with one). */
  readonly secondPddAccountId: string | null;
  /** The Pinduoduo promotion slot (pid) of the scene on the account (first by default). */
  pid(scene: PddScene, account?: PddAccount): string;
  user(): Promise<AppUser>;
  /** Writes a Pinduoduo binding of the user on the account (first by default). */
  bind(uid: string, status: BindingStatus, account?: PddAccount): Promise<void>;
  /** union_auth_sessions of the App, whole rows, oldest first. */
  sessions(): ReturnType<typeof sessionsOf>;
  /** union_bindings of the App (pdd), whole rows. */
  bindings(): ReturnType<typeof bindingsOf>;
}

export interface AuthorityHarness {
  readonly clock: FixedClock;
  db(): Kysely<DB>;
  tenant(options?: TenantOptions): Promise<Tenant>;
  /** Recorded pddAuthorityUrl calls (of one App when appId is given), in call order. */
  authorityUrlCalls(appId?: string): readonly AuthorityUrlCall[];
  /** Recorded queryPddAuthority calls of one App. */
  queryCalls(appId: string): readonly IdentityCall[];
  /** Recorded convert calls of one App. */
  convertCalls(appId: string): readonly IdentityCall[];
  /** Every filing query of the rest of the case answers through the demo as "filed". */
  fileUsers(): void;
  /** Every pddAuthorityUrl of the rest of the case rejects with this error. */
  failAuthorityUrl(error: Error): void;
  /**
   * Every pddAuthorityUrl of the rest of the case answers this (obvious demo values only, never a
   * Pinduoduo payload); the call is still recorded with it as the result.
   */
  answerAuthorityUrl(answer: PddAuthorityUrl): void;
}

export function hex(length: number): string {
  return randomUUID().replaceAll('-', '').slice(0, length);
}

function sessionsOf(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('union_auth_sessions')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('created_at')
    .orderBy('state')
    .execute();
}

function bindingsOf(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('union_bindings')
    .selectAll()
    .where('app_id', '=', appId)
    .where('platform', '=', 'pdd')
    .orderBy('id')
    .execute();
}

let address = 0;
/** A fresh client address per user: per-IP limits of one user never meet another's. */
function nextAddress(): string {
  address++;
  return `10.16.${Math.floor(address / 250) % 250}.${(address % 250) + 1}`;
}

const originalAuthorityUrl = DemoUnionAdapter.prototype.pddAuthorityUrl;
const originalAuthority = DemoUnionAdapter.prototype.queryPddAuthority;
const originalConvert = DemoUnionAdapter.prototype.convert;
const originalQuoter = catalog.createDemoRebateQuoter;

/** Registers the file's hooks: one api entry for the whole file. */
export function authorityHarness(
  provisioning: Provisioning,
  options: HarnessOptions = {},
): AuthorityHarness {
  const clock = new FixedClock(NOW);
  const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
  const missing = options.authorityUrl === 'missing';
  const urlCalls: AuthorityUrlCall[] = [];
  const queries: IdentityCall[] = [];
  const converts: IdentityCall[] = [];
  let filed = false;
  let urlFailure: Error | null = null;
  let urlAnswer: PddAuthorityUrl | null = null;
  let ruleKey: string | undefined;
  let removed: PropertyDescriptor | undefined;
  let database: TestDatabase | undefined;
  let redis: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  let app: HttpApp | undefined;
  let directory: string | undefined;

  beforeAll(async () => {
    database = await provisioning.createTestDatabase();
    redis = await provisioning.acquireTestRedis();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
    await db
      .updateTable('platforms')
      .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
      .where('code', 'in', ['taobao', 'pdd'])
      .execute();

    if (missing) {
      // The port is absent on every demo adapter the entry builds (the governed wrapper copies
      // only the optional ports an adapter has).
      removed = Object.getOwnPropertyDescriptor(DemoUnionAdapter.prototype, 'pddAuthorityUrl');
      Reflect.deleteProperty(DemoUnionAdapter.prototype, 'pddAuthorityUrl');
    } else {
      vi.spyOn(DemoUnionAdapter.prototype, 'pddAuthorityUrl').mockImplementation(async function (
        this: DemoUnionAdapter,
        identity,
        context,
      ) {
        if (urlFailure !== null) {
          urlCalls.push({ identity, ctx: context, result: null });
          throw urlFailure;
        }
        if (urlAnswer !== null) {
          const answer = { ...urlAnswer };
          urlCalls.push({ identity, ctx: context, result: answer });
          return answer;
        }
        const result = await originalAuthorityUrl.call(this, identity, context);
        urlCalls.push({ identity, ctx: context, result });
        return result;
      });
    }
    vi.spyOn(DemoUnionAdapter.prototype, 'queryPddAuthority').mockImplementation(async function (
      this: DemoUnionAdapter,
      identity,
      context,
    ) {
      queries.push({ identity, ctx: context });
      // The demo's own "not filed" scenario; no answer is made up here.
      const asked: CallCtx = filed ? context : { ...context, scenario: 'pdd_unauthorized' };
      return originalAuthority.call(this, identity, asked);
    });
    vi.spyOn(DemoUnionAdapter.prototype, 'convert').mockImplementation(async function (
      this: DemoUnionAdapter,
      request,
      identity,
      context,
    ) {
      converts.push({ identity, ctx: context });
      return originalConvert.call(this, request, identity, context);
    });
    vi.spyOn(catalog, 'createDemoRebateQuoter').mockImplementation((quoterOptions) => {
      ruleKey = quoterOptions.ruleConfigKey;
      return originalQuoter(quoterOptions);
    });

    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    directory = mkdtempSync(join(base, 'b1-06zf-'));
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(directory, 'master.hex');
    const keyringFile = join(directory, 'keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp(
        entry: 'api',
        bootstrap: {
          config: ReturnType<typeof loadConfig>;
          clock: FixedClock;
          logger: typeof logger;
          dbHandles: DbHandles;
          redisUrl: ConnectionConfig['redisUrl'];
        },
      ): Promise<HttpApp>;
    };
    const connection = loadConnectionConfig('api', {
      DATABASE_URL: database.urlFor('couli_app'),
      REDIS_URL: redis.url,
    });
    app = await createHttpApp('api', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: masterFile,
        FIELD_KEYRING_FILE: keyringFile,
      }),
      clock,
      logger,
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: connection.redisUrl,
    });
    await app.init();
    // The entry's own quoter reads its synthetic rule from this key; every tenant seeds it.
    expect(ruleKey).toEqual(expect.any(String));
  }, 180_000);

  beforeEach(() => {
    clock.set(NOW);
  });

  afterEach(() => {
    filed = false;
    urlFailure = null;
    urlAnswer = null;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      vi.restoreAllMocks();
      if (removed !== undefined) {
        Object.defineProperty(DemoUnionAdapter.prototype, 'pddAuthorityUrl', removed);
      }
      try {
        if (db !== undefined) await destroyDb(db);
      } finally {
        try {
          await database?.drop();
        } finally {
          try {
            await redis?.stop();
          } finally {
            if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    }
  }, 60_000);

  const handle = (): Kysely<DB> => db!;
  const server = (): HttpApp => app!;

  async function setConfig(appId: string, key: string, value: unknown): Promise<void> {
    await handle()
      .insertInto('config_items')
      .values({ app_id: appId, key, value: JSON.stringify(value), updated_by: 'synthetic-b1-06zf' })
      .execute();
  }

  async function tenant(options: TenantOptions = {}): Promise<Tenant> {
    const appId = `pdd_link_${hex(20)}`;
    const pddAccountId = randomUUID();
    const taobaoAccountId = randomUUID();
    const secondPddAccountId = options.secondAccount === true ? randomUUID() : null;
    // The second account and its slots come a minute later: the app-wide self_buy slot and the
    // earliest account stay the first account's, so only a per-account read reaches the second.
    const later = new Date(clock.now().getTime() + 60_000);
    const accounts: [string, 'pdd' | 'taobao', Date][] = [
      [pddAccountId, 'pdd', clock.now()],
      [taobaoAccountId, 'taobao', clock.now()],
    ];
    if (secondPddAccountId !== null) accounts.push([secondPddAccountId, 'pdd', later]);
    for (const [id, platform, at] of accounts) {
      await handle()
        .insertInto('union_accounts')
        .values({
          id,
          app_id: appId,
          platform,
          account_name: `synthetic-b1-06zf-${platform}-${id.slice(0, 8)}`,
          status: 'active',
          auth_status: 'active',
          created_at: at,
          updated_at: at,
        })
        .execute();
    }
    const retired = (scene: PddScene, account: PddAccount): boolean =>
      (options.retired ?? []).some(
        (slot) => slot.scene === scene && (slot.account ?? 'first') === account,
      );
    const pids = new Map<string, string>();
    const slotAccounts: [PddAccount, string, Date][] = [['first', pddAccountId, clock.now()]];
    if (secondPddAccountId !== null) slotAccounts.push(['second', secondPddAccountId, later]);
    for (const [account, accountId, at] of slotAccounts) {
      for (const scene of PDD_SCENES) {
        const pid = `synthetic-pdd-${account}-${scene}-${hex(10)}`;
        pids.set(`${account}:${scene}`, pid);
        await handle()
          .insertInto('union_pids')
          .values({
            id: randomUUID(),
            app_id: appId,
            platform: 'pdd',
            union_account_id: accountId,
            site_id: null,
            pid,
            pid_scene: scene,
            status: retired(scene, account) ? 'retired' : 'active',
            hjy_ignore_confirmed_at: at,
            hjy_ignore_evidence_path: 'https://example.test/synthetic-evidence',
            created_at: at,
            updated_at: at,
          })
          .execute();
      }
    }
    const settings: [string, unknown][] = [
      ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
      ['link.open.requote_after_sec', 0],
      ['attr.click_code.jd', false],
      ['attr.click_code.pdd', false],
      ['search.enabled.pdd', true],
      ['convert.enabled.pdd', true],
      ['rebate.pdd.compare_rate_ratio_bp', 5000],
      [String(ruleKey), { reserve_bp: 0, self_share_bp: 10000 }],
    ];
    for (const [key, value] of settings) await setConfig(appId, key, value);

    function pid(scene: PddScene, account: PddAccount = 'first'): string {
      const value = pids.get(`${account}:${scene}`);
      if (value === undefined) throw new Error(`synthetic tenant: no ${account} account slot`);
      return value;
    }

    function accountIdOf(account: PddAccount): string {
      if (account === 'first') return pddAccountId;
      if (secondPddAccountId === null) throw new Error('synthetic tenant: no second account');
      return secondPddAccountId;
    }

    async function bind(
      uid: string,
      status: BindingStatus,
      account: PddAccount = 'first',
    ): Promise<void> {
      await handle()
        .insertInto('union_bindings')
        .values({
          id: randomUUID(),
          app_id: appId,
          user_id: uid,
          platform: 'pdd',
          union_account_id: accountIdOf(account),
          relation_id: null,
          pdd_custom: JSON.stringify({ synthetic: 'stored' }),
          status,
          bound_at: status === 'active' ? clock.now() : null,
          blocked_reason: status === 'blocked' ? 'admin_disable' : null,
          released_at: null,
          cooldown_until: null,
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
    }

    async function user(): Promise<AppUser> {
      const ip = nextAddress();
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-app-id': appId,
        'x-platform': 'ios',
        'x-app-version': '2.0.0',
        'x-channel': 'official',
      };
      const registered = await server().inject({
        method: 'POST',
        url: '/v1/devices',
        headers: { ...headers, 'x-trace-id': randomUUID() },
        payload: JSON.stringify({
          device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
          id_source: 'idfv',
        }),
        remoteAddress: ip,
      });
      expect(registered.statusCode, registered.payload).toBe(200);
      const device = (registered.json() as { data: { device_id: string; install_secret: string } })
        .data;

      const uid = randomUUID();
      const attrCode = hex(8);
      await handle()
        .insertInto('users')
        .values({
          id: uid,
          app_id: appId,
          nickname: '合成授权用户',
          avatar: 'https://example.test/avatar',
          invite_code: Array.from(
            randomBytes(6),
            (n) => INVITE_ALPHABET[n % INVITE_ALPHABET.length],
          ).join(''),
          attr_code: attrCode,
          level: 'L1',
          register_method: 'sms',
          status: 'normal',
          phone_hmac: randomBytes(32).toString('hex'),
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      await handle()
        .insertInto('user_risk_state')
        .values({
          app_id: appId,
          user_id: uid,
          state: 'normal',
          changed_by: 'synthetic',
          changed_at: clock.now(),
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      const session = await handle()
        .transaction()
        .execute((trx) =>
          createSession(
            trx,
            { uid, app_id: appId, device_id: device.device_id, scp: 'full' },
            { clock, tokens: server().get<TokenService>(TOKEN_SERVICE) },
          ),
        );
      const signedIn = {
        ...headers,
        'x-device-id': device.device_id,
        authorization: `Bearer ${session.access_token}`,
      };

      async function searchLink(): Promise<string> {
        const query = new URLSearchParams({ platform: 'pdd', q: '演示商品', limit: '1' });
        const response = await server().inject({
          method: 'GET',
          url: `/v1/products/search?${query}`,
          headers: { ...signedIn, 'x-trace-id': randomUUID() },
          remoteAddress: ip,
        });
        expect(response.statusCode, response.payload).toBe(200);
        const body = response.json() as {
          code: number;
          data: { items: { link_id?: string | null }[] };
        };
        expect(body.code).toBe(0);
        const linkId = body.data.items[0]?.link_id;
        expect(linkId).toEqual(expect.any(String));
        return String(linkId);
      }

      async function agentLink(): Promise<string> {
        const source = await handle()
          .selectFrom('links')
          .selectAll()
          .where('app_id', '=', appId)
          .where('link_id', '=', await searchLink())
          .executeTakeFirstOrThrow();
        expect(source.user_id).toBe(uid);
        const linkId = randomUUID();
        const agentPid = pid('agent');
        // The search registration's attr_code stays; only the scene and its slot change.
        const stored = source.identity_snapshot as unknown as { readonly attr_code?: unknown };
        await handle()
          .insertInto('links')
          .values({
            ...source,
            link_id: linkId,
            lk: null,
            scene: 'agent',
            sub_scene: null,
            pid_scene: 'agent',
            pid: agentPid,
            identity_snapshot: {
              user_id: uid,
              platform: 'pdd',
              pid: agentPid,
              pid_scene: 'agent',
              attr_code: typeof stored.attr_code === 'string' ? stored.attr_code : attrCode,
              agent_session_id: null,
            },
            convert_result: null,
            cache_hit: false,
            agent_session_id: null,
            agent_card_id: null,
            row_version: 0,
            created_at: clock.now(),
            updated_at: clock.now(),
          })
          .execute();
        return linkId;
      }

      function authUrl(platform: 'pdd' | 'taobao'): Promise<InjectResponse> {
        return server().inject({
          method: 'GET',
          url: `/v1/unions/${platform}/auth-url?installed=false`,
          headers: { ...signedIn, 'x-trace-id': randomUUID() },
          remoteAddress: ip,
        });
      }

      function open(linkId: string): Promise<InjectResponse> {
        clock.advanceMs(OPEN_GAP_MS);
        const path = `/v1/links/${linkId}/open`;
        const payload = JSON.stringify({ installed: 'false', no_rebate: false });
        const timestamp = String(Math.floor(clock.now().getTime() / 1000));
        const nonce = randomBytes(16).toString('hex');
        const digest = createHash('sha256').update(payload).digest('hex');
        const sign = createHmac('sha256', device.install_secret)
          .update(['POST', path, timestamp, nonce, digest].join('\n'))
          .digest('hex');
        return server().inject({
          method: 'POST',
          url: path,
          payload,
          headers: {
            ...signedIn,
            'x-timestamp': timestamp,
            'x-nonce': nonce,
            'x-sign': sign,
            'x-trace-id': randomUUID(),
            'idempotency-key': randomUUID(),
          },
          remoteAddress: ip,
        });
      }

      function bindings(): Promise<InjectResponse> {
        return server().inject({
          method: 'GET',
          url: '/v1/unions/bindings',
          headers: { ...signedIn, 'x-trace-id': randomUUID() },
          remoteAddress: ip,
        });
      }

      return {
        uid,
        attrCode,
        deviceId: device.device_id,
        searchLink,
        agentLink,
        authUrl,
        open,
        bindings,
      };
    }

    return {
      appId,
      pddAccountId,
      secondPddAccountId,
      pid,
      user,
      bind,
      sessions: () => sessionsOf(handle(), appId),
      bindings: () => bindingsOf(handle(), appId),
    };
  }

  return {
    clock,
    db: handle,
    tenant,
    authorityUrlCalls: (appId) =>
      appId === undefined ? [...urlCalls] : urlCalls.filter((call) => call.ctx.appId === appId),
    queryCalls: (appId) => queries.filter((call) => call.ctx.appId === appId),
    convertCalls: (appId) => converts.filter((call) => call.ctx.appId === appId),
    fileUsers: () => {
      filed = true;
    },
    failAuthorityUrl: (error) => {
      urlFailure = error;
    },
    answerAuthorityUrl: (answer) => {
      urlAnswer = answer;
    },
  };
}

let schemas: Promise<Record<string, JsonSchema>> | undefined;
export async function validate(
  value: unknown,
  name: 'UnionAuthUrlResponse' | 'ErrorEnvelope' | 'OpenLinkResponse',
): Promise<void> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((contract) => contract.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}

/** A 200 auth-url that passes the contract; its data. */
export async function issued(response: InjectResponse): Promise<AuthData> {
  expect(response.statusCode, response.payload).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({ code: 0 });
  await validate(body, 'UnionAuthUrlResponse');
  return (body as { data: AuthData }).data;
}

/** A 200 open that passes the contract. */
export async function opened(response: InjectResponse): Promise<void> {
  expect(response.statusCode, response.payload).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({ code: 0 });
  await validate(body, 'OpenLinkResponse');
}

/** An error envelope of the given HTTP status and code that passes the contract. */
export async function refused(
  response: InjectResponse,
  status: number,
  code: number,
): Promise<{ readonly code: number; readonly data?: Readonly<Record<string, unknown>> }> {
  expect(response.statusCode, response.payload).toBe(status);
  const body = response.json();
  expect(body).toMatchObject({ code });
  await validate(body, 'ErrorEnvelope');
  return body as { code: number; data?: Record<string, unknown> };
}

/**
 * The web address the h5 step (and auth_url) must carry for one recorded answer (D10-662):
 * mobile_short_url, else url — never schema_url. Independent of the implementation's own picker.
 */
export function expectedLink(result: PddAuthorityUrl | null): string {
  expect(result, 'pddAuthorityUrl answered').not.toBeNull();
  const answer = result!;
  const link = [answer.mobile_short_url, answer.url].find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  expect(link, 'the answer carries a web address').toEqual(expect.any(String));
  expect(new URL(String(link)).protocol, 'the web address is https').toBe('https:');
  return String(link);
}

/** The upstream App scheme of one recorded answer (D10-662): schema_url as is, else null. */
export function expectedScheme(result: PddAuthorityUrl | null): string | null {
  expect(result, 'pddAuthorityUrl answered').not.toBeNull();
  const scheme = result!.schema_url;
  return typeof scheme === 'string' && scheme !== '' ? scheme : null;
}

/**
 * D10-662 over every step of a plan: an h5 step carries the web address; a scheme step carries the
 * upstream schema_url exactly (never wrapped), and only when there is one; no other step carries
 * the upstream scheme, raw or encoded.
 */
export function expectAuthSteps(plan: unknown, result: PddAuthorityUrl | null): void {
  const web = expectedLink(result);
  const scheme = expectedScheme(result);
  const typed = plan as AuthJumpPlan;
  for (const step of [typed.primary, ...typed.fallbacks]) {
    if (step.type === 'h5') expect(step.value).toBe(web);
    if (step.type === 'scheme' && scheme !== null) expect(step.value).toBe(scheme);
    if (scheme !== null && step.type !== 'scheme') {
      expect(step.value).not.toContain(scheme);
      expect(step.value).not.toContain(encodeURIComponent(scheme));
    }
  }
}

/** The installed=false plan over one link: the h5 step alone (BR-ATTR-27, launch plan unchanged). */
export function planOver(link: string): Record<string, unknown> {
  return {
    primary: { type: 'h5', value: link },
    fallbacks: [],
    expire_at: expect.any(String),
  };
}

/** Every step value of a plan. */
export function planValues(plan: unknown): string[] {
  const typed = plan as AuthJumpPlan;
  return [typed.primary, ...typed.fallbacks].map((step) => step.value);
}

/** Neither the state nor the placeholder host is in any of the links. */
export function expectNoState(links: readonly string[], state: string): void {
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link).not.toContain('example.test');
    expect(link).not.toContain(state);
    expect(link).not.toContain(encodeURIComponent(state));
    expect(link).not.toContain(state.replace(/^st_/, ''));
  }
}

/** custom_parameters of a server-built identity (LinkingUnionIdentity), as the adapter reads it. */
export function customOf(identity: UnionIdentity): unknown {
  return (identity as unknown as { readonly custom_parameters?: unknown }).custom_parameters;
}

/**
 * The identity pddAuthorityUrl was called with is the conversion's: this App, the scene's active
 * slot of the account in use, custom_parameters {app:'n', uid=attr_code, sc}, never a user_id.
 */
export function expectAuthorityIdentity(
  call: IdentityCall,
  expected: {
    readonly appId: string;
    readonly pid: string;
    readonly attrCode: string;
    readonly scene: PddScene;
    readonly privateValues: readonly string[];
  },
): void {
  expect(isServerIdentity(call.identity)).toBe(true);
  expect(call.identity.claims).toMatchObject({
    appId: expected.appId,
    platform: 'pdd',
    promotionSlot: expected.pid,
    userId: expected.attrCode,
    relationId: null,
  });
  expect(customOf(call.identity)).toEqual({
    app: 'n',
    uid: expected.attrCode,
    sc: expected.scene,
  });
  expect(call.ctx).toMatchObject({ appId: expected.appId, purpose: 'online' });
  const serialized = JSON.stringify(call.identity);
  for (const value of ['user_id', 'device_id', ...expected.privateValues]) {
    expect(serialized).not.toContain(value);
  }
}
