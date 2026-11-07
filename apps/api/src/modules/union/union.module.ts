import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  PDD_QUERY_CUSTOM_PARAMETERS_ENV,
  ROOT_LOGGER,
  TAOBAO_SEARCH_SOURCE_ENV,
  UNION_ENDPOINT_OVERRIDE_DIR_ENV,
  openDataokeCredentials,
  openJdCredentials,
  openPddCredentials,
  openTaobaoCredentials,
  type AppConfig,
  type Clock,
  type RootLogger,
  kmsAccessOf,
} from '../platform/index.ts';
import {
  createTaobaoPriceSettings,
  type TaobaoPriceConfigReader,
} from './application/taobao-price-settings.ts';
import type { TaobaoPriceSettingsReader, TaobaoPriceWarning } from './domain/taobao-price.ts';
import { UnionError, type CallCtx, type UnionEndpoint } from './domain/types.ts';
import { createArchivingTransport } from './infra/archive.ts';
import type { DataokeWarning } from './infra/dataoke/dataoke-client.ts';
import { loadUnionEndpoints } from './infra/endpoints.ts';
import { createUnionHttpTransport } from './infra/http-transport.ts';
import { checkJdProductKeyMode, type JdProductKeyMode } from './infra/jd/orders.ts';
import type { JdWarning } from './infra/jd/response.ts';
import type { PddQueryIdentity } from './infra/pdd/pdd-adapter.ts';
import type { PddWarning } from './infra/pdd/response.ts';
import {
  createUnionRegistry,
  type JdLiveOptions,
  type PddLiveOptions,
  type TaobaoLiveOptions,
  type TaobaoOrderSourceOptions,
  type UnionRegistry,
} from './infra/registry.ts';
import type { UnionTransport } from './infra/replay.ts';
import type {
  TaobaoOrderSlotReader,
  TaobaoOwnOrderReader,
  TaobaoOrderWarning,
  TaobaoSearchSlotReader,
  TaobaoSearchWarning,
} from './infra/taobao/taobao-adapter.ts';
import {
  createTaobaoSearchCounter,
  taobaoSearchCounterToken,
  type TaobaoSearchCounter,
} from './infra/taobao/search-counter.ts';
import type { DataokeImageHostWarning } from './infra/taobao/dataoke-search.ts';
import type { TaobaoSearchFallbackWarning } from './infra/taobao/search-fallback.ts';
import type { TaobaoWarning } from './infra/taobao/response.ts';
import { readActivePddQueryPid } from './pids/query-reader.ts';
import { readTaobaoOrderSlots } from './pids/taobao-order-slots.ts';
import { readTaobaoSearchSlot } from './pids/taobao-search-slot.ts';

/**
 * B1-22q: the second argument of UnionModule.forRoot(directory, options). `config` builds union's
 * Taobao price configuration port over the entry's database handle and clock (app.module:
 * content's createContentReader, as UnionAdminModule's `config`). The demo adapters map Taobao
 * prices with createTaobaoPriceSettings over it, read with ctx.appId on every mapping. The
 * UNION_REGISTRY factory keeps its four dependencies. B1-04ze: the live jd adapter reads
 * product_key.jd.mode through the same port.
 */
export interface UnionModuleOptions {
  readonly config?: (db: Kysely<Database>, clock: Clock) => TaobaoPriceConfigReader;
  /**
   * B1-04zzu (D10-796 ② 甲): orders' read of 凑狸's stored taobao orders (app.module: orders'
   * readOwnTaobaoOrderNos). With the 大淘客 order source, the live Taobao adapter asks it over the
   * module's optional database handle and ctx.appId for every refund page, so the refund archive
   * keeps only 凑狸's orders. Without it (or without a database) the refund archive is unchanged.
   */
  readonly taobaoOwnOrders?: UnionTaobaoOwnOrders;
}

/**
 * B1-04zzu: which of `orderNos` are stored taobao orders of `appId` (sub or parent order number,
 * verbatim), on `db`; read only. An empty `orderNos` reads nothing and answers an empty set.
 */
