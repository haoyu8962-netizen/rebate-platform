// B1-04zzi / D10-680 through the admin entry's own assembly (rule-test review r1, S1): the
// AdminUnionAccounts provider of UnionAdminModule.forAdmin is built by its registered factory with
// the values Nest injects (APP_CONFIG from loadConfig, CLOCK, ROOT_LOGGER, DB, FIELD_CRYPTO; any
// other dependency must be a provider of the same module), never by calling
// createSiteOAuthProviders here. So a module that still calls it the B1-22d way (no wiring) leaves
// staging without a Taobao provider and fails these tests. The Taobao secret is a synthetic file
// (TAOBAO_APP_SECRET_FILE, B1-04k); the token endpoint is a stubbed global fetch, nothing goes on
// the network. The database harness is B1-22c's (test/spec/union/reauth-session/kit.ts), read-only.
// No full platform bootstrap: that would start every admin module in staging, unrelated to this.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  AdminUnionAccounts,
  type AdminUnionAccountActor,
} from '../../../../apps/api/src/modules/union/application/admin-accounts.ts';
import { SiteReauthError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  credentials,
  databaseFixture,
  expectNoSecrets,
  harness,
  hash,
  seed,
  seedCredential,
  session,
  snapshot,
  type Harness,
} from '../reauth-session/kit.ts';
import {
  ACCESS,
  APP_KEY,
  AUTHORIZE_ENDPOINT,
  CODE,
  DAY_S,
  REDIRECT,
  REFRESH,
  SECRET,
  TOKEN_ENDPOINT,
  environment,
  tokenAnswer,
  visible,
} from './kit.ts';

const db = databaseFixture(createTestDatabase);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ACCESS_CONTEXT = 'union_credentials.access';
const REFRESH_CONTEXT = 'union_credentials.refresh';
const UNCONFIGURED = 'union_site_oauth_unconfigured';

interface Injection {
  readonly token: unknown;
  readonly optional?: boolean;
}

interface AdminOptions {
  readonly auditWriter: (trx: unknown, clock: unknown) => { append(input: unknown): Promise<void> };
  readonly config: (
    trx: unknown,
    clock: unknown,
  ) => { configValue(appId: string, key: string): Promise<null> };
}

interface UnionAdminExports {
  readonly UnionAdminModule: {
    forAdmin(options: AdminOptions): { readonly providers?: readonly unknown[] };
  };
}

let directory: string;
let network: Mock<typeof fetch>;

