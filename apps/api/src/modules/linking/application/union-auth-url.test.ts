// Unit tests of the auth-url use case without a database (B1-06g fund review round 1): Kysely runs
// on a scripted driver answering the few read-only selects by table, to pin
//   - the site authorization judged on the union account this authorization actually uses (the
//     unreleased binding's, else the active self_buy pid's), never masked by another valid account;
//   - the Pinduoduo auth_jump built by the open's BR-ATTR-27 matrix from the device record's client
//     and installed (non-prod android installed=true: the app scheme first, the page after).
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/linking/auth-url).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionPidRow } from '../../union/index.ts';
import { createDemoUnionAuthApps } from '../infra/auth-apps.ts';
import { appSchemeOf, buildDefaultLinkJump, pathsOf } from './link-open-conversion.ts';
import type { LinkOpenApps, LinkOpenEnvironment } from './link-open-wiring.ts';
import { createUnionAuthUrl, type UnionAuthUrlOptions } from './union-auth-url.ts';

type UnionRegistryPort = NonNullable<UnionAuthUrlOptions['registry']>;

const TRACE = '0199a3b4-5c6d-7000-8000-0000000000bb';
const APP = 'synthetic_app';
const USER = '0199a3b4-5c6d-7000-8000-000000000001';
const DEVICE = '0199a3b4-5c6d-7000-8000-000000000002';
const EXPIRED_ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000e1';
const VALID_ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000a1';

interface Account {
  readonly id: string;
  readonly platform: 'taobao' | 'pdd';
  readonly auth_status: 'active' | 'expiring' | 'expired';
}

interface Scenario {
  readonly client: 'ios' | 'android' | 'harmony';
  /** Ordered as the first-account fallback would read them. */
  readonly accounts: readonly Account[];
  readonly bindings?: readonly { readonly status: string; readonly union_account_id: string }[];
  readonly pidAccount?: string;
  readonly jumpEnvironment?: LinkOpenEnvironment;
  /** B1-06zf: the pdd filing link port; 'missing' → no registry, 'fails' → it rejects. */
  readonly authorityUrl?: 'answers' | 'missing' | 'fails';
  /** D10-662: the union answers no schema_url (the scheme step is then derived). */
  readonly noSchemaUrl?: boolean;
}

const ATTR_CODE = 'a1b2c3d4';
const PDD_PID = 'synthetic-pdd-pid';
const SCHEMA_LINK = 'couli-demo://pdd/authority/unit';
const WEB_LINK = 'https://demo.invalid/pdd/authority/m/unit';