export type UnionTaobaoOwnOrders = (
  db: Kysely<Database>,
  appId: string,
  orderNos: readonly string[],
) => Promise<ReadonlySet<string>>;

/** Nest injection tokens provided by `UnionModule`. */
export const UNION_ENDPOINTS = Symbol('UNION_ENDPOINTS');
export const UNION_REGISTRY = Symbol('UNION_REGISTRY');
/**
 * B1-04x: the optional database handle the pdd query identity reads union_pids with. A provider
 * of its own (optional DB injection), so the UNION_REGISTRY factory keeps its four dependencies and
 * an entry or isolated test without a database still starts (goods calls are then refused).
 */
export const UNION_QUERY_PID_SOURCE = Symbol('UNION_QUERY_PID_SOURCE');
/**
 * B1-22q: builds the Taobao price configuration port from UnionModuleOptions.config over the
 * optional database handle and the clock; a provider of its own for the same reason.
 */
const UNION_TAOBAO_PRICE_CONFIG = Symbol('UNION_TAOBAO_PRICE_CONFIG');

/** Fixed seed of the demo catalog: the same synthetic items on every start (规划/11 §4.5). */
export const UNION_DEMO_SEED = 'couli-demo';

/**
 * B1-04e: the fixed 大淘客 gateway origin of the Taobao order source (DataokeClient appends the
 * request path). Not part of config/union-endpoints/taobao.json.
 */
export const DATAOKE_GATEWAY = 'https://openapi.dataoke.com';

/** config/union-endpoints/ at the repository root; same depth from src/ and dist/. */
export const UNION_ENDPOINTS_DIR = fileURLToPath(
  new URL('../../../../../config/union-endpoints/', import.meta.url),
);

/**
 * Union (规划/02 §4.1, §6): adapter registry and per-platform endpoint configuration. The
 * endpoints are read once while the entry starts; an invalid set, or a demo / replay endpoint in
 * prod, stops the entry. Platforms configured as mode=demo get the DemoUnionAdapter. Governed adapters (createGovernedAdapter) are assembled by the callers
 * that own a quota limiter.
 * pdd with mode=live (B1-04t): local / test refuse to start, prod reads the secret from KMS once here
 * (B1-30a; without KMS configured it refuses, kms_unavailable), staging
 * reads PDD_CLIENT_SECRET_FILE once here and assembles the real PddUnionAdapter over the HTTPS
 * transport (registry option `pddLive`); a failure stops the entry before it serves anything.
 * B1-04p: with the optional DB that HTTPS transport writes one union_raw_payloads row per request.
 * taobao with mode=live (B1-04k): local / test refuse and prod goes through KMS like pdd; staging with both
 * TAOBAO_APP_KEY and TAOBAO_APP_SECRET_FILE reads the secret file once here and assembles the real
 * TaobaoUnionAdapter over its own archived HTTPS transport (registry option `taobaoLive`); staging
 * with neither variable keeps taobao unimplemented. pdd and taobao are assembled independently.
 * B1-04e: with taobao assembled live and AppConfig.dataoke set (staging, DATAOKE_APP_KEY and
 * DATAOKE_APP_SECRET_FILE), the 大淘客 secret file is read once here too and the adapter gets a
 * DataokeClient order source over its own archived HTTPS transport; staging with neither variable
 * starts without one and logs nothing (D10-479; deployment checks cover it). prod with taobao live
 * reads the taobao secret, and with DATAOKE_APP_KEY set the 大淘客 one, from KMS (B1-30a) instead of
 * files; without KMS configured it refuses (kms_unavailable).
 * B1-04zn (D10-530): taobao live also gets TAOBAO_CONVERT_SOURCE / TAOBAO_SEARCH_SOURCE from the
 * passed config, and with the 大淘客 order source an order slot reader over the optional database
 * (union_pids, every Taobao PID of ctx.appId) plus a warn hook logging only event code and count.
 * B1-04zx (D10-582): taobao live always gets a search slot reader over the optional database
 * (the active query PID of ctx.appId) and a skip hook logging only event and reason; neither needs
 * the 大淘客 order source, so the official search runs on the official credentials alone.
 * B1-04zy (D10-582): TAOBAO_SEARCH_SOURCE=official_first without the 大淘客 order source refuses to
 * start (UnionError, no silent official-only); taobao live gets the module's search counter (see
 * search-counter.ts) under every switch value, and a fallback hook logging only event, source and
 * reason.
 * jd with mode=live (B1-04ze): local / test refuse and prod goes through KMS like taobao, after
 * taobao's own check;
 * staging with both JD_APP_KEY and JD_APP_SECRET_FILE reads the secret file once here and assembles
 * the real JdUnionAdapter over its own archived HTTPS transport (registry option `jdLive`); staging
 * with neither variable keeps jd unimplemented and logs nothing (D10-479). The adapter reads
 * product_key.jd.mode per call over the configuration port (BR-PROD-03).
 * TODO(规划/11 §4.5): 配额桶容量与 Redis 令牌桶 — blocked on CAP-TB-12、CAP-JD-12、CAP-PDD-12 配额口径
 */
