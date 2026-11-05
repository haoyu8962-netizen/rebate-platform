import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import {
  createCatalogCardEntry,
  type CardQuoteContext,
  type RebateQuote,
  type RegisterLinkInput,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  createLinkRegistration,
  type Caller,
  type LinkOpenCacheKey,
  type LinkOpenCachedJump,
  type LinkOpenOwnerResult,
  type LinkOpenPrice,
} from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createPddAuthLinkOpen,
  type PddAuthLinkOpenOptions,
} from '../../../../apps/api/src/modules/linking/application/link-open-pdd-auth.ts';
import type { LinkOpenInput } from '../../../../apps/api/src/modules/linking/application/link-open.ts';
import { loadLinkOpenApps } from '../../../../apps/api/src/modules/linking/infra/apps-json.ts';
import { createIdempotency, FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  type ActivePidInput,
  type CallCtx,
  type UnionAdapter,
  type UnionIdentity,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import { NOW, seed, type BindingStatus } from './database.ts';

export type Query = (identity: UnionIdentity, ctx: CallCtx) => Promise<{ authorized: boolean }>;
export type QueryAnswer = boolean | Error | 'missing';
export interface Setup {
  readonly binding: BindingStatus;
  readonly query: QueryAnswer;
  readonly scene?: 'search' | 'detail' | 'share' | 'agent';
  readonly platform?: 'pdd' | 'jd';
}

export async function fixture(db: Kysely<DB>, setup: Setup) {
  const seeded = await seed(db);
  const { appId, a, b, accountId } = seeded;
  const bindingId = await seeded.bind(setup.binding);
  const clock = new FixedClock(NOW);
  const current = vi.fn(async (): Promise<Caller> => ({ appId, ...a }));
  const attrCode = vi.fn(async (tenant: string, userId: string): Promise<string | null> => {
    const row = await db
      .selectFrom('users')
      .select('attr_code')
      .where('app_id', '=', tenant)
      .where('id', '=', userId)
      .executeTakeFirst();
    return row?.attr_code ?? null;
  });
  let phase = 'snapshot';
  const getActivePid = vi.fn(async (q: ActivePidInput) => ({
    id: accountId,
    app_id: q.appId,
    platform: q.platform,
    pid_scene: q.pidScene,
    pid: `${phase}-${q.platform}-${q.pidScene}`,
    union_account_id: accountId,
    site_id: null,
    status: 'active',
    row_version: 0,
    hjy_ignore_confirmed_at: null,
    hjy_ignore_evidence_path: null,
    created_at: clock.now(),
    updated_at: clock.now(),
  }));
  const config = new Map<string, boolean | number>([
    ['convert.enabled.pdd', true],
    ['convert.enabled.jd', true],
    ['attr.click_code.pdd', false],
    ['attr.click_code.jd', false],
    ['link.open.requote_after_sec', 0],
  ]);
  const configValue = vi.fn(async (_appId: string, key: string) =>
    config.has(key) ? { value: config.get(key)!, version: 1 } : null,
  );
  const base = {
    db,
    clock,
    callerContext: { current },
    attrCodes: { attrCode },
    pids: { getActivePid },
    config: { configValue },
  };
  const platform = setup.platform ?? 'pdd';
  const demo = new DemoUnionAdapter({
    platform,
    seed: 'pdd-auth-fixture',
    clock,
    environment: 'test',
  });
  const ctx: CallCtx = { appId, requestId: randomUUID(), purpose: 'online' };
  const page = await demo.searchItems({ keyword: '演示' }, ctx);
  const item = page.items[0]!;
  const ref = {
    appId,
    platform,
    productKey: platform === 'pdd' ? 'pdd:67890' : 'jd:12345',
    rawItemId: (platform === 'pdd' ? item.goods_sign : item.itemId)!,
    rawFetchedAt: NOW,
    receivedAt: NOW,
    canonicalUrl: null,
    title: item.title,
    shopId: null,
    shopType: null,
    source: 'search' as const,
  };
  const quoteValue: RebateQuote = {
    rebateMinFen: 100n,
    rebateMaxFen: 100n,
    rebateBasis: 'normal',
    estNetPriceFen: null,
  };
  const registration = createLinkRegistration({
    ...base,
    context: { scene: setup.scene ?? 'detail' },
  });
  const value: RegisterLinkInput = {
    viewer: await current(),
    ref,
    item,
    quote: quoteValue,
    entrySource: 'search',
  };
  const registered = await registration.register(value);
  const row = await db
    .selectFrom('links')
    .selectAll()
    .where('link_id', '=', registered.linkId)
    .executeTakeFirstOrThrow();
  phase = 'current';
  const quote = vi.fn(
    async (
      _item: UnionItem,
      _viewer: Viewer,
      context?: CardQuoteContext,
    ): Promise<RebateQuote> => ({ ...quoteValue, rebateBasis: context?.rebateBasis ?? 'normal' }),
  );
  const catalog = createCatalogCardEntry({
    clock,
    viewerContext: { current },
    quoter: { quote },
    registrar: registration,
    sourceLinks: registration,
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn: vi.fn() },
  });
  const fetch = vi.fn(async (owner: LinkOpenOwnerResult): Promise<LinkOpenPrice> => {
    void owner;
    return { kind: 'available', input: { item, ref, entrySource: 'search', stale: false } };
  });
  const query = vi.fn<Query>(async () => {
    if (setup.query instanceof Error) throw setup.query;
    return { authorized: setup.query === true };
  });
  const convert = vi.fn<UnionAdapter['convert']>((req, identity, callCtx) =>
    demo.convert(req, identity, callCtx),
  );
  // Explicit forwarding: do not copy the prototype's optional query method into the missing case.
  const adapter: UnionAdapter & { queryPddAuthority?: Query } = {
    platform,
    searchItems: (q, c) => demo.searchItems(q, c),
    getItem: (r, c) => demo.getItem(r, c),
    resolveLink: (r, c) => demo.resolveLink(r, c),
    listOrders: (w, o, c) => demo.listOrders(w, o, c),
    convert,
    // B1-06zf (D10-658): the authorization link comes from the union port; forwarded to the same
    // demo adapter, so the links are the demo's own (https://demo.invalid/…), never a Pinduoduo
    // payload. Kept in the 'missing' query case too: only the filing query is absent there.
    pddAuthorityUrl: (identity, callCtx) => demo.pddAuthorityUrl(identity, callCtx),
    ...(setup.query === 'missing' ? {} : { queryPddAuthority: query }),
  };
  const entries = new Map<string, LinkOpenCachedJump>();
  const cache = {
    get: vi.fn(async (key: LinkOpenCacheKey) => entries.get(JSON.stringify(key)) ?? null),
    put: vi.fn(async (key: LinkOpenCacheKey, entry: LinkOpenCachedJump) => {
      entries.set(JSON.stringify(key), entry);
    }),
  };
  const declaredApps = loadLinkOpenApps();
  // Synthetic configured scheme makes installed=true/false observably different; no real capability claim.
  const apps = {
    apps: {
      ...declaredApps.apps,
      pdd: {
        ...declaredApps.apps.pdd,
        ios: { query_schemes: ['synthetic-pdd'] },
      },
    },
  };
  const options: PddAuthLinkOpenOptions = {
    ...base,
    appEnv: 'test',
    catalog,
    prices: { fetch },
    cache,
    idempotency: createIdempotency({ db, clock, logger: { warn: vi.fn() } }),
    registry: { get: () => adapter },
    logger: { warn: vi.fn() },
    environment: { appEnv: 'test', apps, verifiedPaths: {} },
  };
  const request = (extra: Partial<LinkOpenInput> = {}): LinkOpenInput => ({
    linkId: row.link_id,
    idempotencyKey: `open-${randomUUID()}`,
    traceId: randomUUID(),
    client: 'ios',
    ...extra,
  });
  function opener(person: 'a' | 'b' | 'guest') {
    current.mockResolvedValue({
      appId,
      userId: person === 'guest' ? null : seeded[person].userId,
      deviceId: person === 'a' ? a.deviceId : b.deviceId,
    });
  }
  // Registration lookups must not be mistaken for the open's query/conversion work.
  attrCode.mockClear();
  getActivePid.mockClear();
  return {
    ...seeded,
    clock,
    options,
    row,
    bindingId,
    current,
    opener,
    request,
    query,
    convert,
    fetch,
    quote,
    cache,
    config,
    attrCode,
    getActivePid,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function service(f: Fixture) {
  return createPddAuthLinkOpen(f.options);
}

/** Capture both success and refusal before assertions; unexpected throws cannot satisfy a refusal. */
export function outcome<T>(call: () => Promise<T>): Promise<T | { thrown: unknown }> {
  return Promise.resolve()
    .then(call)
    .catch((thrown: unknown) => ({ thrown }));
}