function setup(scenario: Scenario) {
  const inserts: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const { sql, parameters } = compiled;
      const rows = (list: readonly object[]) => Promise.resolve({ rows: list } as QueryResult<R>);
      if (sql.startsWith('insert')) {
        inserts.push(compiled);
        return rows([]);
      }
      if (sql.includes('"devices"')) return rows([{ platform: scenario.client, revoked_at: null }]);
      if (sql.includes('"union_bindings"')) return rows(scenario.bindings ?? []);
      if (sql.includes('"user_risk_state"')) return rows([{ state: 'normal' }]);
      if (sql.includes('"union_accounts"')) {
        const platform = scenario.accounts.filter((a) => parameters.includes(a.platform));
        if (sql.includes('"id" =')) {
          return rows(platform.filter((a) => parameters.includes(a.id)));
        }
        return rows(platform.slice(0, 1));
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const getActivePid = vi.fn<NonNullable<UnionAuthUrlOptions['pids']>['getActivePid']>(
    async (input) =>
      scenario.pidAccount === undefined
        ? null
        : ({
            app_id: input.appId,
            platform: input.platform,
            pid_scene: input.pidScene,
            status: 'active',
            union_account_id: scenario.pidAccount,
            pid: PDD_PID,
          } as unknown as UnionPidRow),
  );
  const pddAuthorityUrl = vi.fn(async () => {
    if (scenario.authorityUrl === 'fails') throw new Error('synthetic refusal');
    return {
      url: 'https://demo.invalid/pdd/authority/page/unit',
      ...(scenario.noSchemaUrl === true ? {} : { schema_url: SCHEMA_LINK }),
      mobile_short_url: WEB_LINK,
    };
  });
  const registry = {
    get: () => ({ pddAuthorityUrl }) as unknown as ReturnType<UnionRegistryPort['get']>,
  };
  const clock = new FixedClock('2026-10-08T00:00:00.000Z');
  const auth = createUnionAuthUrl({
    db,
    clock,
    appEnv: 'test',
    callerContext: { current: async () => ({ appId: APP, userId: USER, deviceId: DEVICE }) },
    config: { configValue: async () => null },
    authApps: createDemoUnionAuthApps(),
    pids: { getActivePid },
    attrCodes: { attrCode: async () => ATTR_CODE },
    ...(scenario.authorityUrl === 'missing' ? {} : { registry }),
    ...(scenario.jumpEnvironment === undefined
      ? {}
      : { jumpEnvironment: scenario.jumpEnvironment }),
  });
  return { auth, inserts, getActivePid, clock, pddAuthorityUrl };
}

describe('createUnionAuthUrl site authorization of the account in use', () => {
  it('[AC-B1-06g#6] the bound account expired → 30102 even while another account of the platform is valid', async () => {
    const { auth, inserts, getActivePid } = setup({
      client: 'ios',
      accounts: [
        { id: VALID_ACCOUNT, platform: 'taobao', auth_status: 'active' },
        { id: EXPIRED_ACCOUNT, platform: 'taobao', auth_status: 'expired' },
      ],
      bindings: [{ status: 'invalid', union_account_id: EXPIRED_ACCOUNT }],
      pidAccount: VALID_ACCOUNT,
    });
    const result = await auth.get({ platform: 'taobao', reportedClient: 'ios', traceId: TRACE });
    expect(result.envelope).toMatchObject({ code: 30102, data: { reason: 'auth_unavailable' } });
    expect(result.envelope).not.toHaveProperty('data.state');
    expect(getActivePid).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('[AC-B1-06g#6] unbound: the active self_buy pid account expired → 30101 even while the first account is valid', async () => {
    const { auth, inserts, getActivePid } = setup({
      client: 'ios',
      accounts: [
        { id: VALID_ACCOUNT, platform: 'taobao', auth_status: 'active' },
        { id: EXPIRED_ACCOUNT, platform: 'taobao', auth_status: 'expired' },
      ],
      pidAccount: EXPIRED_ACCOUNT,
    });
    const result = await auth.get({ platform: 'taobao', reportedClient: 'ios', traceId: TRACE });
    expect(result.envelope).toMatchObject({ code: 30101, data: { reason: 'auth_unavailable' } });
    expect(getActivePid).toHaveBeenCalledWith({
      appId: APP,
      platform: 'taobao',
      pidScene: 'self_buy',
      purpose: 'convert',
    });
    expect(inserts).toEqual([]);
  });

  it('[AC-B1-06t#4] pdd: the bound account expired → 50301 maintenance (HTTP 503) even while another account is valid', async () => {
    const { auth, inserts, getActivePid } = setup({
      client: 'android',
      accounts: [
        { id: VALID_ACCOUNT, platform: 'pdd', auth_status: 'active' },
        { id: EXPIRED_ACCOUNT, platform: 'pdd', auth_status: 'expired' },
      ],
      bindings: [{ status: 'invalid', union_account_id: EXPIRED_ACCOUNT }],
      pidAccount: VALID_ACCOUNT,
    });
    const result = await auth.get({ platform: 'pdd', reportedClient: 'android', traceId: TRACE });
    expect(result.status).toBe(503);
    expect(result.envelope).toEqual({
      code: 50301,
      msg: expect.any(String),
      data: { reason: 'maintenance' },
      trace_id: TRACE,
    });
    expect(getActivePid).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });
});

/** A synthetic apps.json declaring a pdd scheme, so the matrix has a scheme step to order. */
const SYNTHETIC_APPS: LinkOpenApps = {
  apps: {
    jd: {
      status: 'candidate',
      ios: { query_schemes: [] },
      android: { packages: [] },
      harmony: { query_schemes: [] },
    },
    pdd: {
      status: 'candidate',
      ios: { query_schemes: ['synthpdd'] },
      android: { packages: ['test.example.synthpdd'] },
      harmony: { query_schemes: [] },
    },
  },
};

describe('createUnionAuthUrl pinduoduo auth_jump', () => {
  it('[AC-B1-06g#4] non-prod android installed=true follows the open matrix by the device record: the upstream scheme as is, then the page', async () => {
    const { auth, inserts, clock } = setup({
      client: 'android',
      accounts: [{ id: VALID_ACCOUNT, platform: 'pdd', auth_status: 'active' }],
      pidAccount: VALID_ACCOUNT,
      jumpEnvironment: { appEnv: 'test', apps: SYNTHETIC_APPS, verifiedPaths: {} },
    });
    // X-Platform says ios; the device record (android) decides.
    const result = await auth.get({
      platform: 'pdd',
      reportedClient: 'ios',
      installed: 'true',
      traceId: TRACE,
    });
    expect(result.status).toBe(200);
    const data = (result.envelope as { data: { auth_url: string; auth_jump: unknown } }).data;
    expect(data.auth_url).toBe(WEB_LINK);
    const expected = buildDefaultLinkJump({
      platform: 'pdd',
      client: 'android',
      installed: 'true',
      paths: { ...pathsOf('pdd', WEB_LINK, null), scheme: SCHEMA_LINK },
      expireAt: new Date(clock.now().getTime() + 600_000).toISOString(),
    });
    expect(data.auth_jump).toEqual(expected);
    expect(data.auth_jump).toMatchObject({
      primary: { type: 'scheme', value: SCHEMA_LINK },
      fallbacks: [{ type: 'h5', value: WEB_LINK }],
    });
    expect(inserts).toHaveLength(1);
  });

  it('[AC-B1-06g#4] without an upstream schema_url the scheme step wraps the web address with the apps.json scheme', async () => {
    const { auth, clock } = setup({
      client: 'android',
      accounts: [{ id: VALID_ACCOUNT, platform: 'pdd', auth_status: 'active' }],
      pidAccount: VALID_ACCOUNT,
      jumpEnvironment: { appEnv: 'test', apps: SYNTHETIC_APPS, verifiedPaths: {} },
      noSchemaUrl: true,
    });
    const result = await auth.get({
      platform: 'pdd',
      reportedClient: 'android',
      installed: 'true',
      traceId: TRACE,
    });
    expect(result.status).toBe(200);
    const data = (result.envelope as { data: { auth_url: string; auth_jump: unknown } }).data;
    expect(data.auth_url).toBe(WEB_LINK);
    const scheme = appSchemeOf(SYNTHETIC_APPS, 'pdd');
    expect(scheme).toBe('synthpdd');
    expect(data.auth_jump).toEqual(
      buildDefaultLinkJump({
        platform: 'pdd',
        client: 'android',
        installed: 'true',
        paths: pathsOf('pdd', WEB_LINK, scheme),
        expireAt: new Date(clock.now().getTime() + 600_000).toISOString(),
      }),
    );
    expect(data.auth_jump).toMatchObject({
      primary: { type: 'scheme', value: expect.stringMatching(new RegExp(`^${scheme}://`)) },
      fallbacks: [{ type: 'h5', value: WEB_LINK }],
    });
  });
});

describe('createUnionAuthUrl pinduoduo filing link (B1-06zf)', () => {
  const pddScenario: Scenario = {
    client: 'ios',
    accounts: [{ id: VALID_ACCOUNT, platform: 'pdd', auth_status: 'active' }],
    pidAccount: VALID_ACCOUNT,
  };

  it('[AC-B1-06zf#U1] the link is generated for the self_buy slot of the account in use; auth_url is the web address, never the scheme', async () => {
    const { auth, inserts, pddAuthorityUrl, getActivePid } = setup(pddScenario);
    const result = await auth.get({ platform: 'pdd', reportedClient: 'ios', traceId: TRACE });
    expect(result.status).toBe(200);
    const data = (result.envelope as { data: { auth_url: string; state: string } }).data;
    expect(data.auth_url).toBe(WEB_LINK);
    expect(data.auth_url).not.toContain(data.state);
    expect(pddAuthorityUrl).toHaveBeenCalledTimes(1);
    expect(getActivePid).toHaveBeenCalledWith(
      expect.objectContaining({ pidScene: 'self_buy', unionAccountId: VALID_ACCOUNT }),
    );
    expect(inserts).toHaveLength(1);
  });

  it.each(['missing', 'fails'] as const)(
    '[AC-B1-06zf#U2] the filing link port %s → 503 / 50303 and no state',
    async (authorityUrl) => {
      const { auth, inserts } = setup({ ...pddScenario, authorityUrl });
      const result = await auth.get({ platform: 'pdd', reportedClient: 'ios', traceId: TRACE });
      expect(result.status).toBe(503);
      expect(result.envelope).toEqual({ code: 50303, msg: expect.any(String), trace_id: TRACE });
      expect(inserts).toEqual([]);
    },
  );

  it('[AC-B1-06zf#U3] no active self_buy slot → 503 / 50301 maintenance, no link generated, no state', async () => {
    const { auth, inserts, pddAuthorityUrl } = setup({
      client: 'ios',
      accounts: pddScenario.accounts,
    });
    const result = await auth.get({ platform: 'pdd', reportedClient: 'ios', traceId: TRACE });
    expect(result.status).toBe(503);
    expect(result.envelope).toMatchObject({ code: 50301, data: { reason: 'maintenance' } });
    expect(pddAuthorityUrl).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });
});