/** BR-PRICE-01 / BR-PRICE-02 alarms as flat pino fields: the code, and for an unknown name only
 * the name (no item data).
 */
function logPriceWarning(logger: RootLogger, warning: TaobaoPriceWarning): void {
  if (warning.code === 'PRICE_PROMO_UNKNOWN') {
    logger.warn({ event: warning.code, promotion_title: warning.title }, 'unknown promotion name');
  } else {
    logger.warn({ event: warning.code }, 'taobao price detail does not reconcile');
  }
}

/**
 * The Pinduoduo warn hook as flat pino fields; no request content, item data or amount. A warning
 * with an `event` (B1-04u: PRICE_ANOMALY from the goods mapping) is logged as that event; one
 * without is an unknown error code (B1-04g).
 */
function logPddWarning(logger: RootLogger, warning: PddWarning): void {
  if (warning.event !== undefined) {
    logger.warn({ event: warning.event, method: warning.type }, 'pinduoduo goods price anomaly');
    return;
  }
  logger.warn(
    { event: 'PDD_ERROR_CODE_UNKNOWN', error_code: warning.error_code, method: warning.type },
    'unknown pinduoduo error code',
  );
}

/** B1-04zzj: the 大淘客 search's per-page image host tally (dataoke-search.ts ⑥). */
function isImageHostWarning(warning: TaobaoWarning): warning is DataokeImageHostWarning {
  const fields = warning as Partial<DataokeImageHostWarning>;
  return (
    warning.code === 'dataoke_image_host_dropped' &&
    typeof fields.host === 'string' &&
    typeof fields.count === 'number'
  );
}

/**
 * The Taobao warn hook (B1-04j: an API permission refusal) as flat pino fields: only the method
 * name and code / sub_code; no message text, request id or request content.
 * B1-04zzj: the 大淘客 image host tally is its own event with only the host name and the count
 * (no address, no item id), not an API permission warning.
 */
function logTaobaoWarning(logger: RootLogger, warning: TaobaoWarning): void {
  if (isImageHostWarning(warning)) {
    logger.warn(
      {
        event: 'DATAOKE_IMAGE_HOST_DROPPED',
        method: warning.method,
        host: warning.host,
        count: warning.count,
      },
      'dataoke search images dropped for their host',
    );
    return;
  }
  logger.warn(
    {
      event: 'TAOBAO_API_PERMISSION_DENIED',
      method: warning.method,
      code: warning.code,
      ...(warning.sub_code === undefined ? {} : { sub_code: warning.sub_code }),
    },
    'taobao api permission denied',
  );
}

/**
 * The 大淘客 warn hook (B1-04e) as flat pino fields: only the request path and code / sub_code; no
 * message text, query or credential.
 */