beforeEach(async () => {
  const parent = join(ROOT, '.tmp/taobao-site-oauth');
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(join(parent, 'admin-entry-'));
  // Even a broken implementation must not contact a real network from these tests.
  network = vi.fn<typeof fetch>().mockRejectedValue(new Error('FAKE_NETWORK_MUST_BE_STUBBED'));
  vi.stubGlobal('fetch', network);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function writeSecret(): Promise<string> {
  const file = join(directory, 'FAKE_TAOBAO_OAUTH_SECRET_FILE.txt');
  await writeFile(file, `${SECRET}\n`, 'utf8');
  return file;
}

function label(token: unknown): string {
  return typeof token === 'function' ? token.name : String(token);
}

function providerOf(
  providers: readonly unknown[],
  token: unknown,
): Record<string, unknown> | undefined {
  return providers.find(
    (value): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && 'provide' in value && value.provide === token,
  );
}

/** Resolves `token` the way Nest does for this module: its own providers first, then platform's. */
async function resolve(
  providers: readonly unknown[],
  platform: ReadonlyMap<unknown, unknown>,
  token: unknown,
  optional: boolean,
): Promise<unknown> {
  const own = providerOf(providers, token);
  if (own !== undefined) {
    if ('useValue' in own) return own['useValue'];
    expect(own['useFactory'], `${label(token)} is a factory provider`).toBeTypeOf('function');
    const args: unknown[] = [];
    for (const entry of (own['inject'] ?? []) as readonly unknown[]) {
      const injection: Injection =
        typeof entry === 'object' && entry !== null && 'token' in entry
          ? (entry as Injection)
          : { token: entry };
      args.push(await resolve(providers, platform, injection.token, injection.optional === true));
    }
    return (own['useFactory'] as (...values: unknown[]) => unknown)(...args);
  }
  if (platform.has(token)) return platform.get(token);
  expect(optional, `${label(token)} must be a platform token or a provider of the module`).toBe(
    true,
  );
  return undefined;
}

/** The admin entry's AdminUnionAccounts for `env` (staging), with its log and audit records. */
async function adminEntry(h: Harness, env: Record<string, string>) {
  const lines: unknown[][] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push([level, ...args]);
  const logger: Record<string, unknown> = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
  };
  logger['child'] = () => logger;
  const audits: unknown[] = [];
  const modulePath = '../../../../apps/api/src/modules/union/union-admin.module.ts';
  const platformPath = '../../../../apps/api/src/modules/platform/index.ts';
  // Dynamic imports keep the module's controllers (Nest decorators) out of the rule-test tsc build.
  const union = (await import(
    /* @vite-ignore */ new URL(modulePath, import.meta.url).href
  )) as UnionAdminExports;
  const platform = (await import(
    /* @vite-ignore */ new URL(platformPath, import.meta.url).href
  )) as Record<string, unknown>;
  const config = loadConfig({ ...environment('staging'), ...env });
  const providers =
    union.UnionAdminModule.forAdmin({
      auditWriter: () => ({
        append: (input) => {
          audits.push(input);
          return Promise.resolve();
        },
      }),
      config: () => ({ configValue: () => Promise.resolve(null) }),
    }).providers ?? [];
  const known = new Map<unknown, unknown>([
    [platform['APP_CONFIG'], config],
    [platform['CLOCK'], h.clock],
    [platform['ROOT_LOGGER'], logger],
    [platform['DB'], h.db],
    [platform['FIELD_CRYPTO'], h.crypto],
  ]);
  const service = await resolve(providers, known, AdminUnionAccounts, false);
  expect(service).toBeInstanceOf(AdminUnionAccounts);
  return { service: service as AdminUnionAccounts, lines, audits };
}

function actor(h: Harness): AdminUnionAccountActor {
  return { appId: h.appId, adminId: h.adminId, ip: '192.0.2.7' };
}

function unconfigured(lines: unknown[][]) {
  return lines.filter((args) => args.includes(UNCONFIGURED));
}

it('[AC-B1-04zzi#20] 后台入口 staging 三项齐备：发起返回淘宝授权地址，回调经 token 端点换令牌并加密写入', async () => {
  const h = await harness(db());
  const file = await writeSecret();
  const { service, lines, audits } = await adminEntry(h, {
    TAOBAO_APP_KEY: APP_KEY,
    TAOBAO_APP_SECRET_FILE: file,
    TAOBAO_OAUTH_REDIRECT_URI: REDIRECT,
  });
  expect(unconfigured(lines)).toEqual([]);
  const a = await seed(h);
  const old = await seedCredential(h, a.id);

  const started = await service.start(actor(h), a.id, { reason: 'operator requested renewal' });
  expect(started.auth_url.startsWith(`${AUTHORIZE_ENDPOINT}?`)).toBe(true);
  const url = new URL(started.auth_url);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code',
    client_id: APP_KEY,
    redirect_uri: REDIRECT,
    state: expect.any(String),
    view: 'web',
  });
  const state = url.searchParams.get('state')!;
  expect((await session(h, started.session_id)).state_hash).toEqual(hash(state));
  expect(network).not.toHaveBeenCalled();

  network.mockImplementation(
    async () =>
      new Response(JSON.stringify(tokenAnswer()), {
        status: 200,
        headers: { 'content-type': 'application/json;charset=UTF-8' },
      }),
  );
  h.clock.advanceMs(60_000);
  const callbackAt = h.clock.now().getTime();
  expect(await service.callback(actor(h), { state, code: CODE })).toMatchObject({
    session_id: started.session_id,
    union_account_id: a.id,
    status: 'succeeded',
  });

  expect(network).toHaveBeenCalledTimes(1);
  const [target, init] = network.mock.calls[0]!;
  expect(String(target)).toBe(TOKEN_ENDPOINT);
  expect(init?.method).toBe('POST');
  expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
    grant_type: 'authorization_code',
    client_id: APP_KEY,
    client_secret: SECRET,
    code: CODE,
    redirect_uri: REDIRECT,
  });

  const rows = await credentials(h);
  expect(rows.find((row) => row.id === old.id)?.is_current).toBe(false);
  const current = rows.filter((row) => row.union_account_id === a.id && row.is_current);
  expect(current).toHaveLength(1);
  const credential = current[0]!;
  expect(credential.expires_at).toEqual(new Date(callbackAt + DAY_S * 1000));
  expect(h.crypto.decrypt(credential.access_token_cipher.toString(), ACCESS_CONTEXT)).toBe(ACCESS);
  expect(h.crypto.decrypt(credential.refresh_token_cipher!.toString(), REFRESH_CONTEXT)).toBe(
    REFRESH,
  );

  const secrets = [ACCESS, REFRESH, CODE, SECRET, state];
  expectNoSecrets(await snapshot(h), [...secrets, started.auth_url]);
  expectNoSecrets(audits, [...secrets, started.auth_url]);
  for (const secret of [...secrets, file]) expect(visible(lines)).not.toContain(secret);
});

const MISSING: [string, (file: string) => Record<string, string>][] = [
  ['没有淘宝 appKey 与 secret', () => ({ TAOBAO_OAUTH_REDIRECT_URI: REDIRECT })],
  ['没有回调地址', (file) => ({ TAOBAO_APP_KEY: APP_KEY, TAOBAO_APP_SECRET_FILE: file })],
  ['三项都没有', () => ({})],
];

it.each(MISSING)(
  '[AC-B1-04zzi#21] 后台入口 staging %s：照常装配，发起 fail closed（provider_missing），一条 union_site_oauth_unconfigured，不建会话、不联网',
  async (_label, patch) => {
    const h = await harness(db());
    const file = await writeSecret();
    const { service, lines, audits } = await adminEntry(h, patch(file));
    expect(unconfigured(lines)).toHaveLength(1);
    const a = await seed(h);
    const before = await snapshot(h);
    const refused = service.start(actor(h), a.id, {});
    await expect(refused).rejects.toBeInstanceOf(SiteReauthError);
    await expect(refused).rejects.toMatchObject({ code: 'provider_missing' });
    expect(await snapshot(h)).toEqual(before);
    expect(audits).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    for (const secret of [SECRET, file]) expect(visible(lines)).not.toContain(secret);
  },
);