function logDataokeWarning(logger: RootLogger, warning: DataokeWarning): void {
  logger.warn(
    {
      event: 'DATAOKE_UPSTREAM_WARNING',
      path: warning.path,
      code: warning.code,
      ...(warning.sub_code === undefined ? {} : { sub_code: warning.sub_code }),
    },
    'dataoke upstream warning',
  );
}

/**
 * The Taobao order warn hook (B1-04f, wired by B1-04zn) as flat pino fields: only the event code,
 * and the upstream field name / count when the warning has them; never an order number, an amount
 * or a PID (only those three known fields are copied).
 */
function logTaobaoOrderWarning(logger: RootLogger, warning: TaobaoOrderWarning): void {
  logger.warn(
    {
      event: warning.event,
      ...(typeof warning.field === 'string' ? { field: warning.field } : {}),
      ...(typeof warning.count === 'number' ? { count: warning.count } : {}),
    },
    'taobao order warning',
  );
}

/**
 * B1-04zn (D10-530; D10-488 ③): the live Taobao adapter's order slot reader, every Taobao PID of
 * ctx.appId in union_pids (retired included), read again on every listOrders. The database is read
 * from the optional source per call, like the pdd query identity: without one listOrders stays
 * `adapter_unimplemented` and nothing is read. A failed read is not caught: listOrders rejects with
 * it (never an empty slot list), so the order sync retries that window.
 */
function taobaoOrderSlots(source: QueryPidSource): TaobaoOrderSlotReader {
  return async (ctx) => {
    const db = source.db;
    if (db === undefined) {
      throw new UnionError(
        'adapter_unimplemented',
        'Union adapter for taobao has no database to read the order slots from (listOrders)',
        'taobao',
      );
    }
    return readTaobaoOrderSlots(db, ctx.appId);
  };
}

/**
 * B1-04zx (D10-582; BR-PROD-07): the live Taobao adapter's search slot reader, the active query PID
 * of ctx.appId, read again on every official search. Without a database it stays
 * `adapter_unimplemented` and nothing is read or sent. A failed read is not caught: searchItems
 * rejects with it.
 */
function taobaoSearchSlot(source: QueryPidSource): TaobaoSearchSlotReader {
  return async (ctx) => {
    const db = source.db;
    if (db === undefined) {
      throw new UnionError(
        'adapter_unimplemented',
        'Union adapter for taobao has no database to read the search slot from (searchItems)',
        'taobao',
      );
    }
    return readTaobaoSearchSlot(db, ctx.appId);
  };
}

/**
 * The official search skip hook (B1-04zx) as flat pino fields: only the event and the reason, never
 * a value of the row; not an API permission warning (logTaobaoWarning).
 */
function logTaobaoSearchWarning(logger: RootLogger, warning: TaobaoSearchWarning): void {
  logger.warn({ event: warning.event, reason: warning.reason }, 'taobao search row skipped');
}

/**
 * The search fallback hook (B1-04zy) as flat pino fields: only the event, the source and the
 * reason, never the keyword.
 */
function logTaobaoSearchFallback(logger: RootLogger, warning: TaobaoSearchFallbackWarning): void {
  logger.warn(
    { event: warning.event, source: warning.source, reason: warning.reason },
    warning.event === 'taobao_search_fallback'
      ? 'taobao search fell back'
      : 'taobao search fallback failed',
  );
}

/** The Jingdong warn hook (B1-04za) as flat pino fields: only the method name and the code. */
function logJdWarning(logger: RootLogger, warning: JdWarning): void {
  logger.warn(
    { event: 'JD_API_WARNING', method: warning.method, code: warning.code },
    'jd api warning',
  );
}

/**
 * B1-04zzu (D10-796 ② 甲): the live Taobao adapter's own-order lookup for the refund archive,
 * orders' read (UnionModuleOptions.taobaoOwnOrders) over the optional database read per call with
 * ctx.appId. Without a database it rejects `adapter_unimplemented` without asking (the archive then
 * stores the body as received; without a database nothing is archived anyway).
 */
function taobaoOwnOrders(source: QueryPidSource, read: UnionTaobaoOwnOrders): TaobaoOwnOrderReader {
  return async (appId, orderNos) => {
    const db = source.db;
    if (db === undefined) {
      throw new UnionError(
        'adapter_unimplemented',
        'Union adapter for taobao has no database to read the stored orders from (listRefunds)',
        'taobao',
      );
    }
    return read(db, appId, orderNos);
  };
}

/** Filled by the UNION_QUERY_PID_SOURCE provider; `db` stays undefined without a database. */
interface QueryPidSource {
  db: Kysely<Database> | undefined;
}

/** Filled by the UNION_TAOBAO_PRICE_CONFIG provider; `reader` stays undefined without a database. */
export interface PriceConfigSource {
  reader: TaobaoPriceConfigReader | undefined;
}

/** BR-PROD-03 / 05: the per-app configuration key of the Jingdong product key mode. */
const JD_PRODUCT_KEY_MODE_KEY = 'product_key.jd.mode';
/** The fixed warn event of a failed read of that key; the fields are this and the key. */
const JD_PRODUCT_KEY_MODE_READ_FAILED = 'JD_PRODUCT_KEY_MODE_READ_FAILED';

/**
 * B1-04ze: the live jd adapter's product key mode, read with ctx.appId on every listOrders. item
 * only when there is no configuration source (no `config` option, no database) or the key is not
 * set. A read that fails never falls back to item (unlike the price settings): in sku mode a whole
 * window of orders would get wrong product keys, so it fails like a transport failure, the order
 * sync retries, and neither the error nor the log carries anything of what was read. A present
 * value other than sku / item is `invalid_dto` (checkJdProductKeyMode, no value in the error).
 */
export function jdProductKeyMode(
  source: PriceConfigSource | undefined,
  logger: Pick<RootLogger, 'warn'>,
): { read(appId: string): Promise<JdProductKeyMode> } {
  return {
    async read(appId) {
      const reader = source?.reader;
      if (reader === undefined) return 'item';
      let answer: unknown;
      try {
        answer = await reader.configValue(appId, JD_PRODUCT_KEY_MODE_KEY);
      } catch {
        logger.warn(
          { event: JD_PRODUCT_KEY_MODE_READ_FAILED, key: JD_PRODUCT_KEY_MODE_KEY },
          'jd product key mode cannot be read',
        );
        throw new UnionError(
          'upstream_unavailable',
          'jd listOrders: product key mode cannot be read',
          'jd',
        );
      }
      if (answer === null || answer === undefined) return 'item';
      // Not the port's `{ value, version }` shape: refused like any other bad value.
      if (typeof answer !== 'object' || !Object.hasOwn(answer, 'value')) {
        return checkJdProductKeyMode(undefined);
      }
      const value: unknown = (answer as { readonly value: unknown }).value;
      return value === null || value === undefined ? 'item' : checkJdProductKeyMode(value);
    },
  };
}

/**
 * B1-22q: the demo adapters' price.taobao.* settings over the configuration port (content's reader,
 * from app.module), read with ctx.appId on every mapping; invalid values warn through the root
 * logger. Before the port is built, or without a database, every key reads as missing (08
 * defaults, no warning).
 */
function taobaoPriceSettings(
  source: PriceConfigSource,
  logger: RootLogger,
): TaobaoPriceSettingsReader {
  return createTaobaoPriceSettings({
    config: {
      configValue: (appId, key) =>
        source.reader === undefined ? Promise.resolve(null) : source.reader.configValue(appId, key),
    },
    logger,
  });
}

/**
 * B1-04p: a live HTTPS transport (pdd; taobao since B1-04k, jd since B1-04ze, one per platform)
 * wrapped in the raw payload archive. The database is read from the same optional source per
 * request: without one the request goes straight through, no row and no log (startup and calls
 * stay as before B1-04p); with one every request is archived.
 */
function archivedTransport(
  inner: UnionTransport,
  source: QueryPidSource,
  clock: Clock,
  logger: RootLogger,
): UnionTransport {
  let archived: { readonly db: Kysely<Database>; readonly transport: UnionTransport } | undefined;
  return (request) => {
    const db = source.db;
    if (db === undefined) return inner(request);
    if (archived?.db !== db) {
      archived = { db, transport: createArchivingTransport(inner, { db, clock, logger }) };
    }
    return archived.transport(request);
  };
}

function queryRefused(reason: string): UnionError {
  return new UnionError('upstream_rejected', `pdd query identity: ${reason}`, 'pdd');
}

/**
 * The pdd goods ports' query identity (B1-04u D-u2, B1-04x): per call, the active pdd / query PID
 * of ctx.appId (read again every call; no other scene or app is ever used, BR-ATTR-08) and the
 * configured custom_parameters verbatim. Reads only ctx.appId. Any gap is `upstream_rejected`.
 * Several active candidates: the reader logs which one it chose (D10-427 ③).
 */
function pddQueryIdentity(
  source: QueryPidSource,
  customParameters: string | null | undefined,
  logger: RootLogger,
): (ctx: CallCtx) => Promise<PddQueryIdentity> {
  return async (ctx) => {
    if (customParameters == null || customParameters === '') {
      throw queryRefused(`${PDD_QUERY_CUSTOM_PARAMETERS_ENV} is not configured`);
    }
    const db = source.db;
    if (db === undefined) throw queryRefused('no database to read the query PID from');
    const pid = await readActivePddQueryPid(db, ctx.appId, logger);
    if (pid === null) throw queryRefused('no active query PID for this app');
    return { pid, customParameters };
  };
}

/**
 * The UNION_REGISTRY factory: only the passed config is read, never process.env. pdd live without
 * PDD_QUERY_CUSTOM_PARAMETERS still starts and warns once with only the variable name.
 */
async function startUnionRegistry(
  endpoints: readonly UnionEndpoint[],
  config: AppConfig,
  clock: Clock,
  logger: RootLogger,
  source: QueryPidSource,
  priceConfig: PriceConfigSource | undefined,
  searchCounter: TaobaoSearchCounter,
  ownOrders: UnionTaobaoOwnOrders | undefined,
): Promise<UnionRegistry> {
  const options = {
    endpoints,
    environment: config.appEnv,
    seed: UNION_DEMO_SEED,
    clock,
    warn: (warning: TaobaoPriceWarning) => logPriceWarning(logger, warning),
    ...(priceConfig === undefined
      ? {}
      : { taobaoPriceSettings: taobaoPriceSettings(priceConfig, logger) }),
  };
  const pdd = endpoints.find((endpoint) => endpoint.platform === 'pdd');
  const taobao = endpoints.find((endpoint) => endpoint.platform === 'taobao');
  const jd = endpoints.find((endpoint) => endpoint.platform === 'jd');
  let pddLive: PddLiveOptions | undefined;
  if (pdd?.mode === 'live') {
    // Refusals (environment, missing or unreadable credentials) throw PddStartupError: fixed text.
    const credentials = await openPddCredentials(config.appEnv, config.pdd, kmsAccessOf(config));
    const customParameters = config.pddQueryCustomParameters;
    if (customParameters == null || customParameters === '') {
      logger.warn(PDD_QUERY_CUSTOM_PARAMETERS_ENV);
    }
    pddLive = {
      credentials,
      transport: archivedTransport(createUnionHttpTransport(), source, clock, logger),
      warn: (warning: PddWarning) => logPddWarning(logger, warning),
      queryIdentity: pddQueryIdentity(source, customParameters, logger),
    };
  }
  let taobaoLive: TaobaoLiveOptions | undefined;
  // staging without either taobao variable (config.taobao null; only one set is a ConfigError of
  // loadConfig) keeps taobao `adapter_unimplemented`, and logs nothing: the frozen pdd wiring tests
  // run staging with taobao live, no taobao variable and an exact warn count.
  const taobaoUnconfigured =
    config.appEnv === 'staging' && (config.taobao === null || config.taobao === undefined);
  if (taobao?.mode === 'live' && !taobaoUnconfigured) {
    // Checked after pdd, so pdd's own refusals come first. local / test, prod without KMS configured
    // (B1-30a: prod reads the secret from KMS), a KMS read that fails and a staging secret file that
    // is unreadable or empty throw TaobaoStartupError (fixed text).
    const credentials = await openTaobaoCredentials(
      config.appEnv,
      config.taobao,
      kmsAccessOf(config),
    );
    // B1-04e: the 大淘客 order source only when configured (staging: both DATAOKE_* variables; prod:
    // DATAOKE_APP_KEY with KMS, B1-30a; loadConfig refuses them elsewhere); an unreadable or empty
    // secret (file or KMS) throws DataokeStartupError (fixed text). Not configured: no order source,
    // nothing logged.
    let orderSource: TaobaoOrderSourceOptions | undefined;
    if (config.dataoke !== null && config.dataoke !== undefined) {
      orderSource = {
        credentials: await openDataokeCredentials(
          config.appEnv,
          config.dataoke,
          kmsAccessOf(config),
        ),
        transport: archivedTransport(createUnionHttpTransport(), source, clock, logger),
        random: (bound) => randomInt(0, bound),
        baseUrl: DATAOKE_GATEWAY,
        warn: (warning: DataokeWarning) => logDataokeWarning(logger, warning),
      };
    }
    // B1-04zy: official_first without 大淘客 would quietly be official alone.
    if (config.taobaoSearchSource === 'official_first' && orderSource === undefined) {
      throw new UnionError(
        'invalid_endpoint',
        `${TAOBAO_SEARCH_SOURCE_ENV}=official_first needs the 大淘客 credentials`,
        'taobao',
      );
    }
    taobaoLive = {
      credentials,
      transport: archivedTransport(createUnionHttpTransport(), source, clock, logger),
      warn: (warning: TaobaoWarning) => logTaobaoWarning(logger, warning),
      // B1-04zn (D10-530): the two switches from the passed config (a hand-built config without
      // them counts as the defaults); the adapter only acts on 'dataoke' with an order source.
      convertSource: config.taobaoConvertSource ?? 'baichuan',
      searchSource: config.taobaoSearchSource ?? 'official',
      // B1-04zx: not tied to the order source; the official search needs only these two.
      searchSlot: taobaoSearchSlot(source),
      searchWarn: (warning: TaobaoSearchWarning) => logTaobaoSearchWarning(logger, warning),
      // B1-04zy: counted under every switch value; the hook only fires under official_first.
      searchCounter,
      fallbackWarn: (warning: TaobaoSearchFallbackWarning) =>
        logTaobaoSearchFallback(logger, warning),
      ...(orderSource === undefined
        ? {}
        : {
            orderSource,
            // The slot reader only with the order source; it needs the optional database per call.
            orderSlots: taobaoOrderSlots(source),
            orderWarn: (warning: TaobaoOrderWarning) => logTaobaoOrderWarning(logger, warning),
            // B1-04zzu: the refund archive keeps only 凑狸's stored orders (orders' read).
            ...(ownOrders === undefined ? {} : { ownOrders: taobaoOwnOrders(source, ownOrders) }),
          }),
    };
  }
  let jdLive: JdLiveOptions | undefined;
  // staging without either jd variable (config.jd null; only one set is a ConfigError of
  // loadConfig) keeps jd `adapter_unimplemented` like taobao, and logs nothing: the frozen pdd and
  // taobao wiring tests run staging with jd live, no jd variable and an exact warn count.
  const jdUnconfigured =
    config.appEnv === 'staging' && (config.jd === null || config.jd === undefined);
  if (jd?.mode === 'live' && !jdUnconfigured) {
    // Checked after taobao, so taobao's own refusals come first. local / test, prod without KMS
    // configured (B1-30a: prod reads the secret from KMS), a KMS read that fails and a staging secret
    // file that is unreadable or empty throw JdStartupError (fixed text).
    const credentials = await openJdCredentials(config.appEnv, config.jd, kmsAccessOf(config));
    jdLive = {
      credentials,
      transport: archivedTransport(createUnionHttpTransport(), source, clock, logger),
      warn: (warning: JdWarning) => logJdWarning(logger, warning),
      productKeyMode: jdProductKeyMode(priceConfig, logger),
      // B1-04zd (D10-500 ①): JD_SITE_ID is optional; without it the entry starts and convert is
      // refused `adapter_unimplemented`.
      ...(config.jdSiteId == null ? {} : { siteId: config.jdSiteId }),
    };
  }
  return createUnionRegistry({
    ...options,
    ...(pddLive === undefined ? {} : { pddLive }),
    ...(taobaoLive === undefined ? {} : { taobaoLive }),
    ...(jdLive === undefined ? {} : { jdLive }),
  });
}

/**
 * The UNION_ENDPOINTS factory (B1-04y): with UNION_ENDPOINT_OVERRIDE_DIR (staging only, validated
 * by loadConfig) the three endpoint files are read from that mounted directory, with the same
 * validation; a missing or invalid file there stops the entry (no fallback to the packaged
 * directory). Without it the module's directory is read. Each call reads its own config; nothing
 * is cached between configs.
 */
function startUnionEndpoints(
  directory: string,
  config: AppConfig,
): Promise<readonly UnionEndpoint[]> {
  const override = config.unionEndpointOverrideDir;
  if (override == null || override === '') return loadUnionEndpoints(directory, config.appEnv);
  if (config.appEnv !== 'staging') {
    // loadConfig refuses this already; a hand-built config must not reach another environment.
    return Promise.reject(
      new UnionError(
        'invalid_endpoint',
        `${UNION_ENDPOINT_OVERRIDE_DIR_ENV} is only accepted when APP_ENV=staging`,
      ),
    );
  }
  return loadUnionEndpoints(override, config.appEnv);
}

@Module({})
export class UnionModule {
  static forRoot(
    directory: string = UNION_ENDPOINTS_DIR,
    options: UnionModuleOptions = {},
  ): DynamicModule {
    // One source per module instance: the registry's query identity reads it lazily, per call.
    const source: QueryPidSource = { db: undefined };
    // Likewise the price configuration port (B1-22q), only when `config` is given.
    const buildConfig = options.config;
    const priceConfig: PriceConfigSource | undefined =
      buildConfig === undefined ? undefined : { reader: undefined };
    // B1-04zy: one counter per module instance, outside the UNION_REGISTRY factory's dependencies.
    const searchCounter = createTaobaoSearchCounter();
    return {
      module: UnionModule,
      providers: [
        {
          provide: UNION_ENDPOINTS,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => startUnionEndpoints(directory, config),
        },
        {
          provide: UNION_REGISTRY,
          inject: [UNION_ENDPOINTS, APP_CONFIG, CLOCK, ROOT_LOGGER],
          useFactory: (
            endpoints: readonly UnionEndpoint[],
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
          ) =>
            startUnionRegistry(
              endpoints,
              config,
              clock,
              logger,
              source,
              priceConfig,
              searchCounter,
              options.taobaoOwnOrders,
            ),
        },
        { provide: taobaoSearchCounterToken(), useValue: searchCounter },
        {
          provide: UNION_QUERY_PID_SOURCE,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>) => {
            source.db = db ?? undefined;
            return source;
          },
        },
        ...(buildConfig === undefined || priceConfig === undefined
          ? []
          : [
              {
                provide: UNION_TAOBAO_PRICE_CONFIG,
                inject: [{ token: DB, optional: true }, CLOCK],
                useFactory: (db: Kysely<Database> | undefined, clock: Clock) => {
                  priceConfig.reader = db == null ? undefined : buildConfig(db, clock);
                  return priceConfig;
                },
              },
            ]),
      ],
      exports: [UNION_ENDPOINTS, UNION_REGISTRY],
    };
  }
}
